package rtc

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestSignalRoundsTripToThePeerOnly(t *testing.T) {
	e := NewExchange(nil)
	defer e.Close()

	offer := json.RawMessage(`{"type":"offer","sdp":"v=0"}`)
	if err := e.Post(context.Background(), "v1", "did:a", "did:b", "offer", offer); err != nil {
		t.Fatalf("post: %v", err)
	}

	// The sender must not read its own echo.
	if got := e.Drain(context.Background(), "v1", "did:a"); len(got) != 0 {
		t.Fatalf("sender drained %d signals, want 0", len(got))
	}
	got := e.Drain(context.Background(), "v1", "did:b")
	if len(got) != 1 {
		t.Fatalf("peer drained %d signals, want 1", len(got))
	}
	if got[0].From != "did:a" || got[0].Kind != "offer" {
		t.Fatalf("signal = %+v, want an offer from did:a", got[0])
	}
	if string(got[0].Payload) != string(offer) {
		t.Fatalf("payload = %s, want %s", got[0].Payload, offer)
	}
	// Draining is destructive: a second read is empty.
	if again := e.Drain(context.Background(), "v1", "did:b"); len(again) != 0 {
		t.Fatalf("second drain returned %d signals, want 0", len(again))
	}
}

func TestSignalExpiresAndIsForgotten(t *testing.T) {
	e := NewExchange(nil)
	defer e.Close()

	if err := e.Post(context.Background(), "v2", "did:a", "did:b", "candidate", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("post: %v", err)
	}
	// The clock runs past the TTL between the post and the read.
	e.now = func() time.Time { return time.Now().Add(2 * SignalTTL) }
	if got := e.Drain(context.Background(), "v2", "did:b"); len(got) != 0 {
		t.Fatalf("an expired signal was delivered: %+v", got)
	}
}

func TestSignalRejectsOversizedAndMissingFields(t *testing.T) {
	e := NewExchange(nil)
	defer e.Close()

	big := make([]byte, SignalMaxBytes+1)
	for i := range big {
		big[i] = 'a'
	}
	if err := e.Post(context.Background(), "v3", "did:a", "did:b", "offer", json.RawMessage(big)); err == nil {
		t.Fatal("an oversized signal was accepted")
	}
	if err := e.Post(context.Background(), "", "did:a", "did:b", "offer", json.RawMessage(`{}`)); err == nil {
		t.Fatal("a signal without a visit id was accepted")
	}
	if err := e.Post(context.Background(), "v3", "did:a", "did:b", "", json.RawMessage(`{}`)); err == nil {
		t.Fatal("a signal without a kind was accepted")
	}
}

func TestSignalCapsThePendingQueue(t *testing.T) {
	e := NewExchange(nil)
	defer e.Close()
	for i := 0; i < SignalMaxPending; i++ {
		if err := e.Post(context.Background(), "v4", "did:a", "did:b", "candidate", json.RawMessage(`{}`)); err != nil {
			t.Fatalf("post %d: %v", i, err)
		}
	}
	if err := e.Post(context.Background(), "v4", "did:a", "did:b", "candidate", json.RawMessage(`{}`)); err == nil {
		t.Fatal("the pending cap did not hold")
	}
}

func TestRelayDeliversBothWaysAndSurvivesAFullBuffer(t *testing.T) {
	// Filling the buffer on purpose logs a warning per dropped frame; silence it
	// so the test output stays readable.
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	e := NewExchange(quiet)
	defer e.Close()

	guest := e.OpenRelay("v5", "did:b")
	if e.SendRelay("v5", "did:a", "did:b", "move", json.RawMessage(`{"x":3,"y":9}`)) != true {
		t.Fatal("relay refused a frame")
	}
	select {
	case frame := <-guest:
		if frame.Kind != "move" || string(frame.Payload) != `{"x":3,"y":9}` {
			t.Fatalf("frame = %+v, want the move that was sent", frame)
		}
	case <-time.After(time.Second):
		t.Fatal("relay frame never arrived")
	}

	// Fill the buffer; the exchange must drop rather than block.
	for i := 0; i < 200; i++ {
		e.SendRelay("v5", "did:a", "did:b", "move", json.RawMessage(`{}`))
	}
	e.CloseRelay("v5", "did:a", "did:b")
	if e.SendRelay("v5", "did:a", "did:b", "move", json.RawMessage(`{}`)) != false {
		t.Fatal("a closed relay accepted a frame")
	}
}
