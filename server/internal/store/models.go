package store

import (
	"time"

	"github.com/jackc/pgx/v5"
)

// Agent is the durable server-side record for one sovereign identity.
type Agent struct {
	Did              string
	DisplayName      string
	Bio              string
	ModelTier        string
	CapabilityTags   []string
	IntentTags       []string
	Reputation       float64
	Credits          int
	CompletedTasks   int
	IsNPC            bool
	Status           string
	LastSeen         time.Time
	CreatedAt        time.Time
	LastDrip         time.Time
	InteractionCount int64
}

// Card is the public projection of an agent, wire-compatible with the plugin's
// `publicCard()`.
type Card struct {
	Did            string   `json:"did"`
	DisplayName    string   `json:"display_name"`
	Bio            string   `json:"bio"`
	ModelTier      string   `json:"model_tier"`
	CapabilityTags []string `json:"capability_tags"`
	IntentTags     []string `json:"intent_tags"`
	Reputation     float64  `json:"reputation"`
	Credits        int      `json:"credits"`
	CompletedTasks int      `json:"completed_tasks"`
	IsNPC          bool     `json:"is_npc"`
	Online         bool     `json:"online"`
	LastSeen       int64    `json:"last_seen"`
	CreatedAt      int64    `json:"created_at"`
}

// Card projects an agent for the wire.
func (a Agent) Card(now time.Time, peerTTL time.Duration) Card {
	caps := a.CapabilityTags
	if caps == nil {
		caps = []string{}
	}
	intents := a.IntentTags
	if intents == nil {
		intents = []string{}
	}
	return Card{
		Did:            a.Did,
		DisplayName:    a.DisplayName,
		Bio:            a.Bio,
		ModelTier:      a.ModelTier,
		CapabilityTags: caps,
		IntentTags:     intents,
		Reputation:     round3(a.Reputation),
		Credits:        a.Credits,
		CompletedTasks: a.CompletedTasks,
		IsNPC:          a.IsNPC,
		Online:         now.Sub(a.LastSeen) < peerTTL,
		LastSeen:       a.LastSeen.UnixMilli(),
		CreatedAt:      a.CreatedAt.UnixMilli(),
	}
}

// ScoredCard is a probe hit with its hybrid score.
type ScoredCard struct {
	Card
	Score float64 `json:"score"`
}

// Beacon is a public-square broadcast.
type Beacon struct {
	BeaconID      string
	SenderDID     string
	SenderName    string
	TopicTag      string
	BeaconType    string
	ControlSlots  map[string]any
	FreeText      string
	StakedCredits int
	ExpiresAt     time.Time
	CreatedAt     time.Time
}

// BeaconDTO is the wire form of a beacon.
type BeaconDTO struct {
	BeaconID      string         `json:"beacon_id"`
	SenderDID     string         `json:"sender_did"`
	SenderName    string         `json:"sender_name"`
	TopicTag      string         `json:"topic_tag"`
	BeaconType    string         `json:"beacon_type"`
	ControlSlots  map[string]any `json:"control_slots"`
	FreeText      string         `json:"free_text"`
	StakedCredits int            `json:"staked_credits"`
	ExpiresAt     int64          `json:"expires_at"`
	CreatedAt     int64          `json:"created_at"`
}

// DTO converts a beacon to its wire form.
func (b Beacon) DTO() BeaconDTO {
	slots := b.ControlSlots
	if slots == nil {
		slots = map[string]any{}
	}
	return BeaconDTO{
		BeaconID:      b.BeaconID,
		SenderDID:     b.SenderDID,
		SenderName:    b.SenderName,
		TopicTag:      b.TopicTag,
		BeaconType:    b.BeaconType,
		ControlSlots:  slots,
		FreeText:      b.FreeText,
		StakedCredits: b.StakedCredits,
		ExpiresAt:     b.ExpiresAt.UnixMilli(),
		CreatedAt:     b.CreatedAt.UnixMilli(),
	}
}

// Message is one relayed envelope in a mailbox.
type Message struct {
	ID        int64
	MessageID string
	Envelope  map[string]any
	CreatedAt time.Time
}

// AttestationRecord is the wire form of one reputation attestation.
type AttestationRecord struct {
	From    string  `json:"from"`
	To      string  `json:"to"`
	Tag     string  `json:"tag"`
	Verdict int     `json:"verdict"`
	Weight  float64 `json:"weight"`
	Trace   string  `json:"trace"`
	At      int64   `json:"at"`
}

// Trace is one interaction thread observed by the relay.
type Trace struct {
	TraceID    string    `json:"trace_id"`
	Initiator  string    `json:"initiator"`
	Responder  string    `json:"responder"`
	Primitives []string  `json:"primitives"`
	Turns      int       `json:"turns"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Escrow is a frozen credit reservation.
type Escrow struct {
	TraceID   string    `json:"trace_id"`
	Payer     string    `json:"payer"`
	Payee     string    `json:"payee"`
	Amount    int       `json:"amount"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

const agentColumns = `did, display_name, bio, model_tier, capability_tags, intent_tags,
	reputation, credits, completed_tasks, is_npc, status, last_seen, created_at, last_drip, interaction_count`

func scanAgent(row pgx.Row) (Agent, error) {
	var a Agent
	err := row.Scan(
		&a.Did, &a.DisplayName, &a.Bio, &a.ModelTier, &a.CapabilityTags, &a.IntentTags,
		&a.Reputation, &a.Credits, &a.CompletedTasks, &a.IsNPC, &a.Status,
		&a.LastSeen, &a.CreatedAt, &a.LastDrip, &a.InteractionCount,
	)
	return a, err
}

func round3(v float64) float64 {
	return float64(int64(v*1000+0.5)) / 1000
}
