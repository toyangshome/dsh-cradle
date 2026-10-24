// Package protocol implements the `dsh-net/1.0` wire format shared with the
// DSH plugin (plugin/lib/protocol.js).
//
// The Go server is the authoritative relay: it re-verifies every envelope's
// Ed25519 signature, so the canonical byte representation produced here must be
// bit-for-bit identical to the JavaScript implementation. That is why this
// package ships its own JSON canonicalizer instead of using encoding/json.
package protocol

import (
	"encoding/base64"
	"strings"
)

const (
	// Protocol is the wire tag carried by every envelope.
	Protocol = "dsh-net/1.0"
	// MaxEnvelopeBytes is the hard wire limit; larger payloads go out of band.
	MaxEnvelopeBytes = 32 * 1024
	// DefaultTTL and MaxTTL bound the hop budget.
	DefaultTTL = 5
	MaxTTL     = 8
	// MaxTurnsPerTrace is where the client-side guardrail suspends a trace.
	MaxTurnsPerTrace = 6
	// ContextAnchorMaxChars is the prose budget for context_anchor.
	ContextAnchorMaxChars = 400
	// TimestampWindow is how far an envelope timestamp may drift from server time.
	TimestampWindow = 24 * 60 * 60 * 1000
)

// ModelTiers are the capability tiers used for cross-model negotiation.
var ModelTiers = []string{"NANO_7B", "MEDIUM_32B", "FRONTIER_MAX"}

// EncodeDid encodes a raw 32-byte Ed25519 public key as the multibase form the
// plugin uses: `did:key:z` + base64url(raw || 0xed 0x01), no padding.
func EncodeDid(raw []byte) string {
	buf := make([]byte, 0, len(raw)+2)
	buf = append(buf, 0xed, 0x01)
	buf = append(buf, raw...)
	return "did:key:z" + base64.RawURLEncoding.EncodeToString(buf)
}

// DecodeDid decodes a `did:key` into its raw 32-byte Ed25519 public key.
func DecodeDid(did string) ([]byte, bool) {
	const prefix = "did:key:z"
	if !strings.HasPrefix(did, prefix) {
		return nil, false
	}
	encoded := strings.TrimRight(did[len(prefix):], "=")
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != 34 {
		return nil, false
	}
	if raw[0] != 0xed || raw[1] != 0x01 {
		return nil, false
	}
	return raw[2:], true
}

// IsDid reports whether the string is a well-formed Ed25519 `did:key`.
func IsDid(did string) bool {
	_, ok := DecodeDid(did)
	return ok
}
