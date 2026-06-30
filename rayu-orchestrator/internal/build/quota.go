package build

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// Quota enforces the two per-user admission limits (Req 17) and maintains the
// explicit active-build accounting required by Req 17.5.
//
// Two distinct requirements drive two distinct mechanisms here:
//
//   - CheckOnCreate (Req 17.1–17.4) decides whether a new build may be created.
//     It reads the AUTHORITATIVE counts from the Store — the owner's active
//     (non-terminal) builds via CountActiveByOwner for the Concurrency_Quota,
//     and the owner's builds created in the trailing 24h via CountCreatedSince
//     for the Daily_Quota — so the decision is correct against persisted state
//     and survives a restart with no in-memory warm-up. It returns the DISTINCT
//     sentinel errors ErrConcurrencyQuotaExceeded and ErrDailyQuotaExceeded so
//     the API can map each to its own 429 error code.
//
//   - Track/Untrack maintain an in-memory tracked active count per owner — the
//     "active count decremented on terminal" accounting of Req 17.5. A build is
//     tracked at creation and untracked exactly once when it reaches a
//     Terminal_Status. Because the tracked set is keyed by Build_Id, Untrack is
//     idempotent (a build can be removed at most once), so the count is
//     decremented exactly once per terminal and can never go negative.
//
// Property P7 ties the two together: driven in lockstep with the Store
// (Track on create, Untrack on terminal), the tracked active count always
// equals the owner's non-terminal builds in the Store.
//
// All methods are safe for concurrent use.
type Quota struct {
	store          store.Store
	maxConcurrency int // PER_USER_CONCURRENCY (Req 17.1)
	maxDaily       int // PER_USER_DAILY (Req 17.3)
	now            func() time.Time

	mu       sync.Mutex
	active   map[string]string // buildID -> ownerID for currently-tracked active builds
	perOwner map[string]int    // ownerID -> tracked active count (== len of its active builds)
}

// ErrConcurrencyQuotaExceeded is returned by CheckOnCreate when the owner
// already has PER_USER_CONCURRENCY active builds (Req 17.1, 17.2). The API maps
// it to 429 with the quota_exceeded code.
var ErrConcurrencyQuotaExceeded = errors.New("build: per-user concurrency quota exceeded")

// ErrDailyQuotaExceeded is returned by CheckOnCreate when the owner has already
// created PER_USER_DAILY builds in the trailing 24h (Req 17.3, 17.4). The API
// maps it to 429 with the daily_quota_exceeded code.
var ErrDailyQuotaExceeded = errors.New("build: per-user daily quota exceeded")

// dailyQuotaWindow is the trailing window the Daily_Quota counts over (Req 17.3).
const dailyQuotaWindow = 24 * time.Hour

// NewQuota returns a Quota backed by st with the given per-user limits.
func NewQuota(st store.Store, maxConcurrency, maxDaily int) *Quota {
	return &Quota{
		store:          st,
		maxConcurrency: maxConcurrency,
		maxDaily:       maxDaily,
		now:            time.Now,
		active:         map[string]string{},
		perOwner:       map[string]int{},
	}
}

// CheckOnCreate reports whether ownerID may create another build right now,
// enforcing the Concurrency_Quota before the Daily_Quota (Req 17.1–17.4). It
// returns nil when both checks pass, ErrConcurrencyQuotaExceeded when the owner
// is at the active-build limit, or ErrDailyQuotaExceeded when the owner is at
// the 24h creation limit. A Store error is surfaced unchanged.
//
// When both limits are breached the concurrency error takes precedence, matching
// the requirement ordering (concurrency is Req 17.1/17.2, daily is 17.3/17.4).
func (q *Quota) CheckOnCreate(ctx context.Context, ownerID string) error {
	activeN, err := q.store.CountActiveByOwner(ctx, ownerID)
	if err != nil {
		return err
	}
	if activeN >= q.maxConcurrency {
		return ErrConcurrencyQuotaExceeded
	}

	since := q.clock().Add(-dailyQuotaWindow)
	dailyN, err := q.store.CountCreatedSince(ctx, ownerID, since)
	if err != nil {
		return err
	}
	if dailyN >= q.maxDaily {
		return ErrDailyQuotaExceeded
	}
	return nil
}

// Track records buildID as an active build owned by ownerID, incrementing the
// owner's tracked active count. It is idempotent: tracking the same build twice
// counts it once, so the tracked count never double-counts a build.
func (q *Quota) Track(ownerID, buildID string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.active[buildID]; ok {
		return
	}
	q.active[buildID] = ownerID
	q.perOwner[ownerID]++
}

// Untrack removes buildID from the active set, decrementing its owner's tracked
// active count — the Req 17.5 decrement-on-terminal step. It is idempotent: a
// build that is not tracked (never tracked, or already untracked) is a no-op, so
// the count is decremented exactly once per build and can never go negative.
func (q *Quota) Untrack(buildID string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	owner, ok := q.active[buildID]
	if !ok {
		return
	}
	delete(q.active, buildID)
	q.perOwner[owner]--
	if q.perOwner[owner] <= 0 {
		delete(q.perOwner, owner)
	}
}

// ActiveCount returns the owner's tracked active-build count. Driven in lockstep
// with the Store it equals the owner's non-terminal builds (Property P7); it is
// also the source for the "active" accounting surfaced to metrics.
func (q *Quota) ActiveCount(ownerID string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.perOwner[ownerID]
}

func (q *Quota) clock() time.Time {
	if q.now != nil {
		return q.now()
	}
	return time.Now()
}
