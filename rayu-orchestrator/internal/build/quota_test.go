package build

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// newQuotaWithClock builds a Quota over a fresh InMemoryStore with a fixed clock
// so the trailing-24h Daily_Quota window is deterministic.
func newQuotaWithClock(t *testing.T, maxConcurrency, maxDaily int, now time.Time) (*Quota, *store.InMemoryStore) {
	t.Helper()
	st := store.NewInMemoryStore()
	q := NewQuota(st, maxConcurrency, maxDaily)
	q.now = func() time.Time { return now }
	return q, st
}

// seedBuild creates a build for owner with the given status and creation time so
// the owner-scoped store counts are populated for the quota checks.
func seedBuild(t *testing.T, st *store.InMemoryStore, id, owner string, status store.Status, createdAt time.Time) {
	t.Helper()
	if err := st.CreateBuild(context.Background(), store.Build{
		ID: id, OwnerID: owner, Status: status, Prompt: "p", CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("CreateBuild(%s): %v", id, err)
	}
}

// Req 17.1/17.2 — concurrency: at PER_USER_CONCURRENCY active builds, a create is
// rejected with the distinct concurrency error; under the limit it passes.
func TestQuotaCheckOnCreate_Concurrency(t *testing.T) {
	now := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	// High daily limit so only concurrency can trip.
	q, st := newQuotaWithClock(t, 2, 1000, now)
	ctx := context.Background()

	// 0 active → allowed.
	if err := q.CheckOnCreate(ctx, "o"); err != nil {
		t.Fatalf("0 active: err = %v, want nil", err)
	}

	seedBuild(t, st, "b1", "o", store.StatusBuilding, now)
	if err := q.CheckOnCreate(ctx, "o"); err != nil {
		t.Fatalf("1 active: err = %v, want nil", err)
	}

	seedBuild(t, st, "b2", "o", store.StatusQueued, now)
	if err := q.CheckOnCreate(ctx, "o"); !errors.Is(err, ErrConcurrencyQuotaExceeded) {
		t.Fatalf("2 active: err = %v, want ErrConcurrencyQuotaExceeded", err)
	}

	// A terminal build does not count toward concurrency, so dropping one active
	// build to terminal re-opens a slot.
	if err := st.SetStatus(ctx, "b2", store.StatusFailed); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if err := q.CheckOnCreate(ctx, "o"); err != nil {
		t.Fatalf("after one terminal: err = %v, want nil", err)
	}

	// A different owner is unaffected by o's active builds.
	if err := q.CheckOnCreate(ctx, "other"); err != nil {
		t.Fatalf("other owner: err = %v, want nil", err)
	}
}

// Req 17.3/17.4 — daily: at PER_USER_DAILY builds created in the trailing 24h, a
// create is rejected with the distinct daily error. Terminal builds still count
// toward the daily window (it counts creations, not active builds), and builds
// created more than 24h ago fall out of the window.
func TestQuotaCheckOnCreate_Daily(t *testing.T) {
	now := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	// High concurrency limit so only the daily window can trip.
	q, st := newQuotaWithClock(t, 1000, 3, now)
	ctx := context.Background()

	// Three terminal builds created within the last 24h: concurrency is 0 but the
	// daily creation count is 3.
	seedBuild(t, st, "d1", "o", store.StatusFailed, now.Add(-1*time.Hour))
	seedBuild(t, st, "d2", "o", store.StatusCanceled, now.Add(-5*time.Hour))
	seedBuild(t, st, "d3", "o", store.StatusTerminated, now.Add(-23*time.Hour))

	if err := q.CheckOnCreate(ctx, "o"); !errors.Is(err, ErrDailyQuotaExceeded) {
		t.Fatalf("3 created in 24h: err = %v, want ErrDailyQuotaExceeded", err)
	}

	// A second owner whose creations are all older than the 24h window is under
	// the daily limit (the window counts creations within the trailing 24h only).
	seedBuild(t, st, "old1", "p", store.StatusFailed, now.Add(-25*time.Hour))
	seedBuild(t, st, "old2", "p", store.StatusFailed, now.Add(-48*time.Hour))
	if err := q.CheckOnCreate(ctx, "p"); err != nil {
		t.Fatalf("owner p (all creations older than 24h): err = %v, want nil", err)
	}
}

// Req 17.1–17.4 — when BOTH limits are breached, the concurrency error takes
// precedence (it is the requirement-ordered first check).
func TestQuotaCheckOnCreate_ConcurrencyPrecedence(t *testing.T) {
	now := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	q, st := newQuotaWithClock(t, 2, 2, now)
	ctx := context.Background()

	seedBuild(t, st, "b1", "o", store.StatusBuilding, now)
	seedBuild(t, st, "b2", "o", store.StatusDeploying, now)
	// active = 2 (>=2) AND daily = 2 (>=2): both breached.
	if err := q.CheckOnCreate(ctx, "o"); !errors.Is(err, ErrConcurrencyQuotaExceeded) {
		t.Fatalf("both breached: err = %v, want ErrConcurrencyQuotaExceeded (precedence)", err)
	}
}

// Req 17.5 — the tracked active count increments on Track, decrements exactly
// once on Untrack, is idempotent under repeated Track/Untrack, and never goes
// negative.
func TestQuotaTrackUntrackAccounting(t *testing.T) {
	q := NewQuota(store.NewInMemoryStore(), 100, 100)

	if got := q.ActiveCount("o"); got != 0 {
		t.Fatalf("initial ActiveCount = %d, want 0", got)
	}

	q.Track("o", "b1")
	q.Track("o", "b2")
	if got := q.ActiveCount("o"); got != 2 {
		t.Fatalf("after 2 Track: ActiveCount = %d, want 2", got)
	}

	// Track is idempotent: re-tracking b1 must not double-count.
	q.Track("o", "b1")
	if got := q.ActiveCount("o"); got != 2 {
		t.Fatalf("after duplicate Track: ActiveCount = %d, want 2", got)
	}

	q.Untrack("b1")
	if got := q.ActiveCount("o"); got != 1 {
		t.Fatalf("after Untrack b1: ActiveCount = %d, want 1", got)
	}

	// Untrack is idempotent: untracking b1 again is a no-op (exactly-once decrement).
	q.Untrack("b1")
	if got := q.ActiveCount("o"); got != 1 {
		t.Fatalf("after duplicate Untrack: ActiveCount = %d, want 1", got)
	}

	// Untracking an unknown build never drives the count negative.
	q.Untrack("never-tracked")
	if got := q.ActiveCount("o"); got != 1 {
		t.Fatalf("after Untrack unknown: ActiveCount = %d, want 1", got)
	}

	q.Untrack("b2")
	if got := q.ActiveCount("o"); got != 0 {
		t.Fatalf("after Untrack b2: ActiveCount = %d, want 0", got)
	}
}
