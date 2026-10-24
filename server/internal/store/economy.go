package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"cradle.local/server/internal/protocol"
)

// SendOutcome is the relay's answer for one envelope.
type SendOutcome struct {
	Delivered    int
	MessageID    string
	Charged      int
	ProbeResults []ScoredCard
	BeaconID     string
	Attestation  *AttestationRecord
	TraceID      string
}

// InsufficientCreditsError maps to HTTP 402.
type InsufficientCreditsError struct {
	Need int
	Have int
}

func (e *InsufficientCreditsError) Error() string {
	return fmt.Sprintf("insufficient credits: need %d, have %d", e.Need, e.Have)
}

// AttestRejectedError maps to HTTP 400 with a reason.
type AttestRejectedError struct{ Reason string }

func (e *AttestRejectedError) Error() string { return e.Reason }

// BannedError maps to HTTP 403.
type BannedError struct{ Reason string }

func (e *BannedError) Error() string { return e.Reason }

// Send verifies nothing (the API already did) and applies the economy: it
// prices the primitive, moves credits, updates traces and delivers the envelope.
func (s *Store) Send(ctx context.Context, env *protocol.Envelope) (*SendOutcome, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	sender, err := ensureAgentTx(ctx, tx, env.Sender.Did)
	if err != nil {
		return nil, err
	}
	recipient, err := ensureAgentTx(ctx, tx, env.Recipient.Did)
	if err != nil {
		return nil, err
	}
	sender, recipient, err = lockPair(ctx, tx, sender, recipient)
	if err != nil {
		return nil, err
	}
	if sender.Status == "banned" {
		return nil, &BannedError{Reason: "sender is banned"}
	}

	if err := observeTrace(ctx, tx, env); err != nil {
		return nil, err
	}

	out := &SendOutcome{MessageID: env.MessageID, TraceID: env.TraceID}
	slots := env.Payload.ControlSlots

	switch env.Primitive {
	case protocol.Probe:
		out.ProbeResults, err = probe(ctx, tx, env)
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return out, nil

	case protocol.Attest:
		out.Attestation, err = applyAttest(ctx, tx, sender, env)
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return out, nil

	case protocol.Beacon:
		if protocol.SlotsString(slots, "action") == "PUBLISH" {
			beaconID, charged, err := publishBeacon(ctx, tx, sender, env)
			if err != nil {
				return nil, err
			}
			out.BeaconID = beaconID
			out.Charged = charged
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return out, nil
		}
	}

	cost := protocol.Price(env.Primitive, slots)
	balance := sender.Credits
	if cost > 0 {
		balance, err = charge(ctx, tx, sender.Did, cost, "primitive:"+env.Primitive, env.MessageID)
		if err != nil {
			return nil, err
		}
	}

	if env.Primitive == protocol.Delegate && protocol.SlotsString(slots, "phase") == "ASSIGN" {
		if balance < DelegateEscrow {
			if cost > 0 {
				if _, err := credit(ctx, tx, sender.Did, cost, "refund:escrow", env.MessageID); err != nil {
					return nil, err
				}
			}
			return nil, &InsufficientCreditsError{Need: DelegateEscrow, Have: balance}
		}
		if _, err := charge(ctx, tx, sender.Did, DelegateEscrow, "escrow:lock", env.TraceID); err != nil {
			return nil, err
		}
		if err := lockEscrow(ctx, tx, env.TraceID, sender.Did, recipient.Did, DelegateEscrow, time.Now()); err != nil {
			return nil, err
		}
	}

	if env.Primitive == protocol.Delegate && protocol.SlotsString(slots, "phase") == "DELIVER" {
		// The worker (the escrow's payee) is paid, not the requester who happens
		// to be this envelope's recipient.
		if _, _, err := releaseEscrow(ctx, tx, env.TraceID, recipient.Did, 0, "escrow:release"); err != nil {
			return nil, err
		}
	}

	if env.TraceID != "" {
		if _, err := tx.Exec(ctx,
			`update traces set turns = turns + 1, updated_at = now() where trace_id = $1`, env.TraceID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx,
		`update agents set interaction_count = interaction_count + 1 where did = any($1::text[])`,
		[]string{env.Sender.Did, env.Recipient.Did}); err != nil {
		return nil, err
	}

	if err := deliver(ctx, tx, env, recipient.Did); err != nil {
		return nil, err
	}
	if env.Primitive == protocol.Introduce {
		for _, party := range []string{
			protocol.SlotsString(slots, "party_a_did"),
			protocol.SlotsString(slots, "party_b_did"),
		} {
			if protocol.IsDid(party) && party != recipient.Did {
				if err := deliver(ctx, tx, env, party); err != nil {
					return nil, err
				}
			}
		}
	}

	out.Delivered = 1
	out.Charged = cost
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func ensureAgentTx(ctx context.Context, tx pgx.Tx, did string) (Agent, error) {
	return scanAgent(tx.QueryRow(ctx, `
		insert into agents (did, display_name) values ($1, left($1, 20))
		on conflict (did) do update set did = excluded.did
		returning `+agentColumns, did))
}

// lockPair locks both agents in DID order so concurrent relays cannot deadlock.
func lockPair(ctx context.Context, tx pgx.Tx, a, b Agent) (Agent, Agent, error) {
	if a.Did == b.Did {
		locked, err := scanAgent(tx.QueryRow(ctx,
			`select `+agentColumns+` from agents where did = $1 for update`, a.Did))
		return locked, locked, err
	}
	first, second := a, b
	swap := false
	if a.Did > b.Did {
		first, second = b, a
		swap = true
	}
	lockedFirst, err := scanAgent(tx.QueryRow(ctx,
		`select `+agentColumns+` from agents where did = $1 for update`, first.Did))
	if err != nil {
		return Agent{}, Agent{}, err
	}
	lockedSecond, err := scanAgent(tx.QueryRow(ctx,
		`select `+agentColumns+` from agents where did = $1 for update`, second.Did))
	if err != nil {
		return Agent{}, Agent{}, err
	}
	if swap {
		return lockedSecond, lockedFirst, nil
	}
	return lockedFirst, lockedSecond, nil
}

func observeTrace(ctx context.Context, tx pgx.Tx, env *protocol.Envelope) error {
	if env.TraceID == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `
		insert into traces (trace_id, initiator, responder, primitives, turns, updated_at)
		values ($1, $2, $3, array[$4]::text[], 0, now())
		on conflict (trace_id) do update set
			primitives = case
				when $4 = any(traces.primitives) then traces.primitives
				else array_append(traces.primitives, $4)
			end,
			updated_at = now()`,
		env.TraceID, env.Sender.Did, env.Recipient.Did, env.Primitive)
	return err
}

func charge(ctx context.Context, tx pgx.Tx, did string, amount int, reason, ref string) (int, error) {
	if amount == 0 {
		var balance int
		err := tx.QueryRow(ctx, `select credits from agents where did = $1`, did).Scan(&balance)
		return balance, err
	}
	var balance int
	err := tx.QueryRow(ctx,
		`update agents set credits = credits - $2 where did = $1 and credits >= $2 returning credits`,
		did, amount).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		var have int
		_ = tx.QueryRow(ctx, `select credits from agents where did = $1`, did).Scan(&have)
		return have, &InsufficientCreditsError{Need: amount, Have: have}
	}
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx,
		`insert into credit_ledger (did, delta, balance_after, reason, ref) values ($1, $2, $3, $4, $5)`,
		did, -amount, balance, reason, ref); err != nil {
		return 0, err
	}
	return balance, nil
}

func credit(ctx context.Context, tx pgx.Tx, did string, amount int, reason, ref string) (int, error) {
	var balance int
	err := tx.QueryRow(ctx,
		`update agents set credits = credits + $2 where did = $1 returning credits`,
		did, amount).Scan(&balance)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx,
		`insert into credit_ledger (did, delta, balance_after, reason, ref) values ($1, $2, $3, $4, $5)`,
		did, amount, balance, reason, ref); err != nil {
		return 0, err
	}
	return balance, nil
}

func lockEscrow(ctx context.Context, tx pgx.Tx, traceID, payer, payee string, amount int, now time.Time) error {
	_, err := tx.Exec(ctx, `
		insert into escrows (trace_id, payer, payee, amount, status, created_at, expires_at)
		values ($1, $2, $3, $4, 'LOCKED', $5, $6)
		on conflict (trace_id) do update set
			payer = excluded.payer, payee = excluded.payee, amount = excluded.amount,
			status = 'LOCKED', created_at = excluded.created_at, expires_at = excluded.expires_at`,
		traceID, payer, payee, amount, now, now.Add(EscrowTTL))
	return err
}

func releaseEscrow(ctx context.Context, tx pgx.Tx, traceID, fallbackPayee string, bonus int, reason string) (int, string, error) {
	var amount int
	var payee string
	err := tx.QueryRow(ctx,
		`update escrows set status = 'RELEASED' where trace_id = $1 and status = 'LOCKED' returning amount, payee`,
		traceID).Scan(&amount, &payee)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fallbackPayee, nil
	}
	if err != nil {
		return 0, "", err
	}
	if payee == "" {
		payee = fallbackPayee
	}
	if _, err := credit(ctx, tx, payee, amount+bonus, reason, traceID); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx,
		`update agents set completed_tasks = completed_tasks + 1 where did = $1`, payee); err != nil {
		return 0, "", err
	}
	return amount, payee, nil
}

func publishBeacon(ctx context.Context, tx pgx.Tx, sender Agent, env *protocol.Envelope) (string, int, error) {
	slots := env.Payload.ControlSlots
	cost := protocol.Price(protocol.Beacon, slots)
	stake := protocol.SlotsInt(slots, "stake_credits", 5)
	need := cost
	if stake > need {
		need = stake
	}
	if sender.Credits < need {
		return "", 0, &InsufficientCreditsError{Need: need, Have: sender.Credits}
	}
	if _, err := charge(ctx, tx, sender.Did, need, "beacon:publish", env.MessageID); err != nil {
		return "", 0, err
	}
	ttl := protocol.SlotsInt(slots, "ttl_seconds", 3600)
	now := time.Now()
	slotsJSON, err := json.Marshal(slots)
	if err != nil {
		return "", 0, err
	}
	if _, err := tx.Exec(ctx, `
		insert into beacons (beacon_id, sender_did, sender_name, topic_tag, beacon_type,
		                     control_slots, free_text, staked_credits, expires_at, created_at)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		on conflict (beacon_id) do update set
			topic_tag = excluded.topic_tag, beacon_type = excluded.beacon_type,
			control_slots = excluded.control_slots, free_text = excluded.free_text,
			staked_credits = excluded.staked_credits, expires_at = excluded.expires_at`,
		env.MessageID, sender.Did, sender.DisplayName,
		protocol.SlotsString(slots, "topic_tag"), protocol.SlotsString(slots, "beacon_type"),
		slotsJSON, env.Payload.FreeText, stake,
		now.Add(time.Duration(ttl)*time.Second), now); err != nil {
		return "", 0, err
	}
	return env.MessageID, need, nil
}

func applyAttest(ctx context.Context, tx pgx.Tx, sender Agent, env *protocol.Envelope) (*AttestationRecord, error) {
	slots := env.Payload.ControlSlots
	targetDID := protocol.SlotsString(slots, "target_did")
	if targetDID == sender.Did {
		return nil, &AttestRejectedError{Reason: "cannot attest yourself"}
	}
	if _, err := ensureAgentTx(ctx, tx, targetDID); err != nil {
		return nil, err
	}

	traceID := protocol.SlotsString(slots, "evidence_trace_id")
	var initiator, responder string
	var turns int
	var updated time.Time
	err := tx.QueryRow(ctx,
		`select initiator, responder, turns, updated_at from traces where trace_id = $1`, traceID).
		Scan(&initiator, &responder, &turns, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &AttestRejectedError{Reason: "unknown evidence_trace_id"}
	}
	if err != nil {
		return nil, err
	}
	if time.Since(updated) > TraceTTL {
		return nil, &AttestRejectedError{Reason: "evidence trace expired"}
	}
	party := (initiator == sender.Did && responder == targetDID) ||
		(initiator == targetDID && responder == sender.Did)
	if !party {
		return nil, &AttestRejectedError{Reason: "attestor is not a party to the trace"}
	}
	if turns < 1 {
		return nil, &AttestRejectedError{Reason: "trace has no completed interaction"}
	}

	var prior int
	if err := tx.QueryRow(ctx,
		`select count(*) from attestations where from_did = $1 and to_did = $2`,
		sender.Did, targetDID).Scan(&prior); err != nil {
		return nil, err
	}

	signed := 0
	switch protocol.SlotsString(slots, "verdict") {
	case "POSITIVE":
		signed = 1
	case "NEGATIVE":
		signed = -1
	}
	weight := float64(signed) * math.Tanh(sender.Reputation/2) / math.Pow(2, float64(prior))
	tag := protocol.SlotsString(slots, "capability_tag")
	now := time.Now()

	if _, err := tx.Exec(ctx, `
		insert into attestations (from_did, to_did, trace_id, capability_tag, verdict, weight, created_at)
		values ($1, $2, $3, $4, $5, $6, $7)
		on conflict (from_did, to_did, trace_id) do update set
			capability_tag = excluded.capability_tag, verdict = excluded.verdict,
			weight = excluded.weight, created_at = excluded.created_at`,
		sender.Did, targetDID, traceID, tag, signed, weight, now); err != nil {
		return nil, err
	}

	var reputation float64
	if err := tx.QueryRow(ctx, `
		update agents set reputation = least(10, greatest(0.1, reputation + $2))
		where did = $1 returning reputation`, targetDID, weight).Scan(&reputation); err != nil {
		return nil, err
	}

	if signed > 0 {
		if _, _, err := releaseEscrow(ctx, tx, traceID, targetDID, AttestBonus, "attest:bonus"); err != nil {
			return nil, err
		}
	}

	return &AttestationRecord{
		From:    sender.Did,
		To:      targetDID,
		Tag:     tag,
		Verdict: signed,
		Weight:  math.Round(weight*10000) / 10000,
		Trace:   traceID,
		At:      now.UnixMilli(),
	}, nil
}

const probeSQL = `
with wanted as (
	select distinct lower(t) as tag from unnest($5::text[]) as t
), scored as (
	select a.did, a.display_name, a.bio, a.model_tier, a.capability_tags, a.intent_tags,
	       a.reputation, a.credits, a.completed_tasks, a.is_npc, a.last_seen, a.created_at,
	       a.interaction_count,
	       case when $6 = 0 then 0
	            else (select count(*)::float8 from wanted w
	                  where w.tag = any (select lower(x) from unnest(a.capability_tags || a.intent_tags) as x)) / $6::float8
	       end as overlap,
	       case when $7 = '' then 0
	            when position(lower($7) in lower(a.bio)) > 0 then 0.3
	            else 0 end as text_hit,
	       case when a.last_seen > $4 then 1 else 0 end as online
	from agents a
	where a.did <> $1
	  and a.status = 'active'
	  and a.reputation >= $2
	  and ($3 = false or a.last_seen > $4)
)
select did, display_name, bio, model_tier, capability_tags, intent_tags, reputation, credits,
       completed_tasks, is_npc, last_seen, created_at, interaction_count,
       0.45 * least(1, overlap + text_hit) + 0.25 * overlap
         + 0.2 * least(1, reputation / 10.0) + 0.1 * online as score
from scored
order by score desc, reputation desc
limit 200`

type probeCandidate struct {
	card  ScoredCard
	isNew bool
}

func probe(ctx context.Context, q querier, env *protocol.Envelope) ([]ScoredCard, error) {
	slots := env.Payload.ControlSlots
	tags := protocol.SlotsStrings(slots, "tags")
	limit := protocol.SlotsInt(slots, "limit", 10)
	if limit < 1 {
		limit = 1
	}
	if limit > 20 {
		limit = 20
	}
	minReputation := protocol.SlotsNumber(slots, "min_reputation", 0)
	onlineOnly := protocol.SlotsBool(slots, "online_only", false)
	freeText := env.Payload.FreeText
	now := time.Now()

	rows, err := q.Query(ctx, probeSQL,
		env.Sender.Did, minReputation, onlineOnly, now.Add(-PeerTTL), tags, len(tags), freeText)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	candidates := make([]probeCandidate, 0, 32)
	for rows.Next() {
		var c probeCandidate
		var createdAt, lastSeen time.Time
		var interactionCount int64
		if err := rows.Scan(
			&c.card.Did, &c.card.DisplayName, &c.card.Bio, &c.card.ModelTier,
			&c.card.CapabilityTags, &c.card.IntentTags, &c.card.Reputation, &c.card.Credits,
			&c.card.CompletedTasks, &c.card.IsNPC, &lastSeen, &createdAt,
			&interactionCount, &c.card.Score,
		); err != nil {
			return nil, err
		}
		c.card.CreatedAt = createdAt.UnixMilli()
		c.card.LastSeen = lastSeen.UnixMilli()
		c.card.Online = now.Sub(lastSeen) < PeerTTL
		c.card.Reputation = round3(c.card.Reputation)
		c.card.Score = math.Round(c.card.Score*10000) / 10000
		c.isNew = now.Sub(createdAt) < NewNodeWindow || interactionCount < 5
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if protocol.SlotsString(slots, "mode") == "INSPECT" && len(tags) == 0 && freeText == "" {
		return topCards(candidates, limit), nil
	}

	exploreCount := int(math.Round(float64(limit) * ExplorationEpsilon))
	if exploreCount > len(candidates) {
		exploreCount = len(candidates)
	}
	fresh := make([]probeCandidate, 0, len(candidates))
	exploited := make([]probeCandidate, 0, len(candidates))
	for _, c := range candidates {
		if c.isNew && c.card.Score > 0.1 {
			fresh = append(fresh, c)
		} else {
			exploited = append(exploited, c)
		}
	}
	if exploreCount > len(fresh) {
		exploreCount = len(fresh)
	}
	picked := append(append([]probeCandidate{}, fresh[:exploreCount]...), exploited...)
	if len(picked) > limit {
		picked = picked[:limit]
	}
	return topCards(picked, len(picked)), nil
}

func topCards(candidates []probeCandidate, limit int) []ScoredCard {
	if limit > len(candidates) {
		limit = len(candidates)
	}
	out := make([]ScoredCard, 0, limit)
	for _, c := range candidates[:limit] {
		out = append(out, c.card)
	}
	return out
}

func deliver(ctx context.Context, tx pgx.Tx, env *protocol.Envelope, recipient string) error {
	body, err := json.Marshal(env.Raw)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`insert into messages (recipient_did, message_id, envelope) values ($1, $2, $3)`,
		recipient, env.MessageID, body); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		delete from messages
		where recipient_did = $1
		  and id not in (select id from messages where recipient_did = $1 order by id desc limit $2)`,
		recipient, MailboxMax)
	return err
}
