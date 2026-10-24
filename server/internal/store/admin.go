package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Overview is the console dashboard payload.
type Overview struct {
	AgentsTotal        int        `json:"agents_total"`
	AgentsOnline       int        `json:"agents_online"`
	AgentsBanned       int        `json:"agents_banned"`
	NewAgents24h       int        `json:"new_agents_24h"`
	CreditsCirculating int64      `json:"credits_circulating"`
	Messages           int64      `json:"messages"`
	Traces             int64      `json:"traces"`
	EscrowsLocked      int64      `json:"escrows_locked"`
	EscrowCredits      int64      `json:"escrow_credits"`
	BeaconsActive      int64      `json:"beacons_active"`
	Attestations       int64      `json:"attestations"`
	TopTags            []TagCount `json:"top_tags"`
	ServerTime         int64      `json:"server_time"`
}

// TagCount is one row of the tag histogram.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// AdminAgent is an agent row plus operator-only fields.
type AdminAgent struct {
	Card
	Status           string `json:"status"`
	InteractionCount int64  `json:"interaction_count"`
	LastDrip         int64  `json:"last_drip"`
}

// AgentFilter narrows an admin agent listing.
type AgentFilter struct {
	Query  string
	Status string
	Limit  int
	Offset int
	Sort   string
}

// AgentPatch is a partial admin update; nil fields are left untouched.
type AgentPatch struct {
	DisplayName *string
	Bio         *string
	ModelTier   *string
	Reputation  *float64
	Credits     *int
	Status      *string
	IsNPC       *bool
}

// Overview aggregates the whole plane in one round trip.
func (s *Store) Overview(ctx context.Context) (Overview, error) {
	var o Overview
	err := s.pool.QueryRow(ctx, `
		select
			(select count(*) from agents),
			(select count(*) from agents where last_seen > now() - interval '45 seconds' and status = 'active'),
			(select count(*) from agents where status = 'banned'),
			(select count(*) from agents where created_at > now() - interval '24 hours'),
			(select coalesce(sum(credits), 0) from agents),
			(select count(*) from messages),
			(select count(*) from traces),
			(select count(*) from escrows where status = 'LOCKED'),
			(select coalesce(sum(amount), 0) from escrows where status = 'LOCKED'),
			(select count(*) from beacons where expires_at > now()),
			(select count(*) from attestations)
	`).Scan(&o.AgentsTotal, &o.AgentsOnline, &o.AgentsBanned, &o.NewAgents24h,
		&o.CreditsCirculating, &o.Messages, &o.Traces, &o.EscrowsLocked,
		&o.EscrowCredits, &o.BeaconsActive, &o.Attestations)
	if err != nil {
		return o, err
	}

	rows, err := s.pool.Query(ctx, `
		select tag, count(*) as n
		from (
			select unnest(capability_tags || intent_tags) as tag from agents
		) t
		where tag <> ''
		group by tag order by n desc, tag asc limit 12`)
	if err != nil {
		return o, err
	}
	defer rows.Close()
	for rows.Next() {
		var tc TagCount
		if err := rows.Scan(&tc.Tag, &tc.Count); err != nil {
			return o, err
		}
		o.TopTags = append(o.TopTags, tc)
	}
	o.ServerTime = time.Now().UnixMilli()
	return o, rows.Err()
}

// AdminListAgents returns a filtered, paginated listing.
func (s *Store) AdminListAgents(ctx context.Context, f AgentFilter) ([]AdminAgent, int, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	if f.Offset < 0 {
		f.Offset = 0
	}
	where := []string{"1 = 1"}
	args := []any{}
	if q := strings.TrimSpace(f.Query); q != "" {
		args = append(args, "%"+q+"%")
		where = append(where, fmt.Sprintf("(did ilike $%d or display_name ilike $%d or bio ilike $%d)", len(args), len(args), len(args)))
	}
	if f.Status != "" {
		args = append(args, f.Status)
		where = append(where, fmt.Sprintf("status = $%d", len(args)))
	}
	clause := strings.Join(where, " and ")

	var total int
	if err := s.pool.QueryRow(ctx, `select count(*) from agents where `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	order := "last_seen desc"
	switch f.Sort {
	case "reputation":
		order = "reputation desc"
	case "credits":
		order = "credits desc"
	case "created":
		order = "created_at desc"
	case "interactions":
		order = "interaction_count desc"
	}

	args = append(args, f.Limit, f.Offset)
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		select `+agentColumns+` from agents
		where %s order by %s limit $%d offset $%d`, clause, order, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := make([]AdminAgent, 0, f.Limit)
	now := time.Now()
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, AdminAgent{
			Card:             a.Card(now, PeerTTL),
			Status:           a.Status,
			InteractionCount: a.InteractionCount,
			LastDrip:         a.LastDrip.UnixMilli(),
		})
	}
	return out, total, rows.Err()
}

// AdminGetAgent loads one agent for the console.
func (s *Store) AdminGetAgent(ctx context.Context, did string) (AdminAgent, error) {
	a, err := s.GetAgent(ctx, did)
	if err != nil {
		return AdminAgent{}, err
	}
	return AdminAgent{
		Card:             a.Card(time.Now(), PeerTTL),
		Status:           a.Status,
		InteractionCount: a.InteractionCount,
		LastDrip:         a.LastDrip.UnixMilli(),
	}, nil
}

// AdminUpdateAgent applies a partial patch.
func (s *Store) AdminUpdateAgent(ctx context.Context, did string, p AgentPatch) (Agent, error) {
	agent, err := scanAgent(s.pool.QueryRow(ctx, `
		update agents set
			display_name = coalesce($2, display_name),
			bio          = coalesce($3, bio),
			model_tier   = coalesce($4, model_tier),
			reputation   = least(10, greatest(0.1, coalesce($5, reputation))),
			credits      = greatest(0, coalesce($6, credits)),
			status       = coalesce($7, status),
			is_npc       = coalesce($8, is_npc)
		where did = $1
		returning `+agentColumns,
		did, p.DisplayName, p.Bio, p.ModelTier, p.Reputation, p.Credits, p.Status, p.IsNPC))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrUnknownPeer
	}
	return agent, err
}

// AdminAdjustCredits moves credits and writes a ledger row.
func (s *Store) AdminAdjustCredits(ctx context.Context, did string, delta int, reason string) (Agent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)

	var balance int
	err = tx.QueryRow(ctx,
		`update agents set credits = greatest(0, credits + $2) where did = $1 returning credits`,
		did, delta).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrUnknownPeer
	}
	if err != nil {
		return Agent{}, err
	}
	if _, err := tx.Exec(ctx,
		`insert into credit_ledger (did, delta, balance_after, reason, ref) values ($1, $2, $3, $4, 'admin')`,
		did, delta, balance, reason); err != nil {
		return Agent{}, err
	}
	agent, err := scanAgent(tx.QueryRow(ctx, `select `+agentColumns+` from agents where did = $1`, did))
	if err != nil {
		return Agent{}, err
	}
	return agent, tx.Commit(ctx)
}

// AdminBan bans an agent until `until` (nil = permanent).
func (s *Store) AdminBan(ctx context.Context, did, reason string, until *time.Time) (Agent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)

	agent, err := scanAgent(tx.QueryRow(ctx, `
		update agents set status = 'banned' where did = $1 returning `+agentColumns, did))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrUnknownPeer
	}
	if err != nil {
		return Agent{}, err
	}
	if _, err := tx.Exec(ctx,
		`insert into bans (did, reason, until) values ($1, $2, $3)`, did, reason, until); err != nil {
		return Agent{}, err
	}
	return agent, tx.Commit(ctx)
}

// AdminUnban lifts every open ban.
func (s *Store) AdminUnban(ctx context.Context, did string) (Agent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)

	agent, err := scanAgent(tx.QueryRow(ctx, `
		update agents set status = 'active' where did = $1 returning `+agentColumns, did))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrUnknownPeer
	}
	if err != nil {
		return Agent{}, err
	}
	if _, err := tx.Exec(ctx,
		`update bans set lifted_at = now() where did = $1 and lifted_at is null`, did); err != nil {
		return Agent{}, err
	}
	return agent, tx.Commit(ctx)
}

// AdminDeleteAgent erases an agent and its mailbox.
func (s *Store) AdminDeleteAgent(ctx context.Context, did string) error {
	tag, err := s.pool.Exec(ctx, `delete from agents where did = $1`, did)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrUnknownPeer
	}
	return nil
}

// AdminMessages returns recent mailbox rows, optionally for one DID.
func (s *Store) AdminMessages(ctx context.Context, did string, limit int) ([]Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		select id, message_id, envelope, created_at from messages
		where ($1 = '' or recipient_did = $1)
		order by id desc limit $2`, did, limit)
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

// AdminTraces returns the most recently active traces.
func (s *Store) AdminTraces(ctx context.Context, limit int) ([]Trace, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		select trace_id, initiator, responder, primitives, turns, updated_at
		from traces order by updated_at desc limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Trace, 0, limit)
	for rows.Next() {
		var t Trace
		if err := rows.Scan(&t.TraceID, &t.Initiator, &t.Responder, &t.Primitives, &t.Turns, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// AdminEscrows lists escrows by status ("" = all).
func (s *Store) AdminEscrows(ctx context.Context, status string, limit int) ([]Escrow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		select trace_id, payer, payee, amount, status, created_at, expires_at
		from escrows where ($1 = '' or status = $1)
		order by created_at desc limit $2`, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Escrow, 0, limit)
	for rows.Next() {
		var e Escrow
		if err := rows.Scan(&e.TraceID, &e.Payer, &e.Payee, &e.Amount, &e.Status, &e.CreatedAt, &e.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AdminBeacons lists every live beacon.
func (s *Store) AdminBeacons(ctx context.Context, limit int) ([]Beacon, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return activeBeacons(ctx, s.pool, time.Now(), limit)
}

// AdminDeleteBeacon removes one broadcast.
func (s *Store) AdminDeleteBeacon(ctx context.Context, beaconID string) error {
	tag, err := s.pool.Exec(ctx, `delete from beacons where beacon_id = $1`, beaconID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrUnknownPeer
	}
	return nil
}

// AdminAttestations lists recent attestations.
func (s *Store) AdminAttestations(ctx context.Context, limit int) ([]AttestationRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		select from_did, to_did, capability_tag, verdict, weight, trace_id, created_at
		from attestations order by created_at desc limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AttestationRecord, 0, limit)
	for rows.Next() {
		var r AttestationRecord
		var at time.Time
		if err := rows.Scan(&r.From, &r.To, &r.Tag, &r.Verdict, &r.Weight, &r.Trace, &at); err != nil {
			return nil, err
		}
		r.At = at.UnixMilli()
		out = append(out, r)
	}
	return out, rows.Err()
}

// AuditEntry is one operator action.
type AuditEntry struct {
	ID     int64          `json:"id"`
	Actor  string         `json:"actor"`
	Action string         `json:"action"`
	Target string         `json:"target"`
	Detail map[string]any `json:"detail"`
	At     int64          `json:"at"`
}

// AdminAudit lists recent operator actions.
func (s *Store) AdminAudit(ctx context.Context, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		select id, actor, action, target, detail, created_at
		from admin_audit order by id desc limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AuditEntry, 0, limit)
	for rows.Next() {
		var e AuditEntry
		var at time.Time
		if err := rows.Scan(&e.ID, &e.Actor, &e.Action, &e.Target, &e.Detail, &at); err != nil {
			return nil, err
		}
		e.At = at.UnixMilli()
		out = append(out, e)
	}
	return out, rows.Err()
}

// Audit records an operator action.
func (s *Store) Audit(ctx context.Context, actor, action, target string, detail map[string]any) {
	if detail == nil {
		detail = map[string]any{}
	}
	body, err := json.Marshal(detail)
	if err != nil {
		body = []byte("{}")
	}
	_, _ = s.pool.Exec(ctx,
		`insert into admin_audit (actor, action, target, detail) values ($1, $2, $3, $4)`,
		actor, action, target, body)
}

// LedgerEntry is one credit movement.
type LedgerEntry struct {
	ID           int64  `json:"id"`
	Did          string `json:"did"`
	Delta        int    `json:"delta"`
	BalanceAfter int    `json:"balance_after"`
	Reason       string `json:"reason"`
	Ref          string `json:"ref"`
	At           int64  `json:"at"`
}

// AdminLedger lists credit movements, newest first.
func (s *Store) AdminLedger(ctx context.Context, did string, limit, offset int) ([]LedgerEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := s.pool.Query(ctx, `
		select id, did, delta, balance_after, reason, ref, created_at
		from credit_ledger where ($1 = '' or did = $1)
		order by id desc limit $2 offset $3`, did, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]LedgerEntry, 0, limit)
	for rows.Next() {
		var e LedgerEntry
		var at time.Time
		if err := rows.Scan(&e.ID, &e.Did, &e.Delta, &e.BalanceAfter, &e.Reason, &e.Ref, &at); err != nil {
			return nil, err
		}
		e.At = at.UnixMilli()
		out = append(out, e)
	}
	return out, rows.Err()
}

// Settings returns every runtime toggle.
func (s *Store) Settings(ctx context.Context) (map[string]any, error) {
	rows, err := s.pool.Query(ctx, `select key, value from settings order by key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]any{}
	for rows.Next() {
		var key string
		var raw []byte
		if err := rows.Scan(&key, &raw); err != nil {
			return nil, err
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, rows.Err()
}

// SettingBool reads one boolean toggle.
func (s *Store) SettingBool(ctx context.Context, key string, fallback bool) bool {
	var raw []byte
	if err := s.pool.QueryRow(ctx, `select value from settings where key = $1`, key).Scan(&raw); err != nil {
		return fallback
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		return fallback
	}
	return b
}

// UpdateSetting writes one toggle.
func (s *Store) UpdateSetting(ctx context.Context, key string, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		insert into settings (key, value, updated_at) values ($1, $2, now())
		on conflict (key) do update set value = excluded.value, updated_at = now()`, key, body)
	return err
}
