package api_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"cradle.local/server/internal/api"
	"cradle.local/server/internal/config"
	"cradle.local/server/internal/protocol"
	"cradle.local/server/internal/rtc"
)

// The visit endpoints are the part of the relay a panel talks to, and they are
// deliberately independent of PostgreSQL: signalling and relaying are in
// memory, so these tests need no database and run everywhere.
//
// What they do not do is decide whether a visit may happen. That travels the
// signed VISIT envelope through /v1/send, priced and journalled like any other
// primitive, and is covered elsewhere.

func setupVisit(t *testing.T) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	exchange := rtc.NewExchange(logger)
	t.Cleanup(exchange.Close)
	cfg := config.Config{MaxBodyBytes: 256 * 1024, Version: "test"}
	srv := httptest.NewServer(api.New(cfg, nil, nil, logger, exchange).Handler())
	t.Cleanup(srv.Close)
	return srv
}

func postJSON(t *testing.T, srv *httptest.Server, path string, body any) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(srv.URL+path, "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func did(suffix string) string {
	// A real did:key over 32 bytes derived from the name, so the handler's
	// IsDid check treats it exactly like an agent's identity.
	sum := sha256.Sum256([]byte(suffix))
	return protocol.EncodeDid(sum[:])
}

func TestVisitSignalPostsAndDrains(t *testing.T) {
	srv := setupVisit(t)
	alice := did("alice")
	bob := did("bob")

	status, _ := postJSON(t, srv, "/v1/visit/signal", map[string]any{
		"visit_id": "v1", "from": alice, "peer": bob, "kind": "offer",
		"payload": map[string]any{"type": "offer", "sdp": "v=0"},
	})
	if status != http.StatusOK {
		t.Fatalf("post offer = %d, want 200", status)
	}

	// The sender must not read its own offer back.
	status, out := postJSON(t, srv, "/v1/visit/signal/drain", map[string]any{"visit_id": "v1", "did": alice})
	if status != http.StatusOK {
		t.Fatalf("drain = %d, want 200", status)
	}
	if signals, _ := out["signals"].([]any); len(signals) != 0 {
		t.Fatalf("sender got %d signals, want 0", len(signals))
	}

	status, out = postJSON(t, srv, "/v1/visit/signal/drain", map[string]any{"visit_id": "v1", "did": bob})
	if status != http.StatusOK {
		t.Fatalf("drain = %d, want 200", status)
	}
	signals, _ := out["signals"].([]any)
	if len(signals) != 1 {
		t.Fatalf("peer got %d signals, want 1", len(signals))
	}
	first, _ := signals[0].(map[string]any)
	if first["kind"] != "offer" || first["from"] != alice {
		t.Fatalf("signal = %+v, want an offer from alice", first)
	}
}

func TestVisitSignalRejectsBadInput(t *testing.T) {
	srv := setupVisit(t)
	alice := did("alice")
	bob := did("bob")

	cases := []struct {
		name string
		body map[string]any
		want int
	}{
		{"not a did", map[string]any{"visit_id": "v1", "from": "alice", "peer": bob, "kind": "offer", "payload": map[string]any{}}, http.StatusBadRequest},
		{"same both sides", map[string]any{"visit_id": "v1", "from": alice, "peer": alice, "kind": "offer", "payload": map[string]any{}}, http.StatusBadRequest},
		{"unknown kind", map[string]any{"visit_id": "v1", "from": alice, "peer": bob, "kind": "scream", "payload": map[string]any{}}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if status, _ := postJSON(t, srv, "/v1/visit/signal", tc.body); status != tc.want {
				t.Fatalf("status = %d, want %d", status, tc.want)
			}
		})
	}
}

func TestVisitRelayCarriesFramesAndCloses(t *testing.T) {
	srv := setupVisit(t)
	alice := did("alice")
	bob := did("bob")

	status, out := postJSON(t, srv, "/v1/visit/relay", map[string]any{
		"visit_id": "v2", "from": alice, "peer": bob, "kind": "move",
		"payload": map[string]any{"x": 4, "y": 9},
	})
	if status != http.StatusOK {
		t.Fatalf("relay = %d, want 200", status)
	}
	if delivered, _ := out["delivered"].(bool); !delivered {
		t.Fatal("the relay refused a frame for a peer with a channel")
	}

	// An unsupported frame kind is refused before it reaches anyone.
	status, _ = postJSON(t, srv, "/v1/visit/relay", map[string]any{
		"visit_id": "v2", "from": alice, "peer": bob, "kind": "reformat-disk",
		"payload": map[string]any{},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("bad kind = %d, want 400", status)
	}

	status, _ = postJSON(t, srv, "/v1/visit/relay", map[string]any{
		"visit_id": "v2", "from": alice, "peer": bob, "close": true,
	})
	if status != http.StatusOK {
		t.Fatalf("close = %d, want 200", status)
	}
}

func TestVisitEndpointsReportDisabledWhenThereIsNoExchange(t *testing.T) {
	// Visits can be turned off entirely; the panel must get a clear answer
	// rather than a hang.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(api.New(config.Config{MaxBodyBytes: 1024}, nil, nil, logger, nil).Handler())
	defer srv.Close()

	status, _ := postJSON(t, srv, "/v1/visit/signal", map[string]any{
		"visit_id": "v3", "from": did("a"), "peer": did("b"), "kind": "offer", "payload": map[string]any{},
	})
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when visits are off", status)
	}
}

func TestVisitSignalDrainRejectsNonDid(t *testing.T) {
	srv := setupVisit(t)
	if status, _ := postJSON(t, srv, "/v1/visit/signal/drain", map[string]any{"visit_id": "v4", "did": "not-a-did"}); status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
}
