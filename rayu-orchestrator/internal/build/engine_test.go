package build

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// counterID is a deterministic Build_Id generator for engine tests (the
// production DNS-safe generator lives in the api package).
func counterID() func() (string, error) {
	var mu sync.Mutex
	n := 0
	return func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		id := fmt.Sprintf("bld-%04d", n)
		n++
		return id, nil
	}
}

// newTestEngine wires an Engine over a fresh InMemoryStore and a real Hub (which
// satisfies the engine's eventStreamer). The caller MUST defer e.Close() to stop
// the per-build owning goroutines.
func newTestEngine(t *testing.T, cfg EngineConfig) (*Engine, *store.InMemoryStore, *stream.Hub) {
	t.Helper()
	st := store.NewInMemoryStore()
	hub := stream.NewHub(st, stream.WithHeartbeatInterval(20*time.Millisecond))
	e := NewEngine(st, hub, cfg, counterID())
	return e, st, hub
}

// Req 1.1 — Create returns a queued build (the create snapshot), persists it, and
// admission advances it to provisioning when a slot is free.
func TestEngineCreate_QueuedThenAdmitted(t *testing.T) {
	e, st, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 5, PerUserConcurrency: 5, PerUserDaily: 100})
	defer e.Close()
	ctx := context.Background()

	b, err := e.Create(ctx, CreateRequest{Prompt: "build a thing", OwnerID: "o"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if b.Status != store.StatusQueued {
		t.Fatalf("create response status = %s, want queued (Req 1.1)", b.Status)
	}
	if b.OwnerID != "o" || b.Prompt != "build a thing" {
		t.Fatalf("create response = %+v", b)
	}
	if b.CreatedAt.IsZero() {
		t.Fatalf("create response createdAt is zero")
	}
	// A free slot admits it synchronously: the persisted status is provisioning.
	if s := statusOf(t, st, b.ID); s != store.StatusProvisioning {
		t.Fatalf("persisted status = %s, want provisioning after admission", s)
	}
	// The owner's active count is tracked.
	if got := e.quota.ActiveCount("o"); got != 1 {
		t.Fatalf("ActiveCount(o) = %d, want 1", got)
	}
}

// Req 17.2 — a create that would exceed PER_USER_CONCURRENCY is rejected with the
// distinct concurrency error and creates no new build.
func TestEngineCreate_ConcurrencyQuota429(t *testing.T) {
	e, st, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 5, PerUserConcurrency: 1, PerUserDaily: 100})
	defer e.Close()
	ctx := context.Background()

	if _, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"}); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	_, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	if !errors.Is(err, ErrConcurrencyQuotaExceeded) {
		t.Fatalf("second Create err = %v, want ErrConcurrencyQuotaExceeded", err)
	}
	// Only one build exists for the owner (the rejected create made no record).
	if n, _ := st.CountCreatedSince(ctx, "o", time.Time{}); n != 1 {
		t.Fatalf("owner has %d builds, want 1 (rejected create left no record)", n)
	}
}

// Req 17.4 — a create that would exceed PER_USER_DAILY is rejected with the
// distinct daily error.
func TestEngineCreate_DailyQuota429(t *testing.T) {
	e, _, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 5, PerUserConcurrency: 5, PerUserDaily: 2})
	defer e.Close()
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if _, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"}); err != nil {
			t.Fatalf("Create #%d: %v", i, err)
		}
	}
	_, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	if !errors.Is(err, ErrDailyQuotaExceeded) {
		t.Fatalf("third Create err = %v, want ErrDailyQuotaExceeded", err)
	}
}

// Req 1.5 — Cancel drives an active (admitted) build to canceled and untracks it.
func TestEngineCancel_Admitted(t *testing.T) {
	e, st, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 5, PerUserConcurrency: 5, PerUserDaily: 100})
	defer e.Close()
	ctx := context.Background()

	b, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := e.Cancel(ctx, b.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if s := statusOf(t, st, b.ID); s != store.StatusCanceled {
		t.Fatalf("status = %s after cancel, want canceled", s)
	}
	if got := e.quota.ActiveCount("o"); got != 0 {
		t.Fatalf("ActiveCount(o) = %d after cancel, want 0", got)
	}
}

// Req 1.5 — Cancel of a still-queued build removes it from the pool (so it is
// never admitted) and drives it to canceled.
func TestEngineCancel_Queued(t *testing.T) {
	// One global slot: the second build for the same owner stays queued.
	e, st, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 1, PerUserConcurrency: 5, PerUserDaily: 100})
	defer e.Close()
	ctx := context.Background()

	b1, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	if err != nil {
		t.Fatalf("Create b1: %v", err)
	}
	b2, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	if err != nil {
		t.Fatalf("Create b2: %v", err)
	}
	// b1 admitted, b2 queued (slot full).
	if s := statusOf(t, st, b2.ID); s != store.StatusQueued {
		t.Fatalf("b2 status = %s, want queued", s)
	}

	if err := e.Cancel(ctx, b2.ID); err != nil {
		t.Fatalf("Cancel b2: %v", err)
	}
	if s := statusOf(t, st, b2.ID); s != store.StatusCanceled {
		t.Fatalf("b2 status = %s after cancel, want canceled", s)
	}
	// b1 is unaffected.
	if s := statusOf(t, st, b1.ID); s != store.StatusProvisioning {
		t.Fatalf("b1 status = %s, want provisioning", s)
	}
}

// Req 2.5 — Cancel of a terminal build returns ErrNotCancelable; unknown returns
// ErrNotFound.
func TestEngineCancel_TerminalAndUnknown(t *testing.T) {
	e, st, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 5, PerUserConcurrency: 5, PerUserDaily: 100})
	defer e.Close()
	ctx := context.Background()

	const id = "bld-terminal"
	if err := st.CreateBuild(ctx, store.Build{ID: id, OwnerID: "o", Status: store.StatusFailed, Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	if err := e.Cancel(ctx, id); !errors.Is(err, ErrNotCancelable) {
		t.Fatalf("Cancel terminal err = %v, want ErrNotCancelable", err)
	}
	if err := e.Cancel(ctx, "bld-missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Cancel unknown err = %v, want ErrNotFound", err)
	}
}

// Req 1.6 — Delete drives an active build to terminated and untracks it; unknown
// returns ErrNotFound.
func TestEngineDelete(t *testing.T) {
	e, st, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 5, PerUserConcurrency: 5, PerUserDaily: 100})
	defer e.Close()
	ctx := context.Background()

	b, err := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := e.Delete(ctx, b.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if s := statusOf(t, st, b.ID); s != store.StatusTerminated {
		t.Fatalf("status = %s after delete, want terminated", s)
	}
	if got := e.quota.ActiveCount("o"); got != 0 {
		t.Fatalf("ActiveCount(o) = %d after delete, want 0", got)
	}
	if err := e.Delete(ctx, "bld-missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Delete unknown err = %v, want ErrNotFound", err)
	}
}

// When a build is admitted and then canceled, the freed slot admits the next
// queued build (the per-build goroutine releases its slot on cancel).
func TestEngineCancelFreesSlotForQueued(t *testing.T) {
	e, st, _ := newTestEngine(t, EngineConfig{MaxConcurrentBuilds: 1, PerUserConcurrency: 5, PerUserDaily: 100})
	defer e.Close()
	ctx := context.Background()

	b1, _ := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	b2, _ := e.Create(ctx, CreateRequest{Prompt: "p", OwnerID: "o"})
	if s := statusOf(t, st, b2.ID); s != store.StatusQueued {
		t.Fatalf("b2 status = %s, want queued", s)
	}

	if err := e.Cancel(ctx, b1.ID); err != nil {
		t.Fatalf("Cancel b1: %v", err)
	}
	// b1's goroutine releases its slot asynchronously; the next queued build is
	// then admitted. Wait briefly for the cascade to settle.
	if !eventually(2*time.Second, func() bool {
		return statusOf(t, st, b2.ID) == store.StatusProvisioning
	}) {
		t.Fatalf("b2 status = %s, want provisioning after b1 canceled freed a slot", statusOf(t, st, b2.ID))
	}
}

// eventually polls cond until it is true or the timeout elapses.
func eventually(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return cond()
}
