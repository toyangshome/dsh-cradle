// Package api exposes the Cradle Discovery Server over HTTP.
//
// Two surfaces share one process:
//   - /v1/*      the dsh-net/1.0 relay, wire-compatible with the DSH plugin;
//   - /admin/v1  the operator API, plus a single-page console at /admin.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"cradle.local/server/internal/cache"
	"cradle.local/server/internal/config"
	"cradle.local/server/internal/obs"
	"cradle.local/server/internal/rtc"
	"cradle.local/server/internal/store"
)

// Server wires the HTTP surface to PostgreSQL and Redis.
type Server struct {
	cfg     config.Config
	store   *store.Store
	cache   *cache.Cache
	log     *slog.Logger
	metrics *obs.Metrics
	handler http.Handler
	started time.Time

	// exchange carries the WebRTC handshake and the fallback relay for visits.
	// It is in-memory and may be nil when visits are disabled.
	exchange *rtc.Exchange

	settingsMu sync.Mutex
	settings   map[string]settingValue
}

type settingValue struct {
	value   any
	expires time.Time
}

// New builds the router. `ex` may be nil, which turns visits off.
func New(cfg config.Config, st *store.Store, ch *cache.Cache, log *slog.Logger, ex *rtc.Exchange) *Server {
	s := &Server{
		cfg:      cfg,
		store:    st,
		cache:    ch,
		log:      log,
		metrics:  obs.New(),
		started:  time.Now(),
		exchange: ex,
		settings: map[string]settingValue{},
	}
	s.handler = s.routes()
	return s
}

// Handler returns the composed HTTP handler.
func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /v1/health", s.v1(s.handleHealth))
	mux.HandleFunc("POST /v1/register", s.v1(s.handleRegister))
	mux.HandleFunc("POST /v1/heartbeat", s.v1(s.handleHeartbeat))
	mux.HandleFunc("POST /v1/leave", s.v1(s.handleLeave))
	mux.HandleFunc("POST /v1/send", s.v1(s.handleSend))
	mux.HandleFunc("GET /v1/agents", s.v1(s.handleAgents))
	mux.HandleFunc("GET /v1/agents/{did}", s.v1(s.handleAgent))
	// The visit surface: handshake and relay only. Authorisation travels the
	// signed VISIT envelope through /v1/send like any other primitive.
	mux.HandleFunc("POST /v1/visit/signal", s.v1(s.handleSignalPost))
	mux.HandleFunc("POST /v1/visit/signal/drain", s.v1(s.handleSignalDrain))
	mux.HandleFunc("POST /v1/visit/relay", s.v1(s.handleRelaySend))
	mux.HandleFunc("POST /v1/visit/relay/poll", s.v1(s.handleRelayPoll))
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /healthz", s.handleLive)

	mux.HandleFunc("GET /admin", s.handleConsole)
	mux.HandleFunc("GET /admin/", s.handleConsole)

	mux.HandleFunc("GET /admin/v1/overview", s.adminOnly(s.handleAdminOverview))
	mux.HandleFunc("GET /admin/v1/agents", s.adminOnly(s.handleAdminAgents))
	mux.HandleFunc("GET /admin/v1/agents/{did}", s.adminOnly(s.handleAdminAgent))
	mux.HandleFunc("PATCH /admin/v1/agents/{did}", s.adminOnly(s.handleAdminPatchAgent))
	mux.HandleFunc("DELETE /admin/v1/agents/{did}", s.adminOnly(s.handleAdminDeleteAgent))
	mux.HandleFunc("POST /admin/v1/agents/{did}/credits", s.adminOnly(s.handleAdminCredits))
	mux.HandleFunc("POST /admin/v1/agents/{did}/ban", s.adminOnly(s.handleAdminBan))
	mux.HandleFunc("POST /admin/v1/agents/{did}/unban", s.adminOnly(s.handleAdminUnban))
	mux.HandleFunc("GET /admin/v1/messages", s.adminOnly(s.handleAdminMessages))
	mux.HandleFunc("GET /admin/v1/traces", s.adminOnly(s.handleAdminTraces))
	mux.HandleFunc("GET /admin/v1/escrows", s.adminOnly(s.handleAdminEscrows))
	mux.HandleFunc("GET /admin/v1/beacons", s.adminOnly(s.handleAdminBeacons))
	mux.HandleFunc("DELETE /admin/v1/beacons/{id}", s.adminOnly(s.handleAdminDeleteBeacon))
	mux.HandleFunc("GET /admin/v1/attestations", s.adminOnly(s.handleAdminAttestations))
	mux.HandleFunc("GET /admin/v1/audit", s.adminOnly(s.handleAdminAudit))
	mux.HandleFunc("GET /admin/v1/ledger", s.adminOnly(s.handleAdminLedger))
	mux.HandleFunc("GET /admin/v1/settings", s.adminOnly(s.handleAdminSettings))
	mux.HandleFunc("PATCH /admin/v1/settings", s.adminOnly(s.handleAdminUpdateSettings))

	return s.withMiddleware(mux)
}

// ------------------------------------------------------------------ middleware

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}

		defer func() {
			if rec := recover(); rec != nil {
				s.log.Error("panic recovered", "path", r.URL.Path, "panic", rec)
				s.fail(sw, http.StatusInternalServerError, map[string]any{"error": "internal"})
			}
			elapsed := time.Since(start)
			route := r.Pattern
			if route == "" {
				route = "unmatched"
			} else if i := strings.IndexByte(route, ' '); i >= 0 {
				route = route[i+1:]
			}
			status := sw.status
			if status == 0 {
				status = http.StatusOK
			}
			s.metrics.ObserveRequest(route, r.Method, status, elapsed)
			s.log.Info("http",
				"method", r.Method,
				"path", r.URL.Path,
				"status", status,
				"bytes", sw.bytes,
				"duration_ms", elapsed.Milliseconds(),
				"remote", clientIP(r),
			)
		}()

		sw.Header().Set("access-control-allow-origin", "*")
		sw.Header().Set("access-control-allow-headers", "content-type, authorization, x-admin-token")
		sw.Header().Set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			sw.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(sw, r)
	})
}

// --------------------------------------------------------------------- helpers

func (s *Server) writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		s.log.Error("marshal response", "error", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("content-length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (s *Server) fail(w http.ResponseWriter, status int, payload any) {
	s.writeJSON(w, status, payload)
}

func (s *Server) failError(w http.ResponseWriter, err error) {
	var (
		insufficient *store.InsufficientCreditsError
		rejected     *store.AttestRejectedError
		banned       *store.BannedError
	)
	switch {
	case errors.As(err, &insufficient):
		s.fail(w, http.StatusPaymentRequired, map[string]any{
			"error": "insufficient-credits", "need": insufficient.Need, "have": insufficient.Have,
		})
	case errors.As(err, &rejected):
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "attest-rejected", "reason": rejected.Reason})
	case errors.As(err, &banned):
		s.fail(w, http.StatusForbidden, map[string]any{"error": "banned", "reason": banned.Reason})
	case errors.Is(err, store.ErrUnknownPeer):
		s.fail(w, http.StatusNotFound, map[string]any{"error": "unknown-peer"})
	default:
		s.log.Error("request failed", "error", err)
		s.fail(w, http.StatusInternalServerError, map[string]any{"error": "internal", "reason": err.Error()})
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	return dec.Decode(dst)
}

func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("x-forwarded-for"); forwarded != "" {
		return strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) v1Authorized(r *http.Request) bool {
	if s.cfg.Token == "" {
		return true
	}
	header := r.Header.Get("authorization")
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	token = strings.TrimSpace(strings.TrimPrefix(token, "bearer "))
	return subtleEqual(token, s.cfg.Token)
}

func (s *Server) adminAuthorized(r *http.Request) bool {
	if s.cfg.AdminToken == "" {
		return false
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("authorization"), "Bearer "))
	if token == "" {
		token = strings.TrimSpace(r.Header.Get("x-admin-token"))
	}
	return subtleEqual(token, s.cfg.AdminToken)
}

func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// v1 wraps a relay handler with token auth, body limits and rate limiting.
func (s *Server) v1(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.v1Authorized(r) {
			s.fail(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		if s.settingBool(r.Context(), "maintenance_mode", false) {
			s.fail(w, http.StatusServiceUnavailable, map[string]any{"error": "maintenance"})
			return
		}
		next(w, r)
	}
}

// adminOnly gates the operator API.
func (s *Server) adminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AdminToken == "" {
			s.fail(w, http.StatusServiceUnavailable, map[string]any{"error": "admin-disabled"})
			return
		}
		if !s.adminAuthorized(r) {
			s.fail(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

// rateLimited consumes a Redis token; it fails open when Redis is down.
func (s *Server) rateLimited(ctx context.Context, scope, id string, limit int, window time.Duration) bool {
	if s.cache == nil {
		return true
	}
	allowed, retry, err := s.cache.Allow(ctx, scope, id, limit, window)
	if err != nil {
		s.log.Warn("rate limiter unavailable", "error", err)
		return true
	}
	if !allowed {
		s.log.Warn("rate limited", "scope", scope, "id", id, "retry_after", retry.String())
	}
	return allowed
}

// settingBool reads a runtime toggle with a 5s in-process cache.
func (s *Server) settingBool(ctx context.Context, key string, fallback bool) bool {
	s.settingsMu.Lock()
	cached, ok := s.settings[key]
	s.settingsMu.Unlock()
	if ok && time.Now().Before(cached.expires) {
		if b, ok := cached.value.(bool); ok {
			return b
		}
		return fallback
	}
	// Without a store every read would panic. The visit surface is constructed
	// with one in tests, and a missing store must degrade to the default rather
	// than turn every request into a 500.
	value := fallback
	if s.store != nil {
		value = s.store.SettingBool(ctx, key, fallback)
	}
	s.settingsMu.Lock()
	s.settings[key] = settingValue{value: value, expires: time.Now().Add(5 * time.Second)}
	s.settingsMu.Unlock()
	return value
}

// settingInt reads an integer toggle with the same cache.
func (s *Server) settingInt(ctx context.Context, key string, fallback int) int {
	s.settingsMu.Lock()
	cached, ok := s.settings[key]
	s.settingsMu.Unlock()
	if ok && time.Now().Before(cached.expires) {
		if n, ok := cached.value.(int); ok {
			return n
		}
		return fallback
	}
	if s.store == nil {
		return fallback
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return fallback
	}
	value := fallback
	if raw, ok := settings[key]; ok {
		if n, ok := raw.(float64); ok {
			value = int(n)
		}
	}
	s.settingsMu.Lock()
	s.settings[key] = settingValue{value: value, expires: time.Now().Add(5 * time.Second)}
	s.settingsMu.Unlock()
	return value
}
