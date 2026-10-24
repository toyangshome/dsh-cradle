package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

// Economy constants. They mirror server/cradle-server.mjs so the two
// implementations price the same behaviour identically.
const (
	InitialCredits       = 50
	CreditsPerReputation = 100
	DripCoefficient      = 5
	PeerTTL              = 45 * time.Second
	MailboxMax           = 100
	TraceTTL             = 24 * time.Hour
	ExplorationEpsilon   = 0.2
	DelegateEscrow       = 10
	AttestBonus          = 2
	NewNodeWindow        = 72 * time.Hour
	EscrowTTL            = 24 * time.Hour
)

// ErrUnknownPeer means the DID never registered (or already left).
var ErrUnknownPeer = errors.New("unknown-peer")

// RegisterInput carries the mutable half of an agent card.
type RegisterInput struct {
	Did            string
	DisplayName    string
	Bio            string
	ModelTier      string
	CapabilityTags []string
	IntentTags     []string
}

// HeartbeatResult is everything one heartbeat returns.
type HeartbeatResult struct {
	Self     Agent
	Peers    []Agent
	Beacons  []Beacon
	Messages []Message
}

// Register creates or refreshes an agent card and returns the stored record.
func (s *Store) Register(ctx context.Context, in RegisterInput) (Agent, error) {
	const q = `
		insert into agents (did, display_name, bio, model_tier, capability_tags, intent_tags)
		values (
			$1,
			case when $2 = '' then left($1, 20) else $2 end,
			$3,
			coalesce(nullif($4, ''), 'MEDIUM_32B'),
			$5, $6
		)
		on conflict (did) do update set
			display_name  = case when $2 = '' then agents.display_name else $2 end,
			bio           = case when $3 = '' then agents.bio else $3 end,
			model_tier    = case when $4 = '' then agents.model_tier else $4 end,
			capability_tags = $5,
			intent_tags     = $6,
			last_seen     = now()
		returning ` + agentColumns

	row := s.pool.QueryRow(ctx, q, in.Did, in.DisplayName, in.Bio, in.ModelTier, in.CapabilityTags, in.IntentTags)
	return scanAgent(row)
}

// Heartbeat refreshes presence, applies the hourly UBI drip and returns the
// delta the plugin needs: peers, beacons and mailbox entries since `since`.
func (s *Store) Heartbeat(ctx context.Context, did string, since int64) (HeartbeatResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return HeartbeatResult{}, err
	}
	defer tx.Rollback(ctx)

	var self Agent
	self, err = scanAgent(tx.QueryRow(ctx,
		`select `+agentColumns+` from agents where did = $1 for update`, did))
	if errors.Is(err, pgx.ErrNoRows) {
		return HeartbeatResult{}, ErrUnknownPeer
	}
	if err != nil {
		return HeartbeatResult{}, err
	}

	now := time.Now()
	drip(&self, now)

	if _, err := tx.Exec(ctx,
		`update agents set last_seen = $2, credits = $3, last_drip = $4 where did = $1`,
		did, now, self.Credits, self.LastDrip); err != nil {
		return HeartbeatResult{}, err
	}
	self.LastSeen = now

	peers, err := peers(ctx, tx, did, now.Add(-PeerTTL))
	if err != nil {
		return HeartbeatResult{}, err
	}
	beacons, err := activeBeacons(ctx, tx, now, 20)
	if err != nil {
		return HeartbeatResult{}, err
	}
	messages, err := messagesSince(ctx, tx, did, since, 20)
	if err != nil {
		return HeartbeatResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return HeartbeatResult{}, err
	}
	return HeartbeatResult{Self: self, Peers: peers, Beacons: beacons, Messages: messages}, nil
}

// Leave removes an agent and its mailbox. Traces and escrows are kept for the
// audit trail; the admin console can inspect them.
func (s *Store) Leave(ctx context.Context, did string) error {
	_, err := s.pool.Exec(ctx, `delete from agents where did = $1`, did)
	return err
}

// Peers returns the agents currently inside the presence window.
func (s *Store) Peers(ctx context.Context, did string) ([]Agent, error) {
	return peers(ctx, s.pool, did, time.Now().Add(-PeerTTL))
}

// CountAgents returns the total number of registered agents.
func (s *Store) CountAgents(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `select count(*) from agents`).Scan(&n)
	return n, err
}

// ListAgents returns every known agent, newest first.
func (s *Store) ListAgents(ctx context.Context) ([]Agent, error) {
	rows, err := s.pool.Query(ctx,
		`select `+agentColumns+` from agents order by last_seen desc limit 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectAgents(rows)
}

// GetAgent loads one agent.
func (s *Store) GetAgent(ctx context.Context, did string) (Agent, error) {
	agent, err := scanAgent(s.pool.QueryRow(ctx,
		`select `+agentColumns+` from agents where did = $1`, did))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrUnknownPeer
	}
	return agent, err
}

// EnsureAgent creates the birth record for an unseen DID, exactly like the
// reference server's requireAgent().
func (s *Store) EnsureAgent(ctx context.Context, did string) (Agent, error) {
	agent, err := scanAgent(s.pool.QueryRow(ctx, `
		insert into agents (did, display_name) values ($1, left($1, 20))
		on conflict (did) do update set did = excluded.did
		returning `+agentColumns, did))
	if err != nil {
		return Agent{}, fmt.Errorf("ensure agent: %w", err)
	}
	return agent, nil
}

func drip(a *Agent, now time.Time) {
	hours := int(now.Sub(a.LastDrip) / time.Hour)
	if hours <= 0 {
		return
	}
	ceiling := int(math.Round(CreditsPerReputation * a.Reputation))
	gain := hours * int(math.Floor(DripCoefficient*math.Sqrt(a.Reputation)))
	if room := ceiling - a.Credits; gain > room {
		gain = room
	}
	if gain > 0 {
		a.Credits += gain
	}
	a.LastDrip = now
}

func peers(ctx context.Context, q querier, selfDID string, cutoff time.Time) ([]Agent, error) {
	rows, err := q.Query(ctx,
		`select `+agentColumns+` from agents
		 where did <> $1 and status = 'active' and last_seen > $2
		 order by last_seen desc limit 200`, selfDID, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectAgents(rows)
}

func activeBeacons(ctx context.Context, q querier, now time.Time, limit int) ([]Beacon, error) {
	rows, err := q.Query(ctx, `
		select beacon_id, sender_did, sender_name, topic_tag, beacon_type,
		       control_slots, free_text, staked_credits, expires_at, created_at
		from beacons where expires_at > $1
		order by created_at desc limit $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Beacon, 0, limit)
	for rows.Next() {
		var b Beacon
		if err := rows.Scan(&b.BeaconID, &b.SenderDID, &b.SenderName, &b.TopicTag, &b.BeaconType,
			&b.ControlSlots, &b.FreeText, &b.StakedCredits, &b.ExpiresAt, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func messagesSince(ctx context.Context, q querier, did string, since int64, limit int) ([]Message, error) {
	rows, err := q.Query(ctx, `
		select id, message_id, envelope, created_at
		from messages
		where recipient_did = $1
		  and coalesce((envelope->>'timestamp')::bigint, 0) > $2
		order by id asc limit $3`, did, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Message, 0, limit)
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.MessageID, &m.Envelope, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func collectAgents(rows pgx.Rows) ([]Agent, error) {
	out := make([]Agent, 0, 16)
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// querier is the subset of pgx shared by *pgxpool.Pool and pgx.Tx.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}
