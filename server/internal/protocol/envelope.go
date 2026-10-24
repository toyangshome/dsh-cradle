package protocol

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Party is one side of an envelope.
type Party struct {
	Did         string
	DisplayName string
	ModelTier   string
}

// Payload is the dual-track body: machine-validated slots plus prose.
type Payload struct {
	FreeText     string
	ControlSlots map[string]any
}

// Envelope is a validated, signature-checked `dsh-net/1.0` envelope.
type Envelope struct {
	MessageID     string
	Timestamp     int64
	TTL           int
	Primitive     string
	TraceID       string
	Sender        Party
	Recipient     Party
	ContextAnchor map[string]any
	Payload       Payload
	// Raw keeps the decoded JSON so the relay can store the exact envelope.
	Raw map[string]any
}

// ValidationError explains why an envelope was rejected.
type ValidationError struct {
	Reason string
}

func (e *ValidationError) Error() string { return e.Reason }

func invalid(format string, args ...any) error {
	return &ValidationError{Reason: fmt.Sprintf(format, args...)}
}

// InspectEnvelope verifies shape, primitive slots and the Ed25519 signature.
// It never consults server state, so the same envelope is accepted by every
// replica.
func InspectEnvelope(env map[string]any) (*Envelope, error) {
	return InspectEnvelopeAt(env, time.Now())
}

// InspectEnvelopeAt is InspectEnvelope with an injectable clock. Tests use it
// to replay fixtures that were signed earlier.
func InspectEnvelopeAt(env map[string]any, now time.Time) (*Envelope, error) {
	if env == nil {
		return nil, invalid("envelope is not an object")
	}
	if got, _ := env["protocol"].(string); got != Protocol {
		return nil, invalid("unsupported protocol %v", env["protocol"])
	}

	sender, err := partyOf(env["sender"], "sender")
	if err != nil {
		return nil, err
	}
	recipient, err := partyOf(env["recipient"], "recipient")
	if err != nil {
		return nil, err
	}

	primitive, _ := env["primitive"].(string)
	spec, ok := Specs[primitive]
	if !ok {
		return nil, invalid("unknown primitive %v", env["primitive"])
	}

	ts, ok := numericValue(env["timestamp"])
	if !ok {
		return nil, invalid("timestamp is missing or outside the 24h window")
	}
	nowMS := now.UnixMilli()
	if diff := nowMS - int64(ts); diff > TimestampWindow || diff < -TimestampWindow {
		return nil, invalid("timestamp is missing or outside the 24h window")
	}

	ttlValue, ok := numericValue(env["ttl"])
	if !ok || ttlValue < 1 || ttlValue > MaxTTL {
		return nil, invalid("ttl out of range")
	}

	hops, ok := env["hop_history"].([]any)
	if !ok {
		return nil, invalid("hop_history must contain DIDs")
	}
	for _, hop := range hops {
		did, _ := hop.(string)
		if !IsDid(did) {
			return nil, invalid("hop_history must contain DIDs")
		}
	}

	if len(StableStringify(env)) > MaxEnvelopeBytes {
		return nil, invalid("envelope exceeds 32KB")
	}

	if anchor, present := env["context_anchor"]; present && anchor != nil {
		obj, ok := anchor.(map[string]any)
		if !ok {
			return nil, invalid("context_anchor must be an object")
		}
		if len(StableStringify(obj)) > ContextAnchorMaxChars*4 {
			return nil, invalid("context_anchor too large")
		}
	}

	payloadRaw, ok := env["payload"].(map[string]any)
	if !ok {
		return nil, invalid("payload must be an object")
	}
	freeText, ok := payloadRaw["free_text"].(string)
	if !ok {
		return nil, invalid("payload.free_text must be a string")
	}
	slots, ok := payloadRaw["control_slots"].(map[string]any)
	if !ok {
		return nil, invalid("payload.control_slots must be an object")
	}
	if err := spec.Validate(slots); err != nil {
		return nil, invalid("%s control_slots: %s", primitive, err.Error())
	}

	signature, _ := env["signature"].(string)
	if signature == "" {
		return nil, invalid("signature does not verify for sender.did")
	}
	pub, ok := DecodeDid(sender.Did)
	if !ok {
		return nil, invalid("sender.did is not a did:key")
	}
	sig, err := decodeBase64URL(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, invalid("signature does not verify for sender.did")
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), CanonicalBytes(env), sig) {
		return nil, invalid("signature does not verify for sender.did")
	}

	traceID, _ := env["trace_id"].(string)
	messageID, _ := env["message_id"].(string)

	return &Envelope{
		MessageID:     messageID,
		Timestamp:     int64(ts),
		TTL:           int(ttlValue),
		Primitive:     primitive,
		TraceID:       traceID,
		Sender:        sender,
		Recipient:     recipient,
		ContextAnchor: anchorOf(env["context_anchor"]),
		Payload:       Payload{FreeText: freeText, ControlSlots: slots},
		Raw:           env,
	}, nil
}

func partyOf(v any, field string) (Party, error) {
	obj, ok := v.(map[string]any)
	if !ok {
		return Party{}, invalid("%s.did is not a did:key", field)
	}
	did, _ := obj["did"].(string)
	if !IsDid(did) {
		return Party{}, invalid("%s.did is not a did:key", field)
	}
	name, _ := obj["display_name"].(string)
	tier, _ := obj["model_tier"].(string)
	return Party{Did: did, DisplayName: name, ModelTier: tier}, nil
}

func anchorOf(v any) map[string]any {
	obj, _ := v.(map[string]any)
	return obj
}

func numericValue(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return 0, false
		}
		return f, true
	case float64:
		return n, true
	case int:
		return float64(n), true
	}
	return 0, false
}

func decodeBase64URL(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	return base64.RawURLEncoding.DecodeString(s)
}
