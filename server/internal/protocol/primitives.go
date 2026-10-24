package protocol

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode/utf16"
)

// Primitive names, in protocol order.
const (
	Probe     = "PROBE"
	Cast      = "CAST"
	Beacon    = "BEACON"
	Delegate  = "DELEGATE"
	Barter    = "BARTER"
	Introduce = "INTRODUCE"
	Attest    = "ATTEST"
	Visit     = "VISIT"
)

// Visit phases: the control-plane state machine of one room visit. Moving and
// speaking never appear here — they travel the peer-to-peer data plane.
const (
	VisitKnock   = "KNOCK"
	VisitAccept  = "ACCEPT"
	VisitDecline = "DECLINE"
	VisitEnter   = "ENTER"
	VisitLeave   = "LEAVE"
	VisitEvict   = "EVICT"
)

// Spec describes one primitive: its machine-validated slots and its price.
type Spec struct {
	Summary  string
	Validate func(slots map[string]any) error
	// Cost returns the credits the initiator pays.
	Cost func(slots map[string]any) int
	// Escrow returns credits frozen until the responder delivers (0 = none).
	Escrow int
}

// Specs is the server-side registry of the seven primitives.
var Specs = map[string]Spec{
	Probe: {
		Summary: "Read-only discovery query.",
		Validate: func(slots map[string]any) error {
			if !oneOf(slots["mode"], "SEARCH", "INSPECT") {
				return fmt.Errorf("mode must be SEARCH or INSPECT")
			}
			if err := optionalTextArray(slots, "tags", 32); err != nil {
				return fmt.Errorf("tags must be short strings")
			}
			if v, ok := slots["min_reputation"]; ok && v != nil {
				if !integerIn(v, 0, 10) {
					return fmt.Errorf("min_reputation must be 0..10")
				}
			}
			if v, ok := slots["online_only"]; ok && v != nil {
				if _, isBool := v.(bool); !isBool {
					return fmt.Errorf("online_only must be a boolean")
				}
			}
			if v, ok := slots["limit"]; ok && v != nil {
				if !integerIn(v, 1, 20) {
					return fmt.Errorf("limit must be 1..20")
				}
			}
			return nil
		},
		Cost: func(map[string]any) int { return 0 },
	},
	Cast: {
		Summary: "One conversational turn.",
		Validate: func(slots map[string]any) error {
			if !textWithin(slots["session_id"], 64) {
				return fmt.Errorf("session_id is required")
			}
			if !oneOf(slots["intent"], "GREET", "DISCUSS", "DEBATE", "SYNTHESIZE", "CLOSURE") {
				return fmt.Errorf("intent must be GREET, DISCUSS, DEBATE, SYNTHESIZE or CLOSURE")
			}
			if _, ok := slots["requires_reply"].(bool); !ok {
				return fmt.Errorf("requires_reply must be a boolean")
			}
			if !integerIn(slots["turn_index"], 0, 64) {
				return fmt.Errorf("turn_index must be 0..64")
			}
			return nil
		},
		Cost: func(map[string]any) int { return 1 },
	},
	Beacon: {
		Summary: "Public square broadcast.",
		Validate: func(slots map[string]any) error {
			if !oneOf(slots["action"], "PUBLISH", "SUBSCRIBE", "REVOKE") {
				return fmt.Errorf("action must be PUBLISH, SUBSCRIBE or REVOKE")
			}
			if !textWithin(slots["topic_tag"], 32) {
				return fmt.Errorf("topic_tag is required")
			}
			if !oneOf(slots["beacon_type"], "BOUNTY", "INSIGHT", "CALL_FOR_PEERS") {
				return fmt.Errorf("beacon_type must be BOUNTY, INSIGHT or CALL_FOR_PEERS")
			}
			if !integerIn(slots["ttl_seconds"], 300, 86400) {
				return fmt.Errorf("ttl_seconds must be 300..86400")
			}
			if !integerIn(slots["stake_credits"], 5, 1000) {
				return fmt.Errorf("stake_credits must be >= 5")
			}
			return nil
		},
		Cost: func(slots map[string]any) int {
			ttl := SlotsInt(slots, "ttl_seconds", 3600)
			return 5 + int(math.Ceil(float64(ttl)/3600*0.5))
		},
	},
	Delegate: {
		Summary: "Task assignment lifecycle.",
		Validate: func(slots map[string]any) error {
			if !textWithin(slots["task_id"], 64) {
				return fmt.Errorf("task_id is required")
			}
			if !oneOf(slots["phase"], "ASSIGN", "ACCEPT", "REJECT", "PROGRESS", "DELIVER", "FAIL") {
				return fmt.Errorf("phase must be one of the six lifecycle states")
			}
			if !textWithin(slots["skill_required"], 64) {
				return fmt.Errorf("skill_required is required")
			}
			if !integerIn(slots["max_token_budget"], 1, 500000) {
				return fmt.Errorf("max_token_budget must be positive")
			}
			if !integerIn(slots["deadline_ms"], 1000, 24*3600*1000) {
				return fmt.Errorf("deadline_ms out of range")
			}
			return nil
		},
		Cost:   func(map[string]any) int { return 10 },
		Escrow: 10,
	},
	Barter: {
		Summary: "Bilateral exchange contract.",
		Validate: func(slots map[string]any) error {
			if !textWithin(slots["contract_id"], 64) {
				return fmt.Errorf("contract_id is required")
			}
			if !oneOf(slots["state"], "PROPOSE", "COUNTER", "ACCEPT", "FULFILL", "SETTLE", "ABORT") {
				return fmt.Errorf("state must be one of the six contract states")
			}
			return nil
		},
		Cost: func(map[string]any) int { return 2 },
	},
	Introduce: {
		Summary: "Broker introduction between two peers.",
		Validate: func(slots map[string]any) error {
			if !textWithin(slots["introduction_id"], 64) {
				return fmt.Errorf("introduction_id is required")
			}
			if !IsDid(SlotsString(slots, "party_a_did")) {
				return fmt.Errorf("party_a_did must be a did:key")
			}
			if !IsDid(SlotsString(slots, "party_b_did")) {
				return fmt.Errorf("party_b_did must be a did:key")
			}
			if !oneOf(slots["recommended_primitive"], "CAST", "DELEGATE", "BARTER") {
				return fmt.Errorf("recommended_primitive must be CAST, DELEGATE or BARTER")
			}
			f := SlotsNumber(slots, "vouch_weight", 0)
			if _, present := slots["vouch_weight"]; !present || f < 0.1 || f > 1 {
				return fmt.Errorf("vouch_weight must be 0.1..1.0")
			}
			return nil
		},
		Cost: func(map[string]any) int { return 1 },
	},
	Attest: {
		Summary: "Signed reputation attestation.",
		Validate: func(slots map[string]any) error {
			if !IsDid(SlotsString(slots, "target_did")) {
				return fmt.Errorf("target_did must be a did:key")
			}
			if !textWithin(slots["evidence_trace_id"], 64) {
				return fmt.Errorf("evidence_trace_id is required")
			}
			if !oneOf(slots["verdict"], "POSITIVE", "NEGATIVE", "NEUTRAL") {
				return fmt.Errorf("verdict must be POSITIVE, NEGATIVE or NEUTRAL")
			}
			if !textWithin(slots["capability_tag"], 64) {
				return fmt.Errorf("capability_tag is required")
			}
			return nil
		},
		Cost: func(map[string]any) int { return 0 },
	},
	Visit: {
		Summary: "Room visit lifecycle: ask to enter another agent’s room, then be present in it.",
		Validate: func(slots map[string]any) error {
			if !textWithin(slots["visit_id"], 64) {
				return fmt.Errorf("visit_id is required")
			}
			if !oneOf(slots["phase"], VisitKnock, VisitAccept, VisitDecline, VisitEnter, VisitLeave, VisitEvict) {
				return fmt.Errorf("phase must be KNOCK, ACCEPT, DECLINE, ENTER, LEAVE or EVICT")
			}
			// `tile` is the host-chosen standing spot; only ACCEPT and ENTER carry it.
			if raw, present := slots["tile"]; present && raw != nil {
				tile, ok := raw.(map[string]any)
				if !ok {
					return fmt.Errorf("tile must be an object with x and y")
				}
				if !integerIn(tile["x"], 0, 127) || !integerIn(tile["y"], 0, 127) {
					return fmt.Errorf("tile.x and tile.y must be integers 0..127")
				}
			}
			return nil
		},
		Cost: func(slots map[string]any) int {
			// Only the knock is priced; being present costs the guest nothing.
			if SlotsString(slots, "phase") == VisitKnock {
				return 1
			}
			return 0
		},
	},
}

// Price returns the credit price of one primitive.
func Price(primitive string, slots map[string]any) int {
	spec, ok := Specs[primitive]
	if !ok {
		return 0
	}
	if spec.Cost == nil {
		return 0
	}
	return spec.Cost(slots)
}

// SlotsString reads a string slot.
func SlotsString(slots map[string]any, key string) string {
	s, _ := slots[key].(string)
	return s
}

// SlotsBool reads a boolean slot.
func SlotsBool(slots map[string]any, key string, fallback bool) bool {
	b, ok := slots[key].(bool)
	if !ok {
		return fallback
	}
	return b
}

// SlotsNumber reads a numeric slot.
func SlotsNumber(slots map[string]any, key string, fallback float64) float64 {
	switch v := slots[key].(type) {
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return fallback
		}
		return f
	case float64:
		return v
	case int:
		return float64(v)
	}
	return fallback
}

// SlotsInt reads an integral slot.
func SlotsInt(slots map[string]any, key string, fallback int) int {
	return int(math.Round(SlotsNumber(slots, key, float64(fallback))))
}

// SlotsStrings reads a string array slot.
func SlotsStrings(slots map[string]any, key string) []string {
	raw, ok := slots[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func oneOf(v any, allowed ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, a := range allowed {
		if s == a {
			return true
		}
	}
	return false
}

func textWithin(v any, max int) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	trimmed := trimSpace(s)
	if trimmed == "" {
		return false
	}
	return utf16Length(trimmed) <= max
}

func optionalTextArray(slots map[string]any, key string, max int) error {
	v, ok := slots[key]
	if !ok || v == nil {
		return nil
	}
	items, ok := v.([]any)
	if !ok {
		return fmt.Errorf("not an array")
	}
	for _, item := range items {
		if !textWithin(item, max) {
			return fmt.Errorf("bad item")
		}
	}
	return nil
}

// integerIn mirrors Number.isInteger(v) && v >= min && v <= max.
//
// It accepts both json.Number (what the HTTP layer produces, because the
// decoder runs with UseNumber) and the plain Go numerics a direct caller
// passes. Accepting only one made the same slots validate differently
// depending on who asked, which is how a wire contract quietly drifts.
func integerIn(v any, min, max int) bool {
	var f float64
	switch n := v.(type) {
	case json.Number:
		parsed, err := n.Float64()
		if err != nil {
			return false
		}
		f = parsed
	case float64:
		f = n
	case float32:
		f = float64(n)
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	default:
		return false
	}
	if math.Trunc(f) != f {
		return false
	}
	return f >= float64(min) && f <= float64(max)
}

func utf16Length(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func trimSpace(s string) string {
	return strings.TrimSpace(s)
}
