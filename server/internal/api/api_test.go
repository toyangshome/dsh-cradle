package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"cradle.local/server/internal/api"
	"cradle.local/server/internal/cache"
	"cradle.local/server/internal/config"
	"cradle.local/server/internal/protocol"
	"cradle.local/server/internal/rtc"
	"cradle.local/server/internal/store"
)

const adminToken = "test-admin-token"

type agent struct {
	did  string
	priv ed25519.PrivateKey
}

func newAgent(t *testing.T) agent {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return agent{did: protocol.EncodeDid(pub), priv: priv}
}

func signEnvelope(t *testing.T, from agent, to string, primitive string, traceID string, slots map[string]any, freeText string) map[string]any {
	t.Helper()
	envelope := map[string]any{
		"protocol":    protocol.Protocol,
		"primitive":   primitive,
		"message_id":  fmt.Sprintf("msg_%d_%s", time.Now().UnixNano(), primitive),
		"timestamp":   time.Now().UnixMilli(),
		"ttl":         5,
		"hop_history": []any{},
		"trace_id":    traceID,
		"sender": map[string]any{
			"did": from.did, "display_name": "test", "model_tier": "MEDIUM_32B",
		},
		"recipient": map[string]any{"did": to},
		"payload": map[string]any{
			"control_slots": slots,
			"free_text":     freeText,
		},
	}
	signature := ed25519.Sign(from.priv, protocol.CanonicalBytes(envelope))
	envelope["signature"] = base64.RawURLEncoding.EncodeToString(signature)
	return envelope
}

func setup(t *testing.T) *httptest.Server {
	t.Helper()
	dsn := os.Getenv("CRADLE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("CRADLE_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()

	st, err := store.Open(ctx, dsn, 5)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := st.Reset(ctx); err != nil {
		t.Fatalf("reset: %v", err)
	}

	var ch *cache.Cache
	if url := os.Getenv("CRADLE_TEST_REDIS_URL"); url != "" {
		ch, err = cache.Open(ctx, url)
		if err != nil {
			t.Fatalf("open cache: %v", err)
		}
		t.Cleanup(func() { _ = ch.Close() })
		if err := ch.Flush(ctx); err != nil {
			t.Fatalf("flush redis: %v", err)
		}
	}

	cfg := config.Config{
		AdminToken:   adminToken,
		MaxBodyBytes: 256 * 1024,
		Version:      "test",
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	exchange := rtc.NewExchange(logger)
	t.Cleanup(exchange.Close)
	server := httptest.NewServer(api.New(cfg, st, ch, logger, exchange).Handler())
	t.Cleanup(server.Close)
	return server
}

func do(t *testing.T, srv *httptest.Server, method, path string, body any, token string) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, srv.URL+path, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	if len(bytes.TrimSpace(raw)) > 0 {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		_ = dec.Decode(&out)
	}
	return res.StatusCode, out
}

func num(t *testing.T, value any) float64 {
	t.Helper()
	switch v := value.(type) {
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			t.Fatalf("number: %v", err)
		}
		return f
	case float64:
		return v
	}
	t.Fatalf("not a number: %#v", value)
	return 0
}

func TestRelayEndToEnd(t *testing.T) {
	srv := setup(t)
	alice := newAgent(t)
	bob := newAgent(t)

	// --- registration -----------------------------------------------------
	status, body := do(t, srv, http.MethodPost, "/v1/register", map[string]any{
		"did": alice.did, "display_name": "Alice", "bio": "Go and PostgreSQL engineer",
		"model_tier": "MEDIUM_32B", "capability_tags": []string{"go", "postgres"}, "intent_tags": []string{"redis"},
	}, "")
	if status != http.StatusOK {
		t.Fatalf("register alice: %d %v", status, body)
	}
	self, _ := body["self"].(map[string]any)
	if self["did"] != alice.did {
		t.Fatalf("self.did = %v", self["did"])
	}
	if got := num(t, self["credits"]); got != 50 {
		t.Fatalf("initial credits = %v, want 50", got)
	}

	status, body = do(t, srv, http.MethodPost, "/v1/register", map[string]any{
		"did": bob.did, "display_name": "Bob", "bio": "Database specialist",
		"model_tier": "FRONTIER_MAX", "capability_tags": []string{"postgres", "redis"},
	}, "")
	if status != http.StatusOK {
		t.Fatalf("register bob: %d %v", status, body)
	}

	// --- heartbeat + presence --------------------------------------------
	status, body = do(t, srv, http.MethodPost, "/v1/heartbeat", map[string]any{"did": alice.did, "since": 0}, "")
	if status != http.StatusOK {
		t.Fatalf("heartbeat: %d %v", status, body)
	}
	peers, _ := body["peers"].([]any)
	if len(peers) != 1 {
		t.Fatalf("peers = %d, want 1", len(peers))
	}

	// --- CAST relay -------------------------------------------------------
	cast := signEnvelope(t, alice, bob.did, protocol.Cast, "tr_cast_1",
		map[string]any{"session_id": "s_1", "intent": "DISCUSS", "requires_reply": true, "turn_index": 0},
		"hello bob")
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": cast}, "")
	if status != http.StatusOK {
		t.Fatalf("send cast: %d %v", status, body)
	}
	if got := num(t, body["charged"]); got != 1 {
		t.Fatalf("cast charged = %v, want 1", got)
	}

	// The recipient sees the envelope in its mailbox.
	status, body = do(t, srv, http.MethodPost, "/v1/heartbeat", map[string]any{"did": bob.did, "since": 0}, "")
	if status != http.StatusOK {
		t.Fatalf("bob heartbeat: %d %v", status, body)
	}
	messages, _ := body["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("bob messages = %d, want 1", len(messages))
	}
	delivered, _ := messages[0].(map[string]any)
	if delivered["primitive"] != protocol.Cast {
		t.Fatalf("delivered primitive = %v", delivered["primitive"])
	}

	// --- PROBE ------------------------------------------------------------
	probe := signEnvelope(t, alice, alice.did, protocol.Probe, "tr_probe_1",
		map[string]any{"mode": "SEARCH", "tags": []any{"postgres"}, "limit": 5}, "")
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": probe}, "")
	if status != http.StatusOK {
		t.Fatalf("probe: %d %v", status, body)
	}
	results, _ := body["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("probe results = %d, want 1", len(results))
	}
	hit, _ := results[0].(map[string]any)
	if hit["did"] != bob.did {
		t.Fatalf("probe hit = %v, want bob", hit["did"])
	}
	if score := num(t, hit["score"]); score <= 0 {
		t.Fatalf("probe score = %v, want > 0", score)
	}

	// --- DELEGATE lifecycle ----------------------------------------------
	assignSlots := map[string]any{
		"task_id": "task_1", "phase": "ASSIGN", "skill_required": "postgres",
		"max_token_budget": 50000, "deadline_ms": 600000,
	}
	assign := signEnvelope(t, alice, bob.did, protocol.Delegate, "tr_delegate_1", assignSlots, "own the schema")
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": assign}, "")
	if status != http.StatusOK {
		t.Fatalf("delegate assign: %d %v", status, body)
	}

	deliverSlots := map[string]any{
		"task_id": "task_1", "phase": "DELIVER", "skill_required": "postgres",
		"max_token_budget": 50000, "deadline_ms": 600000,
	}
	deliver := signEnvelope(t, bob, alice.did, protocol.Delegate, "tr_delegate_1", deliverSlots, "done")
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": deliver}, "")
	if status != http.StatusOK {
		t.Fatalf("delegate deliver: %d %v", status, body)
	}

	// Bob received the escrow (10) after paying 10 for the DELIVER primitive.
	status, body = do(t, srv, http.MethodGet, "/v1/agents/"+bob.did, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get bob: %d %v", status, body)
	}
	bobCard, _ := body["agent"].(map[string]any)
	if got := num(t, bobCard["credits"]); got != 50 {
		t.Fatalf("bob credits = %v, want 50", got)
	}
	if got := num(t, bobCard["completed_tasks"]); got != 1 {
		t.Fatalf("bob completed_tasks = %v, want 1", got)
	}

	// Second escrow, released by a positive attestation instead of DELIVER.
	assign2 := signEnvelope(t, alice, bob.did, protocol.Delegate, "tr_delegate_2", assignSlots, "second task")
	if status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": assign2}, ""); status != http.StatusOK {
		t.Fatalf("delegate assign 2: %d %v", status, body)
	}

	// Alice is down to 9 credits; a third assignment must be refused.
	assign3 := signEnvelope(t, alice, bob.did, protocol.Delegate, "tr_delegate_3", assignSlots, "third task")
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": assign3}, "")
	if status != http.StatusPaymentRequired {
		t.Fatalf("third assign status = %d, want 402 (%v)", status, body)
	}
	if got := num(t, body["need"]); got != 10 {
		t.Fatalf("insufficient need = %v, want 10", got)
	}
	if got := num(t, body["have"]); got != 9 {
		t.Fatalf("insufficient have = %v, want 9", got)
	}

	attest := signEnvelope(t, bob, alice.did, protocol.Attest, "tr_attest_1", map[string]any{
		"target_did": alice.did, "evidence_trace_id": "tr_delegate_2",
		"verdict": "POSITIVE", "capability_tag": "postgres",
	}, "delivered exactly")
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": attest}, "")
	if status != http.StatusOK {
		t.Fatalf("attest: %d %v", status, body)
	}
	record, _ := body["attestation"].(map[string]any)
	if got := num(t, record["verdict"]); got != 1 {
		t.Fatalf("attestation verdict = %v, want 1", got)
	}

	// The escrow pays the worker (Bob), plus the 2-credit attestation bonus:
	// Bob had 50 after the first DELIVER, so he now holds 62.
	status, body = do(t, srv, http.MethodGet, "/v1/agents/"+bob.did, nil, "")
	bobCard, _ = body["agent"].(map[string]any)
	if got := num(t, bobCard["credits"]); got != 62 {
		t.Fatalf("bob credits = %v, want 62", got)
	}
	if got := num(t, bobCard["completed_tasks"]); got != 2 {
		t.Fatalf("bob completed_tasks = %v, want 2", got)
	}

	// The attestation moved Alice's reputation but not her balance.
	status, body = do(t, srv, http.MethodGet, "/v1/agents/"+alice.did, nil, "")
	aliceCard, _ := body["agent"].(map[string]any)
	if got := num(t, aliceCard["credits"]); got != 9 {
		t.Fatalf("alice credits = %v, want 9", got)
	}
	if rep := num(t, aliceCard["reputation"]); rep <= 1 {
		t.Fatalf("alice reputation = %v, want > 1", rep)
	}

	// --- idempotency ------------------------------------------------------
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": cast}, "")
	if status != http.StatusOK {
		t.Fatalf("replay cast: %d %v", status, body)
	}
	if dup, _ := body["duplicate"].(bool); !dup {
		t.Fatalf("replay was not marked duplicate: %v", body)
	}
	status, body = do(t, srv, http.MethodGet, "/v1/agents/"+alice.did, nil, "")
	aliceCard, _ = body["agent"].(map[string]any)
	if got := num(t, aliceCard["credits"]); got != 9 {
		t.Fatalf("replay charged credits: %v, want 9", got)
	}

	// --- invalid envelopes ------------------------------------------------
	bad := map[string]any{}
	for k, v := range cast {
		bad[k] = v
	}
	bad["payload"] = map[string]any{
		"control_slots": map[string]any{"session_id": "s_1", "intent": "DISCUSS", "requires_reply": true, "turn_index": 0},
		"free_text":     "tampered",
	}
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": bad}, "")
	if status != http.StatusBadRequest {
		t.Fatalf("tampered envelope status = %d, want 400 (%v)", status, body)
	}
}

func TestAdminAPI(t *testing.T) {
	srv := setup(t)
	alice := newAgent(t)
	bob := newAgent(t)

	for _, a := range []agent{alice, bob} {
		if status, body := do(t, srv, http.MethodPost, "/v1/register", map[string]any{
			"did": a.did, "display_name": "agent-" + a.did[8:14],
		}, ""); status != http.StatusOK {
			t.Fatalf("register: %d %v", status, body)
		}
	}

	// Unauthorised access is rejected.
	if status, _ := do(t, srv, http.MethodGet, "/admin/v1/overview", nil, "wrong"); status != http.StatusUnauthorized {
		t.Fatalf("admin without token = %d, want 401", status)
	}

	status, body := do(t, srv, http.MethodGet, "/admin/v1/overview", nil, adminToken)
	if status != http.StatusOK {
		t.Fatalf("overview: %d %v", status, body)
	}
	overview, _ := body["overview"].(map[string]any)
	if got := num(t, overview["agents_total"]); got != 2 {
		t.Fatalf("agents_total = %v, want 2", got)
	}

	status, body = do(t, srv, http.MethodGet, "/admin/v1/agents?q=agent&sort=reputation", nil, adminToken)
	if status != http.StatusOK {
		t.Fatalf("admin agents: %d %v", status, body)
	}
	if got := num(t, body["total"]); got != 2 {
		t.Fatalf("admin total = %v, want 2", got)
	}

	// Credit adjustment writes a ledger row.
	status, body = do(t, srv, http.MethodPost, "/admin/v1/agents/"+alice.did+"/credits",
		map[string]any{"delta": 100, "reason": "grant"}, adminToken)
	if status != http.StatusOK {
		t.Fatalf("adjust credits: %d %v", status, body)
	}
	agentBody, _ := body["agent"].(map[string]any)
	if got := num(t, agentBody["credits"]); got != 150 {
		t.Fatalf("credits after grant = %v, want 150", got)
	}

	status, body = do(t, srv, http.MethodGet, "/admin/v1/ledger?did="+alice.did, nil, adminToken)
	ledger, _ := body["ledger"].([]any)
	if status != http.StatusOK || len(ledger) == 0 {
		t.Fatalf("ledger: %d %v", status, body)
	}

	// Ban blocks the relay, unban restores it.
	if status, body = do(t, srv, http.MethodPost, "/admin/v1/agents/"+alice.did+"/ban",
		map[string]any{"reason": "spam"}, adminToken); status != http.StatusOK {
		t.Fatalf("ban: %d %v", status, body)
	}
	probe := signEnvelope(t, alice, bob.did, protocol.Probe, "tr_probe_ban",
		map[string]any{"mode": "SEARCH", "limit": 5}, "")
	status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": probe}, "")
	if status != http.StatusForbidden {
		t.Fatalf("banned send status = %d, want 403 (%v)", status, body)
	}
	if status, body = do(t, srv, http.MethodPost, "/admin/v1/agents/"+alice.did+"/unban", map[string]any{}, adminToken); status != http.StatusOK {
		t.Fatalf("unban: %d %v", status, body)
	}
	if status, body = do(t, srv, http.MethodPost, "/v1/send", map[string]any{"envelope": probe}, ""); status != http.StatusOK {
		t.Fatalf("send after unban = %d %v", status, body)
	}

	// Settings toggle.
	status, body = do(t, srv, http.MethodPatch, "/admin/v1/settings",
		map[string]any{"registration_open": false}, adminToken)
	if status != http.StatusOK {
		t.Fatalf("patch settings: %d %v", status, body)
	}
	carol := newAgent(t)
	status, body = do(t, srv, http.MethodPost, "/v1/register", map[string]any{"did": carol.did}, "")
	if status != http.StatusForbidden {
		t.Fatalf("register while closed = %d, want 403 (%v)", status, body)
	}
	if status, body = do(t, srv, http.MethodPatch, "/admin/v1/settings",
		map[string]any{"registration_open": true}, adminToken); status != http.StatusOK {
		t.Fatalf("reopen registration: %d %v", status, body)
	}

	// Audit trail captured the operator actions.
	status, body = do(t, srv, http.MethodGet, "/admin/v1/audit", nil, adminToken)
	audit, _ := body["audit"].([]any)
	if status != http.StatusOK || len(audit) < 2 {
		t.Fatalf("audit = %d entries (%v)", len(audit), body)
	}
}

func TestConsoleIsServed(t *testing.T) {
	srv := setup(t)
	res, err := http.Get(srv.URL + "/admin")
	if err != nil {
		t.Fatalf("get console: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("console status = %d", res.StatusCode)
	}
	if !bytes.Contains(body, []byte("Cradle")) {
		t.Fatalf("console body does not look like the console")
	}
}
