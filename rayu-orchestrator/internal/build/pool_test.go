package build

import (
	"context"
	"sync"
	"testing"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// admitLog records, in order, the builds the pool admits (via its RunHook), so
// tests can assert which builds were admitted and in what order. The hook does
// NOT spawn a goroutine (unlike the engine's real hook), keeping pool tests
// deterministic and goroutine-free.
type admitLog struct {
	mu  sync.Mutex
	ids []string
}

func (a *admitLog) hook(buildID, _ string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ids = append(a.ids, buildID)
}

func (a *admitLog) list() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.ids))
	copy(out, a.ids)
	return out
}

// newPoolHarness builds a Pool over a fresh InMemoryStore + Machine + recording
// emitter, returning the pieces a test needs to drive and inspect admission.
func newPoolHarness(t *testing.T, maxConcurrent, perUserConcurrency int) (*Pool, *store.InMemoryStore, *recordingEmitter, *admitLog) {
	t.Helper()
	st := store.NewInMemoryStore()
	em := &recordingEmitter{}
	m := NewMachine(st, em)
	log := &admitLog{}
	p := NewPool(context.Background(), m, em, maxConcurrent, perUserConcurrency, log.hook)
	return p, st, em, log
}

// enqueueBuild creates a queued build in the store and enqueues it in the pool,
// mirroring what the engine does on create.
func enqueueBuild(t *testing.T, st *store.InMemoryStore, p *Pool, id, owner string) {
	t.Helper()
	if err := st.CreateBuild(context.Background(), store.Build{ID: id, OwnerID: owner, Status: store.StatusQueued, Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild(%s): %v", id, err)
	}
	p.Enqueue(id, owner)
}

func statusOf(t *testing.T, st *store.InMemoryStore, id string) store.Status {
	t.Helper()
	b, err := st.GetBuild(context.Background(), id)
	if err != nil {
		t.Fatalf("GetBuild(%s): %v", id, err)
	}
	return b.Status
}

// Req 3.1–3.4 — selectAdmissible chooses the longest-queued build whose owner is
// under the per-user cap, returns -1 when the global cap is reached, and skips
// owners at their per-user cap.
func TestSelectAdmissible(t *testing.T) {
	q := func(owners ...string) []queuedBuild {
		out := make([]queuedBuild, len(owners))
		for i, o := range owners {
			out[i] = queuedBuild{buildID: o + "-id", ownerID: o}
		}
		return out
	}

	cases := []struct {
		name               string
		queue              []queuedBuild
		perOwner           map[string]int
		building, max, per int
		want               int
	}{
		{"empty queue", nil, map[string]int{}, 0, 5, 2, -1},
		{"global cap reached", q("o1"), map[string]int{}, 5, 5, 2, -1},
		{"first admissible", q("o1", "o2"), map[string]int{}, 0, 5, 1, 0},
		{"skip owner at cap", q("o1", "o2"), map[string]int{"o1": 1}, 1, 5, 1, 1},
		{"only owner at cap", q("o1"), map[string]int{"o1": 1}, 1, 5, 1, -1},
		{"longest-queued admissible skipping blocked", q("o1", "o1", "o2"), map[string]int{"o1": 1}, 1, 5, 1, 2},
		{"under per-user with two slots", q("o1", "o1"), map[string]int{"o1": 1}, 1, 5, 2, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := selectAdmissible(tc.queue, tc.perOwner, tc.building, tc.max, tc.per); got != tc.want {
				t.Fatalf("selectAdmissible = %d, want %d", got, tc.want)
			}
		})
	}
}

// Req 3.1/3.2/3.3 — the pool admits up to MAX_CONCURRENT_BUILDS in longest-queued
// order, leaves the rest queued, and admits a waiting build when a slot frees.
func TestPoolAdmitsUpToGlobalCapAndReleases(t *testing.T) {
	p, st, _, log := newPoolHarness(t, 2, 10)

	enqueueBuild(t, st, p, "b1", "o1")
	enqueueBuild(t, st, p, "b2", "o1")
	enqueueBuild(t, st, p, "b3", "o1")

	// Two slots → b1, b2 admitted (provisioning); b3 stays queued.
	if p.Building() != 2 {
		t.Fatalf("building = %d, want 2", p.Building())
	}
	if got := log.list(); len(got) != 2 || got[0] != "b1" || got[1] != "b2" {
		t.Fatalf("admitted = %v, want [b1 b2] (longest-queued first)", got)
	}
	if statusOf(t, st, "b1") != store.StatusProvisioning || statusOf(t, st, "b2") != store.StatusProvisioning {
		t.Fatalf("b1/b2 should be provisioning")
	}
	if statusOf(t, st, "b3") != store.StatusQueued {
		t.Fatalf("b3 should still be queued, got %s", statusOf(t, st, "b3"))
	}
	if p.QueueLen() != 1 {
		t.Fatalf("queue len = %d, want 1", p.QueueLen())
	}

	// Free a slot → b3 admitted.
	p.Release("b1")
	if p.Building() != 2 {
		t.Fatalf("after release building = %d, want 2", p.Building())
	}
	if got := log.list(); len(got) != 3 || got[2] != "b3" {
		t.Fatalf("admitted = %v, want b3 admitted on release", got)
	}
	if statusOf(t, st, "b3") != store.StatusProvisioning {
		t.Fatalf("b3 should be provisioning after release")
	}

	// Release is idempotent: releasing a build that holds no slot is a no-op.
	p.Release("b1")
	if p.Building() != 2 {
		t.Fatalf("idempotent release changed building to %d, want 2", p.Building())
	}
}

// Req 3.4 — a build whose owner is at PER_USER_CONCURRENCY stays queued even when
// a global slot is free, while other owners' builds are admitted.
func TestPoolPerUserConcurrencyBlocks(t *testing.T) {
	p, st, _, log := newPoolHarness(t, 10, 1)

	enqueueBuild(t, st, p, "a1", "o1")
	enqueueBuild(t, st, p, "a2", "o1") // o1 already at cap → must stay queued
	enqueueBuild(t, st, p, "b1", "o2")

	if got := log.list(); len(got) != 2 || got[0] != "a1" || got[1] != "b1" {
		t.Fatalf("admitted = %v, want [a1 b1] (a2 blocked by per-user cap)", got)
	}
	if statusOf(t, st, "a2") != store.StatusQueued {
		t.Fatalf("a2 should be queued (owner at per-user cap), got %s", statusOf(t, st, "a2"))
	}
	if p.OwnerBuilding("o1") != 1 {
		t.Fatalf("o1 building = %d, want 1", p.OwnerBuilding("o1"))
	}

	// When o1's slot frees, the blocked build is admitted.
	p.Release("a1")
	if statusOf(t, st, "a2") != store.StatusProvisioning {
		t.Fatalf("a2 should be admitted after o1 frees a slot, got %s", statusOf(t, st, "a2"))
	}
}

// Req 3.5 — while a build remains queued the pool emits a status event carrying
// its queue position, and re-emits when the position advances.
func TestPoolEmitsQueuePosition(t *testing.T) {
	p, st, em, _ := newPoolHarness(t, 1, 10)

	enqueueBuild(t, st, p, "b1", "o1") // admitted immediately (slot free)
	enqueueBuild(t, st, p, "b2", "o1") // queued at position 1
	enqueueBuild(t, st, p, "b3", "o1") // queued at position 2

	// b2 saw position 1; b3 saw position 2.
	if pos := lastQueuePosition(em, "b2"); pos != 1 {
		t.Fatalf("b2 queue position = %d, want 1", pos)
	}
	if pos := lastQueuePosition(em, "b3"); pos != 2 {
		t.Fatalf("b3 queue position = %d, want 2", pos)
	}

	// Freeing the slot admits b2; b3 advances to position 1 and re-emits.
	p.Release("b1")
	if pos := lastQueuePosition(em, "b3"); pos != 1 {
		t.Fatalf("b3 queue position after release = %d, want 1", pos)
	}
}

// Req 1.5 — Remove takes a still-queued build out of the queue (returns true);
// a build that is not queued yields false.
func TestPoolRemoveQueued(t *testing.T) {
	p, st, _, _ := newPoolHarness(t, 1, 10)

	enqueueBuild(t, st, p, "b1", "o1") // admitted
	enqueueBuild(t, st, p, "b2", "o1") // queued

	if !p.Remove("b2") {
		t.Fatalf("Remove(b2) = false, want true (it was queued)")
	}
	if p.QueueLen() != 0 {
		t.Fatalf("queue len = %d, want 0 after removing the only queued build", p.QueueLen())
	}
	// b1 is admitted (not queued) → Remove is false; unknown id → false.
	if p.Remove("b1") {
		t.Fatalf("Remove(b1) = true, want false (already admitted)")
	}
	if p.Remove("nope") {
		t.Fatalf("Remove(nope) = true, want false (unknown)")
	}
}

// lastQueuePosition returns the queuePosition from the most recent queued-status
// event emitted for buildID, or -1 if none. Queue-position events are the
// KindStatus events whose payload carries a queuePosition (distinguishing them
// from the Machine's lifecycle status events).
func lastQueuePosition(em *recordingEmitter, buildID string) int {
	pos := -1
	for _, ev := range em.snapshot() {
		if ev.BuildID != buildID || ev.Kind != stream.KindStatus {
			continue
		}
		if qp, ok := ev.Payload["queuePosition"]; ok {
			if n, ok := qp.(int); ok {
				pos = n
			}
		}
	}
	return pos
}
