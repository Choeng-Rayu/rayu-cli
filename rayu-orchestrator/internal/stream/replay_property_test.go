package stream

import (
	"context"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"pgregory.net/rapid"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// Property P3 — SSE replay is complete, ordered, gap-free, and duplicate-free.
//
// For a log of M events and any N in [0, M], replay(N) returns exactly the
// events with Sequence_Number in (N, M] in ascending order; therefore for a
// client that has already rendered 1..N, [1..N] ++ replay(N) == [1..M]; and
// N == 0 (or no Last-Event-ID) returns the entire history. A concurrent
// replay→live-handoff variant asserts that a subscriber resuming at N, while
// events are emitted live, observes exactly (N, M] once, in order — the switch
// from replay to the live tail neither drops nor repeats the boundary event.
//
// Validates: Requirements 9.4, 9.5, 10.3, 10.6
func TestPropertyP3ReplayWindow(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		m := rapid.IntRange(0, 200).Draw(rt, "events")
		h, _ := newHubWithBuild(rt, "b", m)
		ctx := context.Background()

		n := rapid.IntRange(0, m).Draw(rt, "lastEventID")

		got, err := h.Replay(ctx, "b", int64(n))
		if err != nil {
			rt.Fatalf("Replay(%d): %v", n, err)
		}

		// (a) replay(N) == exactly (N, M] ascending.
		if seqs := progressSeqs(got); !equalInt64s(seqs, wantRange(n+1, m)) {
			rt.Fatalf("Replay(%d) seqs = %v, want %v", n, seqs, wantRange(n+1, m))
		}

		// (b) [1..N] ++ replay(N) == [1..M] (no gap, no duplicate).
		full, err := h.Replay(ctx, "b", 0)
		if err != nil {
			rt.Fatalf("Replay(0): %v", err)
		}
		if len(full) != m {
			rt.Fatalf("Replay(0) returned %d events, want %d", len(full), m)
		}
		combined := append(progressSeqs(full[:n]), progressSeqs(got)...)
		if !equalInt64s(combined, wantRange(1, m)) {
			rt.Fatalf("[1..%d] ++ replay(%d) = %v, want 1..%d", n, n, combined, m)
		}

		// (c) N == 0 returns the whole history in order.
		if n == 0 && !equalInt64s(progressSeqs(got), wantRange(1, m)) {
			rt.Fatalf("Replay(0) seqs = %v, want 1..%d", progressSeqs(got), m)
		}
	})
}

// Concurrent replay→live handoff: a subscriber resumes at N while events are
// being emitted; the merged (replay → live-tail) stream it observes must be
// exactly (N, M] once, in ascending order, regardless of where the
// replay/live boundary falls (K).
//
// Validates: Requirements 9.4, 9.5, 10.3, 10.6
func TestPropertyP3ReplayLiveHandoff(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		m := rapid.IntRange(1, 60).Draw(rt, "total")
		n := rapid.IntRange(0, m).Draw(rt, "lastEventID") // client resumes after N
		k := rapid.IntRange(n, m).Draw(rt, "seeded")      // events persisted before connect (N<=K<=M)

		st := store.NewInMemoryStore()
		h := NewHub(st, WithHeartbeatInterval(20*time.Millisecond))
		ctx := context.Background()
		if err := st.CreateBuild(ctx, store.Build{ID: "b", OwnerID: "o", Prompt: "p"}); err != nil {
			rt.Fatalf("CreateBuild: %v", err)
		}

		// Seed K events that exist before the subscriber connects (these are
		// served via replay when K > N).
		emit := func(lo, hi int) {
			for i := lo; i <= hi; i++ {
				if _, err := h.Emit(ctx, "b", KindLog, map[string]any{"i": i}); err != nil {
					rt.Fatalf("Emit %d: %v", i, err)
				}
			}
		}
		emit(1, k)

		rec := newSSERecorder()
		reqCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		req := httptest.NewRequest("GET", "/v1/builds/b/stream", nil).WithContext(reqCtx)
		if n > 0 {
			req.Header.Set("Last-Event-ID", strconv.Itoa(n))
		}

		done := make(chan struct{})
		go func() { defer close(done); h.ServeSSE(rec, req, "b") }()

		// Emit the remaining K+1..M live, concurrently with the reader's replay.
		emit(k+1, m)

		// Drive the build terminal and signal completion so the stream closes.
		if err := st.SetStatus(ctx, "b", store.StatusTerminated); err != nil {
			rt.Fatalf("SetStatus: %v", err)
		}
		h.CloseBuild("b")

		select {
		case <-done:
		case <-time.After(3 * time.Second):
			cancel()
			<-done
			rt.Fatalf("ServeSSE did not close (m=%d n=%d k=%d)", m, n, k)
		}

		msgs, _ := parseSSE(rec.Body())
		got := seqsOfMsgs(rt, msgs)
		if !equalInt64s(got, wantRange(n+1, m)) {
			rt.Fatalf("handoff seqs = %v, want %v (m=%d n=%d k=%d)", got, wantRange(n+1, m), m, n, k)
		}
	})
}
