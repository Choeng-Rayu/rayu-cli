package stream

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// Req 8.8, 9.1, 9.2 — Emit persists each event with the next gap-free
// Sequence_Number BEFORE returning, and the returned ProgressEvent carries that
// Seq and the supplied kind/payload.
func TestEmitPersistsAndAssignsSeq(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)
	ctx := context.Background()
	if err := st.CreateBuild(ctx, store.Build{ID: "b", OwnerID: "o", Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}

	for i := 1; i <= 3; i++ {
		pe, err := h.Emit(ctx, "b", KindLog, map[string]any{"n": i})
		if err != nil {
			t.Fatalf("Emit: %v", err)
		}
		if pe.Seq != int64(i) {
			t.Errorf("Emit #%d Seq = %d, want %d", i, pe.Seq, i)
		}
		if pe.BuildID != "b" || pe.Kind != KindLog {
			t.Errorf("Emit #%d header = %+v", i, pe)
		}
		if pe.Ts.IsZero() {
			t.Errorf("Emit #%d Ts not set", i)
		}
	}

	// The events were durably appended in order with seqs 1..3.
	evs, err := st.ReadEvents(ctx, "b", 0)
	if err != nil {
		t.Fatalf("ReadEvents: %v", err)
	}
	if len(evs) != 3 {
		t.Fatalf("persisted %d events, want 3", len(evs))
	}
	for i, ev := range evs {
		if ev.Seq != int64(i+1) {
			t.Errorf("event[%d].Seq = %d, want %d", i, ev.Seq, i+1)
		}
	}
}

// Req 18.3 — the redaction hook is applied to the serialized payload before it
// is persisted AND before it is delivered: the secret appears in neither the
// stored bytes nor the returned event, and the redactor receives the build id.
func TestEmitRoutesPayloadThroughRedactor(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)
	ctx := context.Background()
	if err := st.CreateBuild(ctx, store.Build{ID: "b", OwnerID: "o", Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}

	var gotBuildID string
	h.SetRedactor(func(buildID, s string) string {
		gotBuildID = buildID
		return strings.ReplaceAll(s, "SEKRET", "[REDACTED]")
	})

	pe, err := h.Emit(ctx, "b", KindLog, map[string]any{"text": "my SEKRET key"})
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	if gotBuildID != "b" {
		t.Errorf("redactor got buildID %q, want b", gotBuildID)
	}
	if got, _ := pe.Payload["text"].(string); got != "my [REDACTED] key" {
		t.Errorf("delivered payload text = %q, want redacted", got)
	}

	evs, err := st.ReadEvents(ctx, "b", 0)
	if err != nil {
		t.Fatalf("ReadEvents: %v", err)
	}
	if strings.Contains(string(evs[0].Payload), "SEKRET") {
		t.Errorf("persisted payload still contains the secret: %s", evs[0].Payload)
	}
	if !strings.Contains(string(evs[0].Payload), "[REDACTED]") {
		t.Errorf("persisted payload missing redaction marker: %s", evs[0].Payload)
	}
}

// A nil/empty payload is persisted and re-read without error.
func TestEmitEmptyPayload(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)
	ctx := context.Background()
	if err := st.CreateBuild(ctx, store.Build{ID: "b", OwnerID: "o", Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	pe, err := h.Emit(ctx, "b", KindStatus, nil)
	if err != nil {
		t.Fatalf("Emit(nil payload): %v", err)
	}
	if pe.Seq != 1 {
		t.Errorf("Seq = %d, want 1", pe.Seq)
	}
	evs, err := st.ReadEvents(ctx, "b", 0)
	if err != nil || len(evs) != 1 {
		t.Fatalf("ReadEvents: %v len=%d", err, len(evs))
	}
	// The stored payload must be valid JSON.
	var v interface{}
	if err := json.Unmarshal(evs[0].Payload, &v); err != nil {
		t.Errorf("stored payload is not valid JSON: %q (%v)", evs[0].Payload, err)
	}
}

// Emitting for an unknown build surfaces the store's not-found error and
// persists nothing.
func TestEmitUnknownBuild(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)
	if _, err := h.Emit(context.Background(), "missing", KindLog, map[string]any{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Emit(missing) err = %v, want ErrNotFound", err)
	}
}

// Req 9.4, 10.3 — Replay returns events with Seq > afterSeq in ascending order;
// afterSeq 0 returns the full history; afterSeq == latest returns nothing.
func TestReplayWindow(t *testing.T) {
	h, _ := newHubWithBuild(t, "b", 5)
	ctx := context.Background()

	all, err := h.Replay(ctx, "b", 0)
	if err != nil {
		t.Fatalf("Replay(0): %v", err)
	}
	if got := progressSeqs(all); !equalInt64s(got, wantRange(1, 5)) {
		t.Errorf("Replay(0) seqs = %v, want 1..5", got)
	}

	mid, err := h.Replay(ctx, "b", 2)
	if err != nil {
		t.Fatalf("Replay(2): %v", err)
	}
	if got := progressSeqs(mid); !equalInt64s(got, wantRange(3, 5)) {
		t.Errorf("Replay(2) seqs = %v, want 3..5", got)
	}

	none, err := h.Replay(ctx, "b", 5)
	if err != nil {
		t.Fatalf("Replay(5): %v", err)
	}
	if len(none) != 0 {
		t.Errorf("Replay(5) = %v, want empty", progressSeqs(none))
	}
}

// The in-memory subscriber registry adds on subscribe, removes on unsubscribe,
// and CloseBuild closes each subscriber's done channel exactly once.
func TestSubscriberRegistryLifecycle(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)

	if n := h.subscriberCount("b"); n != 0 {
		t.Fatalf("initial count = %d, want 0", n)
	}
	s1 := h.subscribe("b")
	s2 := h.subscribe("b")
	if n := h.subscriberCount("b"); n != 2 {
		t.Fatalf("after 2 subscribe count = %d, want 2", n)
	}

	h.CloseBuild("b")
	for _, s := range []*subscriber{s1, s2} {
		select {
		case <-s.done:
		default:
			t.Fatal("CloseBuild did not close subscriber done channel")
		}
	}
	// CloseBuild is idempotent (no double-close panic).
	h.CloseBuild("b")

	h.unsubscribe("b", s1)
	h.unsubscribe("b", s2)
	if n := h.subscriberCount("b"); n != 0 {
		t.Fatalf("after unsubscribe count = %d, want 0", n)
	}
}

// notify wakes a subscriber and never blocks, even when the wake buffer is
// already full (coalescing).
func TestNotifyIsNonBlockingAndCoalesces(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)
	s := h.subscribe("b")

	// Three notifies with no reader must not block; the buffered-1 channel holds
	// exactly one pending wake.
	h.notify("b")
	h.notify("b")
	h.notify("b")

	select {
	case <-s.wake:
	default:
		t.Fatal("expected a pending wake")
	}
	select {
	case <-s.wake:
		t.Fatal("wake should coalesce to a single pending signal")
	default:
	}
}

func progressSeqs(evs []ProgressEvent) []int64 {
	out := make([]int64, 0, len(evs))
	for _, e := range evs {
		out = append(out, e.Seq)
	}
	return out
}
