package api

import (
	"encoding/json"
	"net/http"
	"time"

	"cradle.local/server/internal/protocol"
	"cradle.local/server/internal/rtc"
)

// The visit surface is deliberately thin.
//
// Everything that decides whether a visit may happen travels the normal
// `/v1/send` path as a signed VISIT envelope, so it is priced, journalled and
// gated exactly like any other primitive. These endpoints only carry the
// WebRTC handshake and the last-resort relay — never durable state. A restart
// drops them all and every visit in flight simply ends.

type postSignalRequest struct {
	VisitID string          `json:"visit_id"`
	From    string          `json:"from"`
	Peer    string          `json:"peer"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

type drainSignalRequest struct {
	VisitID string `json:"visit_id"`
	Did     string `json:"did"`
}

// handleSignalPost accepts one offer, answer or ICE candidate for a peer.
func (s *Server) handleSignalPost(w http.ResponseWriter, r *http.Request) {
	if s.exchange == nil {
		s.fail(w, http.StatusServiceUnavailable, map[string]any{"error": "visit-unavailable"})
		return
	}
	var body postSignalRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if !protocol.IsDid(body.From) || !protocol.IsDid(body.Peer) {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "from and peer must be did:key values"})
		return
	}
	if body.From == body.Peer {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "peer must differ from the sender"})
		return
	}
	if body.Kind != "offer" && body.Kind != "answer" && body.Kind != "candidate" {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "kind must be offer, answer or candidate"})
		return
	}
	if !s.rateLimited(r.Context(), "signal", body.From, 240, time.Minute) {
		s.fail(w, http.StatusTooManyRequests, map[string]any{"error": "rate-limited"})
		return
	}
	if err := s.exchange.Post(r.Context(), body.VisitID, body.From, body.Peer, body.Kind, body.Payload); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "signal-rejected", "reason": err.Error()})
		return
	}
	s.metrics.Incr("signal.post", 1)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "serverTime": time.Now().UnixMilli()})
}

// handleSignalDrain returns and clears the signals waiting for one side.
func (s *Server) handleSignalDrain(w http.ResponseWriter, r *http.Request) {
	if s.exchange == nil {
		s.fail(w, http.StatusServiceUnavailable, map[string]any{"error": "visit-unavailable"})
		return
	}
	var body drainSignalRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if !protocol.IsDid(body.Did) {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "did must be a did:key"})
		return
	}
	signals := s.exchange.Drain(r.Context(), body.VisitID, body.Did)
	if signals == nil {
		signals = []rtc.Signal{}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"signals":    signals,
		"serverTime": time.Now().UnixMilli(),
	})
}

type relayRequest struct {
	VisitID string          `json:"visit_id"`
	From    string          `json:"from"`
	Peer    string          `json:"peer"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
	Close   bool            `json:"close"`
}

// handleRelaySend pushes one frame to a peer that could not be reached
// directly. The frame is kept in memory only.
func (s *Server) handleRelaySend(w http.ResponseWriter, r *http.Request) {
	if s.exchange == nil {
		s.fail(w, http.StatusServiceUnavailable, map[string]any{"error": "visit-unavailable"})
		return
	}
	var body relayRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if !protocol.IsDid(body.From) || !protocol.IsDid(body.Peer) {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "from and peer must be did:key values"})
		return
	}
	if !s.rateLimited(r.Context(), "relay", body.From, 600, time.Minute) {
		s.fail(w, http.StatusTooManyRequests, map[string]any{"error": "rate-limited"})
		return
	}
	if body.Close {
		s.exchange.CloseRelay(body.VisitID, body.From, body.Peer)
		s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "serverTime": time.Now().UnixMilli()})
		return
	}
	if body.Kind != "move" && body.Kind != "say" && body.Kind != "pose" && body.Kind != "scene" && body.Kind != "bye" {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "kind must be move, say, pose, scene or bye"})
		return
	}
	// Ensure the peer's channel exists so a frame posted before it polls is not
	// silently lost; the relay is opened by whoever arrives first.
	s.exchange.OpenRelay(body.VisitID, body.Peer)
	delivered := s.exchange.SendRelay(body.VisitID, body.From, body.Peer, body.Kind, body.Payload)
	if delivered {
		s.metrics.Incr("relay.frame", 1)
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"delivered": delivered, "serverTime": time.Now().UnixMilli()})
}

// handleRelayPoll returns the frames that arrived since the last poll. It holds
// the request for a short time so a panel does not spin.
func (s *Server) handleRelayPoll(w http.ResponseWriter, r *http.Request) {
	if s.exchange == nil {
		s.fail(w, http.StatusServiceUnavailable, map[string]any{"error": "visit-unavailable"})
		return
	}
	var body drainSignalRequest
	if err := decodeJSON(w, r, &body, s.cfg.MaxBodyBytes); err != nil {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "invalid-json"})
		return
	}
	if !protocol.IsDid(body.Did) {
		s.fail(w, http.StatusBadRequest, map[string]any{"error": "did must be a did:key"})
		return
	}

	frames := s.exchange.DrainRelay(body.VisitID, body.Did)
	if len(frames) == 0 {
		// Wait briefly for one frame, then answer with whatever arrived.
		frames = s.exchange.AwaitRelay(r.Context(), body.VisitID, body.Did, 8*time.Second)
	}
	if frames == nil {
		frames = []rtc.RelayFrame{}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"frames":     frames,
		"serverTime": time.Now().UnixMilli(),
	})
}
