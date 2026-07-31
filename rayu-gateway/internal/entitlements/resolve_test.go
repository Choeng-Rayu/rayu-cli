package entitlements

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// Per-user resolution is on the hot path of every hosted request: it decides the
// plan, the usable models and the top-up balance. These tests pin the three
// properties that keep it both fast and honest — one database read per burst, a
// catalog change visible on the next request, and no unbounded growth.

// countingUserStore is the three per-user queries with a call counter, standing in
// for MySQL. Each Resolve miss is three sequential round-trips in production.
type countingUserStore struct {
	mu       sync.Mutex
	calls    atomic.Int64
	status   string
	plan     *store.Plan
	topup    int64
	err      error
	block    chan struct{} // when non-nil, reads wait on it (to line up a burst)
	entered  chan struct{} // signalled once a read has started
	blockOne sync.Once
}

func (s *countingUserStore) UserStatus(context.Context, int64) (string, error) {
	s.calls.Add(1)
	if s.entered != nil {
		s.blockOne.Do(func() { s.entered <- struct{}{} })
	}
	if s.block != nil {
		<-s.block
	}
	if s.err != nil {
		return "", s.err
	}
	return s.status, nil
}

func (s *countingUserStore) ActivePlan(context.Context, int64, time.Time) (*store.Plan, *time.Time, error) {
	if s.err != nil {
		return nil, nil, s.err
	}
	return s.plan, nil, nil
}

func (s *countingUserStore) TopupBalance(context.Context, int64) (int64, error) {
	if s.err != nil {
		return 0, s.err
	}
	return s.topup, nil
}

func userCache(t *testing.T, us userStore, ttl time.Duration, models []store.HostedModel) *Cache {
	t.Helper()
	c := New(nil, time.Minute, ttl, providercfg.Options{}, nil, nil).withUserStore(us)
	c.mu.Lock()
	c.models = models
	c.mu.Unlock()
	return c
}

func proModel(code string, enabled bool) store.HostedModel {
	return store.HostedModel{
		Code: code, Label: code, ProviderID: 1, UpstreamModelID: code,
		Enabled: enabled, AllowedPlanCodes: []string{"pro"},
	}
}

// A burst of requests from one user (the agent loop fires side queries alongside
// the main turn) must cost ONE resolve, not one per request: each miss is three
// sequential MySQL round-trips against a shared pool.
func TestResolveCollapsesAConcurrentBurst(t *testing.T) {
	us := &countingUserStore{
		status: "active", plan: &store.Plan{Code: "pro"}, topup: 5,
		block: make(chan struct{}), entered: make(chan struct{}, 1),
	}
	c := userCache(t, us, time.Minute, []store.HostedModel{proModel("m1", true)})

	// Start one resolve and wait until it is genuinely inside the store, so the
	// others cannot race ahead and start their own.
	var wg sync.WaitGroup
	results := make([]Entitlement, 8)
	errs := make([]error, 8)
	wg.Add(1)
	go func() {
		defer wg.Done()
		results[0], errs[0] = c.Resolve(context.Background(), 7)
	}()
	<-us.entered

	for i := 1; i < len(results); i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = c.Resolve(context.Background(), 7)
		}(i)
	}
	time.Sleep(50 * time.Millisecond)
	close(us.block)
	wg.Wait()

	if got := us.calls.Load(); got != 1 {
		t.Fatalf("UserStatus calls=%d, want 1 — a burst must share one resolve", got)
	}
	for i := range results {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		if results[i].Plan.Code != "pro" || results[i].TopupBalance != 5 {
			t.Errorf("caller %d got %+v", i, results[i])
		}
	}
}

// Different users must NOT be serialised behind each other — the dedupe is per
// user, not global.
func TestResolveDoesNotSerialiseDifferentUsers(t *testing.T) {
	us := &countingUserStore{status: "active", plan: &store.Plan{Code: "pro"}}
	c := userCache(t, us, time.Minute, nil)

	for _, uid := range []int64{1, 2, 3} {
		if _, err := c.Resolve(context.Background(), uid); err != nil {
			t.Fatalf("user %d: %v", uid, err)
		}
	}
	if got := us.calls.Load(); got != 3 {
		t.Fatalf("calls=%d, want 3 (one per distinct user)", got)
	}
}

// THE FRESHNESS FIX: the allowed-model list must come from the live snapshot, not
// from whatever it was when the user's entry was cached. Otherwise enabling a model
// in the dashboard waits for the config refresh AND then this user's TTL, and the
// model stays "not available on your plan" in the meantime.
func TestResolveSeesACatalogChangeWithinTheUserTTL(t *testing.T) {
	us := &countingUserStore{status: "active", plan: &store.Plan{Code: "pro"}}
	c := userCache(t, us, time.Hour, []store.HostedModel{proModel("m1", true)})

	first, err := c.Resolve(context.Background(), 7)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(first.AllowedModels) != 1 {
		t.Fatalf("allowed=%d, want 1", len(first.AllowedModels))
	}

	// The admin adds a model and enables it; the config snapshot picks it up.
	c.mu.Lock()
	c.models = []store.HostedModel{proModel("m1", true), proModel("m2", true)}
	c.mu.Unlock()

	second, err := c.Resolve(context.Background(), 7)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(second.AllowedModels) != 2 {
		t.Fatalf("allowed=%d, want 2 — the new model must be usable immediately", len(second.AllowedModels))
	}
	// …and that must not have cost another database read: the plan is still cached.
	if got := us.calls.Load(); got != 1 {
		t.Errorf("calls=%d, want 1 — freshness must not come from re-querying the user", got)
	}

	// Disabling one is visible the same way.
	c.mu.Lock()
	c.models = []store.HostedModel{proModel("m1", true), proModel("m2", false)}
	c.mu.Unlock()
	third, _ := c.Resolve(context.Background(), 7)
	if len(third.AllowedModels) != 1 {
		t.Fatalf("allowed=%d after disabling m2, want 1", len(third.AllowedModels))
	}
}

// An expired entry must be re-read, not served stale.
func TestResolveRefreshesAfterTheTTL(t *testing.T) {
	us := &countingUserStore{status: "active", plan: &store.Plan{Code: "pro"}}
	c := userCache(t, us, time.Millisecond, nil)

	if _, err := c.Resolve(context.Background(), 7); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	us.status = "suspended"
	got, err := c.Resolve(context.Background(), 7)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Status != "suspended" || got.Active() {
		t.Fatalf("status=%q active=%v, want the re-read value", got.Status, got.Active())
	}
	if n := us.calls.Load(); n != 2 {
		t.Errorf("calls=%d, want 2", n)
	}
}

// A failed resolve must not be cached (the next request should retry) and must
// reach every waiter in the burst.
func TestResolveDoesNotCacheFailures(t *testing.T) {
	boom := errors.New("dial tcp: i/o timeout")
	us := &countingUserStore{err: boom}
	c := userCache(t, us, time.Minute, nil)

	for i := 0; i < 2; i++ {
		if _, err := c.Resolve(context.Background(), 7); !errors.Is(err, boom) {
			t.Fatalf("attempt %d got %v, want the store error", i, err)
		}
	}
	if n := us.calls.Load(); n != 2 {
		t.Errorf("calls=%d, want 2 — a failure must not be cached", n)
	}
	if c.CachedUsers() != 0 {
		t.Errorf("cached %d users after failures, want 0", c.CachedUsers())
	}
}

// The per-user map only ever grew: Invalidate is targeted and a re-resolve
// overwrites just the users who came back, so a long-lived gateway kept an entry
// for every account that ever made a request.
func TestReloadSweepsExpiredUsers(t *testing.T) {
	us := &countingUserStore{status: "active", plan: &store.Plan{Code: "pro"}}
	c := userCache(t, us, 10*time.Millisecond, nil)

	for _, uid := range []int64{1, 2, 3} {
		if _, err := c.Resolve(context.Background(), uid); err != nil {
			t.Fatalf("user %d: %v", uid, err)
		}
	}
	if c.CachedUsers() != 3 {
		t.Fatalf("cached=%d, want 3", c.CachedUsers())
	}

	// Nothing has expired yet.
	c.sweepUsers(time.Now())
	if c.CachedUsers() != 3 {
		t.Fatalf("cached=%d after an early sweep, want 3", c.CachedUsers())
	}

	time.Sleep(20 * time.Millisecond)
	c.sweepUsers(time.Now())
	if c.CachedUsers() != 0 {
		t.Fatalf("cached=%d after expiry, want 0", c.CachedUsers())
	}
}

// A caller that gives up (client disconnected) must not poison the shared read:
// the resolve completes and populates the cache for everyone else.
func TestResolveCancelledCallerDoesNotAbortTheRead(t *testing.T) {
	us := &countingUserStore{
		status: "active", plan: &store.Plan{Code: "pro"},
		block: make(chan struct{}), entered: make(chan struct{}, 1),
	}
	c := userCache(t, us, time.Minute, nil)

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := c.Resolve(ctx, 7)
		errCh <- err
	}()
	<-us.entered
	cancel()
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller got %v, want context.Canceled", err)
	}

	close(us.block)
	// The read still finished, so the next caller is served from cache.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && c.CachedUsers() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if c.CachedUsers() != 1 {
		t.Fatal("the abandoned resolve did not populate the cache")
	}
	if _, err := c.Resolve(context.Background(), 7); err != nil {
		t.Fatalf("resolve after cancellation: %v", err)
	}
	if n := us.calls.Load(); n != 1 {
		t.Errorf("calls=%d, want 1 — the completed read must be reused", n)
	}
}

// A user with no subscription resolves to the free plan rather than an error.
func TestResolveFallsBackToFree(t *testing.T) {
	us := &countingUserStore{status: "active", plan: nil}
	c := userCache(t, us, time.Minute, nil)
	got, err := c.Resolve(context.Background(), 7)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Plan.Code != "free" {
		t.Fatalf("plan=%q, want free", got.Plan.Code)
	}
}
