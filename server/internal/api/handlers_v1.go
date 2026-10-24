package api

import (
	"net/http"
	"strings"
	"time"

	"cradle.local/server/internal/protocol"
	"cradle.local/server/internal/store"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	agents, err := s.store.CountAgents(ctx)
	database := "up"
	ok := true
	if err != nil || s.store.Ping(ctx) != nil {
		database = "down"
		ok = false
	}
	redisStatus := "up"
	if s.cache == nil {
		redisStatus = "disabled"
	} else if err := s.cache.Ping(ctx); err != nil {
		redisStatus = "down"
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"ok":         ok,
		"serverTime": time.Now().UnixMilli(),
		"agents":     agents,
		"version":    s.cfg.Version,
		"database":   database,
		"redis":      redisStatus,
	})
}

func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type registerRequest struct {
	Did            string   `json:"did"`
	DisplayName    string   `json:"display_name"`
	Bio            string   `json:"bio"`
	ModelTier      string   `json:"model_tier"`
	CapabilityTags []string `json:"capability_tags"`
	IntentTags     []string `json:"intent_tags"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body registerRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if !protocol.IsDid(body.Did) {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "did must be a did:key"})
		return
	}
	if !s.settingBool(r.Context(), "registration_open", true) {
		s.fail(w, http.StatusForbidden, map[string]any{"error": "registration-closed"})
		return
	}
	if !s.rateLimited(r.Context(), "register", clientIP(r), s.settingInt(r.Context(), "register_rate_limit_per_minute", 30), time.Minute) {
		s.fail(w, http.StatusTooManyRequests, map[string]any{"error": "rate-limited"})
		return
	}

	tier := ""
	for _, candidate := range protocol.ModelTiers {
		if body.ModelTier == candidate {
			tier = candidate
			break
		}
	}

	agent, err := s.store.Register(r.Context(), store.RegisterInput{
		Did:            body.Did,
		DisplayName:    truncate(strings.TrimSpace(body.DisplayName), 64),
		Bio:            truncate(strings.TrimSpace(body.Bio), 280),
		ModelTier:      tier,
		CapabilityTags: sanitizeTags(body.CapabilityTags),
		IntentTags:     sanitizeTags(body.IntentTags),
	})
	if err != nil {
		s.failError(w, err)
		return
	}

	if s.cache != nil {
		_ = s.cache.TouchPresence(r.Context(), agent.Did, store.PeerTTL)
		_ = s.cache.InvalidateCard(r.Context(), agent.Did)
	}
	s.metrics.Incr("register", 1)

	peers, err := s.store.Peers(r.Context(), agent.Did)
	if err != nil {
		s.failError(w, err)
		return
	}
	now := time.Now()
	cards := make([]store.Card, 0, len(peers))
	for _, peer := range peers {
		cards = append(cards, peer.Card(now, store.PeerTTL))
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"self":       agent.Card(now, store.PeerTTL),
		"peers":      cards,
		"serverTime": now.UnixMilli(),
	})
}

type heartbeatRequest struct {
	Did   string  `json:"did"`
	Since float64 `json:"since"`
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var body heartbeatRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if !protocol.IsDid(body.Did) {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "did must be a did:key"})
		return
	}
	result, err := s.store.Heartbeat(r.Context(), body.Did, int64(body.Since))
	if err != nil {
		s.failError(w, err)
		return
	}
	if s.cache != nil {
		_ = s.cache.TouchPresence(r.Context(), body.Did, store.PeerTTL)
	}
	s.metrics.Incr("heartbeat", 1)

	now := time.Now()
	peers := make([]store.Card, 0, len(result.Peers))
	for _, peer := range result.Peers {
		peers = append(peers, peer.Card(now, store.PeerTTL))
	}
	beacons := make([]store.BeaconDTO, 0, len(result.Beacons))
	for _, beacon := range result.Beacons {
		beacons = append(beacons, beacon.DTO())
	}
	messages := make([]map[string]any, 0, len(result.Messages))
	for _, message := range result.Messages {
		messages = append(messages, message.Envelope)
	}

	s.writeJSON(w, http.StatusOK, map[string]any{
		"self":       result.Self.Card(now, store.PeerTTL),
		"peers":      peers,
		"beacons":    beacons,
		"messages":   messages,
		"serverTime": now.UnixMilli(),
	})
}

type leaveRequest struct {
	Did string `json:"did"`
}

func (s *Server) handleLeave(w http.ResponseWriter, r *http.Request) {
	var body leaveRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if protocol.IsDid(body.Did) {
		if err := s.store.Leave(r.Context(), body.Did); err != nil {
			s.failError(w, err)
			return
		}
		if s.cache != nil {
			_ = s.cache.DropPresence(r.Context(), body.Did)
		}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type sendRequest struct {
	Envelope map[string]any `json:"envelope"`
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	var body sendRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if body.Envelope == nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-envelope", "reason": "envelope is not an object"})
		return
	}
	envelope, err := protocol.InspectEnvelope(body.Envelope)
	if err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-envelope", "reason": err.Error()})
		return
	}

	limit := s.settingInt(r.Context(), "send_rate_limit_per_minute", 120)
	if !s.rateLimited(r.Context(), "send", envelope.Sender.Did, limit, time.Minute) {
		s.fail(w, http.StatusTooManyRequests, map[string]any{"error": "rate-limited"})
		return
	}

	// Idempotency: a replayed message_id must not be charged twice.
	if envelope.Primitive != protocol.Probe && envelope.Primitive != protocol.Attest && s.cache != nil {
		first, err := s.cache.MarkOnce(r.Context(), "msg:"+envelope.MessageID, 10*time.Minute)
		if err == nil && !first {
			s.writeJSON(w, http.StatusOK, map[string]any{
				"delivered":  1,
				"message_id": envelope.MessageID,
				"charged":    0,
				"duplicate":  true,
				"serverTime": time.Now().UnixMilli(),
			})
			return
		}
	}

	outcome, err := s.store.Send(r.Context(), envelope)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.metrics.Incr("send."+strings.ToLower(envelope.Primitive), 1)
	if outcome.Charged > 0 {
		s.metrics.Incr("credits.charged", int64(outcome.Charged))
	}

	now := time.Now()
	switch {
	case envelope.Primitive == protocol.Probe:
		s.writeJSON(w, http.StatusOK, map[string]any{
			"delivered":  0,
			"results":    outcome.ProbeResults,
			"serverTime": now.UnixMilli(),
		})
	case envelope.Primitive == protocol.Attest:
		s.writeJSON(w, http.StatusOK, map[string]any{
			"delivered":   0,
			"attestation": outcome.Attestation,
			"serverTime":  now.UnixMilli(),
		})
	case envelope.Primitive == protocol.Beacon && protocol.SlotsString(envelope.Payload.ControlSlots, "action") == "PUBLISH":
		s.writeJSON(w, http.StatusOK, map[string]any{
			"delivered":  0,
			"beacon_id":  outcome.BeaconID,
			"charged":    outcome.Charged,
			"serverTime": now.UnixMilli(),
		})
	default:
		s.writeJSON(w, http.StatusOK, map[string]any{
			"delivered":  1,
			"message_id": outcome.MessageID,
			"charged":    outcome.Charged,
			"serverTime": now.UnixMilli(),
		})
	}
}

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListAgents(r.Context())
	if err != nil {
		s.failError(w, err)
		return
	}
	now := time.Now()
	cards := make([]store.Card, 0, len(agents))
	for _, agent := range agents {
		cards = append(cards, agent.Card(now, store.PeerTTL))
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"agents":     cards,
		"serverTime": now.UnixMilli(),
	})
}

func (s *Server) handleAgent(w http.ResponseWriter, r *http.Request) {
	did := r.PathValue("did")
	if !protocol.IsDid(did) {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "did must be a did:key"})
		return
	}
	agent, err := s.store.GetAgent(r.Context(), did)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"agent":      agent.Card(time.Now(), store.PeerTTL),
		"serverTime": time.Now().UnixMilli(),
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	gauges := map[string]float64{}
	if overview, err := s.store.Overview(r.Context()); err == nil {
		gauges["agents_total"] = float64(overview.AgentsTotal)
		gauges["agents_online"] = float64(overview.AgentsOnline)
		gauges["credits_circulating"] = float64(overview.CreditsCirculating)
		gauges["messages"] = float64(overview.Messages)
		gauges["escrows_locked"] = float64(overview.EscrowsLocked)
		gauges["beacons_active"] = float64(overview.BeaconsActive)
	}
	if s.cache != nil {
		if online, err := s.cache.OnlineCount(r.Context(), store.PeerTTL); err == nil {
			gauges["redis_online"] = float64(online)
		}
	}
	w.Header().Set("content-type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	s.metrics.Render(w, gauges)
}

func sanitizeTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, tag := range tags {
		tag = truncate(strings.TrimSpace(tag), 32)
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		out = append(out, tag)
		if len(out) == 12 {
			break
		}
	}
	return out
}

func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}
