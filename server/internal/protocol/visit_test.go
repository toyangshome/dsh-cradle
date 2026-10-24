package protocol

import (
	"testing"
)

// The VISIT spec is the control plane of a room visit. Moving and speaking are
// deliberately absent: they travel the peer-to-peer data plane, so a guest can
// walk across a room without spending a credit or touching the relay.
func TestVisitSlots(t *testing.T) {
	cases := []struct {
		name  string
		slots map[string]any
		want  bool
	}{
		{"knock", map[string]any{"visit_id": "v1", "phase": VisitKnock}, true},
		{"accept with tile", map[string]any{"visit_id": "v1", "phase": VisitAccept, "tile": map[string]any{"x": 3, "y": 9}}, true},
		{"enter without tile", map[string]any{"visit_id": "v1", "phase": VisitEnter}, true},
		{"every phase accepted", map[string]any{"visit_id": "v1", "phase": VisitEvict}, true},
		{"unknown phase", map[string]any{"visit_id": "v1", "phase": "SNEAK"}, false},
		{"missing visit id", map[string]any{"phase": VisitKnock}, false},
		{"empty visit id", map[string]any{"visit_id": "", "phase": VisitKnock}, false},
		{"negative tile", map[string]any{"visit_id": "v1", "phase": VisitAccept, "tile": map[string]any{"x": -1, "y": 2}}, false},
		{"tile missing y", map[string]any{"visit_id": "v1", "phase": VisitAccept, "tile": map[string]any{"x": 1}}, false},
		{"tile out of range", map[string]any{"visit_id": "v1", "phase": VisitAccept, "tile": map[string]any{"x": 999, "y": 2}}, false},
		{"tile not an object", map[string]any{"visit_id": "v1", "phase": VisitAccept, "tile": "3,9"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Specs[Visit].Validate(tc.slots)
			if got := err == nil; got != tc.want {
				t.Fatalf("validate(%v) ok = %v, want %v (err: %v)", tc.slots, got, tc.want, err)
			}
		})
	}
}

// Only the knock is priced, which matches plugin/lib/protocol.js exactly: if
// the two ever disagree, one side rejects the other's envelopes.
func TestVisitCostMatchesJavaScript(t *testing.T) {
	cases := map[string]int{
		VisitKnock:   1,
		VisitAccept:  0,
		VisitDecline: 0,
		VisitEnter:   0,
		VisitLeave:   0,
		VisitEvict:   0,
	}
	for phase, want := range cases {
		if got := Price(Visit, map[string]any{"phase": phase}); got != want {
			t.Errorf("Price(VISIT, %s) = %d, want %d", phase, got, want)
		}
	}
}

func TestVisitIsRegistered(t *testing.T) {
	if _, ok := Specs[Visit]; !ok {
		t.Fatal("VISIT is missing from the spec registry")
	}
	// The primitive count is part of the wire contract.
	if len(Specs) != 8 {
		t.Fatalf("Specs has %d primitives, want 8", len(Specs))
	}
}
