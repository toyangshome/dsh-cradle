package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"
)

type fixtureFile struct {
	Protocol string        `json:"protocol"`
	Cases    []fixtureCase `json:"cases"`
}

type fixtureCase struct {
	Name      string         `json:"name"`
	SignerDID string         `json:"signer_did"`
	Envelope  map[string]any `json:"envelope"`
	Canonical string         `json:"canonical"`
}

func loadFixtures(t *testing.T) fixtureFile {
	t.Helper()
	raw, err := os.ReadFile("testdata/envelopes.json")
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var fixtures fixtureFile
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&fixtures); err != nil {
		t.Fatalf("decode fixtures: %v", err)
	}
	if len(fixtures.Cases) == 0 {
		t.Fatal("no fixture cases")
	}
	return fixtures
}

// TestCanonicalBytesMatchJavaScript is the compatibility gate: the bytes Go
// signs must equal the bytes the plugin produced, or no envelope verifies.
func TestCanonicalBytesMatchJavaScript(t *testing.T) {
	fixtures := loadFixtures(t)
	for _, tc := range fixtures.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			got := string(CanonicalBytes(tc.Envelope))
			if got != tc.Canonical {
				t.Fatalf("canonical bytes differ\n got: %s\nwant: %s", got, tc.Canonical)
			}
		})
	}
}

func TestInspectEnvelopeAcceptsJavaScriptSignatures(t *testing.T) {
	fixtures := loadFixtures(t)
	for _, tc := range fixtures.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			ts, _ := tc.Envelope["timestamp"].(json.Number)
			ms, err := ts.Int64()
			if err != nil {
				t.Fatalf("timestamp: %v", err)
			}
			env, err := InspectEnvelopeAt(tc.Envelope, time.UnixMilli(ms))
			if err != nil {
				t.Fatalf("inspect: %v", err)
			}
			if env.Primitive != tc.Name {
				t.Fatalf("primitive = %q, want %q", env.Primitive, tc.Name)
			}
			if env.Sender.Did != tc.SignerDID {
				t.Fatalf("sender = %q, want %q", env.Sender.Did, tc.SignerDID)
			}
			if _, ok := DecodeDid(env.Sender.Did); !ok {
				t.Fatalf("did did not decode")
			}
		})
	}
}

func TestInspectEnvelopeRejectsTampering(t *testing.T) {
	fixtures := loadFixtures(t)
	tc := fixtures.Cases[0]
	ts, _ := tc.Envelope["timestamp"].(json.Number)
	ms, _ := ts.Int64()

	tampered := map[string]any{}
	for k, v := range tc.Envelope {
		tampered[k] = v
	}
	payload := tampered["payload"].(map[string]any)
	payload["free_text"] = "tampered"

	if _, err := InspectEnvelopeAt(tampered, time.UnixMilli(ms)); err == nil {
		t.Fatal("tampered envelope was accepted")
	}
}

func TestInspectEnvelopeRejectsUnknownPrimitive(t *testing.T) {
	fixtures := loadFixtures(t)
	tc := fixtures.Cases[0]
	ts, _ := tc.Envelope["timestamp"].(json.Number)
	ms, _ := ts.Int64()

	bad := map[string]any{}
	for k, v := range tc.Envelope {
		bad[k] = v
	}
	bad["primitive"] = "SHOUT"

	if _, err := InspectEnvelopeAt(bad, time.UnixMilli(ms)); err == nil {
		t.Fatal("unknown primitive was accepted")
	}
}

func TestFormatJSNumber(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{1, "1"},
		{-1, "-1"},
		{50, "50"},
		{0.1, "0.1"},
		{0.30000000000000004, "0.30000000000000004"},
		{1e21, "1e+21"},
		{1e20, "100000000000000000000"},
		{1e-7, "1e-7"},
		{0.000001, "0.000001"},
		{123.456, "123.456"},
		{1729512345678, "1729512345678"},
	}
	for _, tc := range cases {
		if got := FormatJSNumber(tc.in); got != tc.want {
			t.Errorf("FormatJSNumber(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestStableStringifySortsKeysAndEscapes(t *testing.T) {
	value := map[string]any{
		"b": json.Number("2"),
		"a": "line\n\"quoted\"\\slash\u0001",
		"c": []any{json.Number("1"), true, nil},
	}
	want := `{"a":"line\n\"quoted\"\\slash\u0001","b":2,"c":[1,true,null]}`
	if got := StableStringify(value); got != want {
		t.Fatalf("StableStringify = %q, want %q", got, want)
	}
}

func TestEncodeDecodeDidRoundTrip(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	did := EncodeDid(raw)
	decoded, ok := DecodeDid(did)
	if !ok {
		t.Fatalf("did %q did not decode", did)
	}
	if !bytes.Equal(decoded, raw) {
		t.Fatalf("round trip mismatch")
	}
}
