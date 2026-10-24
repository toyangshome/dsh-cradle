package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"cradle.local/server/internal/store"
)

func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := s.store.Overview(r.Context())
	if err != nil {
		s.failError(w, err)
		return
	}
	redisStatus := "up"
	var redisOnline int64
	if s.cache == nil {
		redisStatus = "disabled"
	} else if err := s.cache.Ping(r.Context()); err != nil {
		redisStatus = "down"
	} else if online, err := s.cache.OnlineCount(r.Context(), store.PeerTTL); err == nil {
		redisOnline = online
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"overview":     overview,
		"redis":        redisStatus,
		"redis_online": redisOnline,
		"uptime_sec":   int64(time.Since(s.started).Seconds()),
	})
}

func (s *Server) handleAdminAgents(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	agents, total, err := s.store.AdminListAgents(r.Context(), store.AgentFilter{
		Query:  query.Get("q"),
		Status: query.Get("status"),
		Limit:  limit,
		Offset: offset,
		Sort:   query.Get("sort"),
	})
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"agents": agents, "total": total})
}

func (s *Server) handleAdminAgent(w http.ResponseWriter, r *http.Request) {
	agent, err := s.store.AdminGetAgent(r.Context(), r.PathValue("did"))
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"agent": agent})
}

type agentPatchRequest struct {
	DisplayName *string  `json:"display_name"`
	Bio         *string  `json:"bio"`
	ModelTier   *string  `json:"model_tier"`
	Reputation  *float64 `json:"reputation"`
	Credits     *int     `json:"credits"`
	Status      *string  `json:"status"`
	IsNPC       *bool    `json:"is_npc"`
}

func (s *Server) handleAdminPatchAgent(w http.ResponseWriter, r *http.Request) {
	var body agentPatchRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	did := r.PathValue("did")
	agent, err := s.store.AdminUpdateAgent(r.Context(), did, store.AgentPatch{
		DisplayName: body.DisplayName,
		Bio:         body.Bio,
		ModelTier:   body.ModelTier,
		Reputation:  body.Reputation,
		Credits:     body.Credits,
		Status:      body.Status,
		IsNPC:       body.IsNPC,
	})
	if err != nil {
		s.failError(w, err)
		return
	}
	s.store.Audit(r.Context(), "admin", "agent.update", did, map[string]any{
		"display_name": body.DisplayName,
		"reputation":   body.Reputation,
		"credits":      body.Credits,
		"status":       body.Status,
	})
	s.writeJSON(w, http.StatusOK, map[string]any{"agent": agent.Card(time.Now(), store.PeerTTL)})
}

type creditsRequest struct {
	Delta  int    `json:"delta"`
	Reason string `json:"reason"`
}

func (s *Server) handleAdminCredits(w http.ResponseWriter, r *http.Request) {
	var body creditsRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if body.Delta == 0 {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "delta must be non-zero"})
		return
	}
	reason := truncate(strings.TrimSpace(body.Reason), 200)
	if reason == "" {
		reason = "admin adjustment"
	}
	did := r.PathValue("did")
	agent, err := s.store.AdminAdjustCredits(r.Context(), did, body.Delta, reason)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.store.Audit(r.Context(), "admin", "agent.credits", did, map[string]any{
		"delta": body.Delta, "reason": reason,
	})
	s.writeJSON(w, http.StatusOK, map[string]any{"agent": agent.Card(time.Now(), store.PeerTTL)})
}

type banRequest struct {
	Reason  string `json:"reason"`
	UntilMS int64  `json:"until_ms"`
}

func (s *Server) handleAdminBan(w http.ResponseWriter, r *http.Request) {
	var body banRequest
	_ = decodeJSON(w, r, &body, s.cfg.MaxBodyBytes)
	var until *time.Time
	if body.UntilMS > 0 {
		t := time.UnixMilli(body.UntilMS)
		until = &t
	}
	did := r.PathValue("did")
	agent, err := s.store.AdminBan(r.Context(), did, truncate(body.Reason, 200), until)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.store.Audit(r.Context(), "admin", "agent.ban", did, map[string]any{"reason": body.Reason})
	s.writeJSON(w, http.StatusOK, map[string]any{"agent": agent.Card(time.Now(), store.PeerTTL)})
}

func (s *Server) handleAdminUnban(w http.ResponseWriter, r *http.Request) {
	did := r.PathValue("did")
	agent, err := s.store.AdminUnban(r.Context(), did)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.store.Audit(r.Context(), "admin", "agent.unban", did, nil)
	s.writeJSON(w, http.StatusOK, map[string]any{"agent": agent.Card(time.Now(), store.PeerTTL)})
}

func (s *Server) handleAdminDeleteAgent(w http.ResponseWriter, r *http.Request) {
	did := r.PathValue("did")
	if err := s.store.AdminDeleteAgent(r.Context(), did); err != nil {
		s.failError(w, err)
		return
	}
	s.store.Audit(r.Context(), "admin", "agent.delete", did, nil)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminMessages(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	messages, err := s.store.AdminMessages(r.Context(), r.URL.Query().Get("did"), limit)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"messages": messages})
}

func (s *Server) handleAdminTraces(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	traces, err := s.store.AdminTraces(r.Context(), limit)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"traces": traces})
}

func (s *Server) handleAdminEscrows(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	escrows, err := s.store.AdminEscrows(r.Context(), r.URL.Query().Get("status"), limit)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"escrows": escrows})
}

func (s *Server) handleAdminBeacons(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	beacons, err := s.store.AdminBeacons(r.Context(), limit)
	if err != nil {
		s.failError(w, err)
		return
	}
	out := make([]store.BeaconDTO, 0, len(beacons))
	for _, b := range beacons {
		out = append(out, b.DTO())
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"beacons": out})
}

func (s *Server) handleAdminDeleteBeacon(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.AdminDeleteBeacon(r.Context(), id); err != nil {
		s.failError(w, err)
		return
	}
	s.store.Audit(r.Context(), "admin", "beacon.delete", id, nil)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminAttestations(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	attestations, err := s.store.AdminAttestations(r.Context(), limit)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"attestations": attestations})
}

func (s *Server) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := s.store.AdminAudit(r.Context(), limit)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"audit": entries})
}

func (s *Server) handleAdminLedger(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	entries, err := s.store.AdminLedger(r.Context(), r.URL.Query().Get("did"), limit, offset)
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ledger": entries})
}

func (s *Server) handleAdminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.Settings(r.Context())
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
}

var allowedSettings = map[string]bool{
	"registration_open":              true,
	"maintenance_mode":               true,
	"send_rate_limit_per_minute":     true,
	"register_rate_limit_per_minute": true,
}

func (s *Server) handleAdminUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	for key, value := range body {
		if !allowedSettings[key] {
			s.fail(w, http.StatusBadRequest, map[string]any{"error": "unknown-setting", "key": key})
			return
		}
		if err := s.store.UpdateSetting(r.Context(), key, value); err != nil {
			s.failError(w, err)
			return
		}
	}
	s.settingsMu.Lock()
	s.settings = map[string]settingValue{}
	s.settingsMu.Unlock()
	s.store.Audit(r.Context(), "admin", "settings.update", "", body)
	settings, err := s.store.Settings(r.Context())
	if err != nil {
		s.failError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
}
