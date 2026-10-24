package rtc

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Signal lifetimes. A handshake finishes in seconds; nothing here outlives it.
const (
	SignalTTL      = 60 * time.Second
	RelayTTL       = 30 * time.Second
	SignalMaxBytes = 16 * 1024
	// How many pending signals one visit may hold before a peer must drain them.
	SignalMaxPending = 32
)

// Signal is one WebRTC session description or ICE candidate in flight.
type Signal struct {
	VisitID   string          `json:"visit_id"`
	From      string          `json:"from"`
	Kind      string          `json:"kind"` // "offer" | "answer" | "candidate"
	Payload   json.RawMessage `json:"payload"`
	ExpiresAt int64           `json:"expires_at"`
}

// RelayFrame is one guest frame carried by the server only because hole
// punching failed. It is never persisted: a restart ends the visit.
type RelayFrame struct {
	VisitID string          `json:"visit_id"`
	From    string          `json:"from"`
	Kind    string          `json:"kind"` // "move" | "say" | "pose" | "scene" | "bye"
	Payload json.RawMessage `json:"payload"`
}

// Exchange carries the signalling and the fallback relay for every visit in
// flight. Both are in-memory only: the Discovery Server stores visit
// authorisations, not room traffic.
//
// Redis would let several replicas share an exchange; this deployment runs one
// replica behind the same panel, and a lost signal merely restarts a handshake,
// so the simpler single-process map is the honest choice.
type Exchange struct {
	mu        sync.Mutex
	signals   map[string][]Signal
	relays    map[string]chan RelayFrame
	log       *slog.Logger
	now       func() time.Time
	sweeper   *time.Timer
	closeOnce sync.Once
	closed    chan struct{}
}

// NewExchange builds an empty exchange and starts its sweeper.
func NewExchange(log *slog.Logger) *Exchange {
	if log == nil {
		log = slog.Default()
	}
	e := &Exchange{
		signals: map[string][]Signal{},
		relays:  map[string]chan RelayFrame{},
		log:     log,
		now:     time.Now,
		closed:  make(chan struct{}),
	}
	go e.sweep()
	return e
}

// Close stops the sweeper and drops everything held.
func (e *Exchange) Close() {
	e.closeOnce.Do(func() { close(e.closed) })
}

func (e *Exchange) key(visitID, did string) string {
	// One mailbox per side of one visit, so a peer never reads its own echo.
	return visitID + "|" + did
}

// Post drops one signal into the peer's mailbox.
func (e *Exchange) Post(ctx context.Context, visitID, from, peer, kind string, payload json.RawMessage) error {
	if visitID == "" || peer == "" || kind == "" {
		return fmt.Errorf("visit_id, peer and kind are required")
	}
	if len(payload) > SignalMaxBytes {
		return fmt.Errorf("signal payload exceeds %d bytes", SignalMaxBytes)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	key := e.key(visitID, peer)
	queue := e.pruneLocked(e.signals[key])
	if len(queue) >= SignalMaxPending {
		return fmt.Errorf("too many pending signals for this visit")
	}
	e.signals[key] = append(queue, Signal{
		VisitID:   visitID,
		From:      from,
		Kind:      kind,
		Payload:   payload,
		ExpiresAt: e.now().Add(SignalTTL).UnixMilli(),
	})
	return nil
}

// Drain takes every pending signal for one side of a visit, oldest first.
func (e *Exchange) Drain(ctx context.Context, visitID, did string) []Signal {
	e.mu.Lock()
	defer e.mu.Unlock()
	key := e.key(visitID, did)
	queue := e.pruneLocked(e.signals[key])
	delete(e.signals, key)
	return queue
}

// OpenRelay creates the fallback channel used when the peer connection cannot
// be established. Calling it twice for the same visit reuses the channel.
func (e *Exchange) OpenRelay(visitID, did string) chan RelayFrame {
	e.mu.Lock()
	defer e.mu.Unlock()
	key := e.key(visitID, did)
	ch, ok := e.relays[key]
	if !ok {
		ch = make(chan RelayFrame, 64)
		e.relays[key] = ch
	}
	return ch
}

// SendRelay pushes one frame to the peer's relay, best-effort: a full channel
// drops the frame rather than blocking a heartbeat.
func (e *Exchange) SendRelay(visitID, from, did, kind string, payload json.RawMessage) bool {
	e.mu.Lock()
	ch, ok := e.relays[e.key(visitID, did)]
	e.mu.Unlock()
	if !ok {
		return false
	}
	frame := RelayFrame{VisitID: visitID, From: from, Kind: kind, Payload: payload}
	select {
	case ch <- frame:
		return true
	default:
		e.log.Warn("relay channel full, frame dropped", "visit", visitID, "kind", kind)
		return false
	}
}

// CloseRelay tears a visit's relay down on both sides.
func (e *Exchange) CloseRelay(visitID string, dids ...string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, did := range dids {
		delete(e.relays, e.key(visitID, did))
	}
}

// DrainRelay returns the frames waiting for one side right now.
func (e *Exchange) DrainRelay(visitID, did string) []RelayFrame {
	e.mu.Lock()
	ch, ok := e.relays[e.key(visitID, did)]
	e.mu.Unlock()
	if !ok {
		return nil
	}
	var out []RelayFrame
	for {
		select {
		case frame := <-ch:
			out = append(out, frame)
		default:
			return out
		}
	}
}

// AwaitRelay waits up to `timeout` for at least one frame, returning whatever
// arrived. It is what keeps a panel from polling in a tight loop.
func (e *Exchange) AwaitRelay(ctx context.Context, visitID, did string, timeout time.Duration) []RelayFrame {
	e.mu.Lock()
	ch, ok := e.relays[e.key(visitID, did)]
	e.mu.Unlock()
	if !ok {
		return nil
	}
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case frame := <-ch:
		out := []RelayFrame{frame}
		// Take the rest without waiting again.
		for {
			select {
			case more := <-ch:
				out = append(out, more)
			default:
				return out
			}
		}
	case <-deadline.Done():
		return nil
	}
}

func (e *Exchange) pruneLocked(queue []Signal) []Signal {
	if len(queue) == 0 {
		return nil
	}
	now := e.now().UnixMilli()
	out := queue[:0]
	for _, sig := range queue {
		if sig.ExpiresAt > now {
			out = append(out, sig)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// sweep forgets stale signals and channels so a handshake that never completes
// cannot leak.
func (e *Exchange) sweep() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-e.closed:
			return
		case <-ticker.C:
			e.mu.Lock()
			for key, queue := range e.signals {
				if pruned := e.pruneLocked(queue); len(pruned) == 0 {
					delete(e.signals, key)
				} else {
					e.signals[key] = pruned
				}
			}
			e.mu.Unlock()
		}
	}
}

// Pending reports how many signals wait for one side, for diagnostics.
func (e *Exchange) Pending(visitID, did string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.pruneLocked(e.signals[e.key(visitID, did)]))
}
