package server

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestConfigReloadCollapsesConcurrentCallers: a burst of admin tests (the
// dashboard fires one per key and one per model) must cost ONE database refresh,
// not one per click. Deterministic: the refresh blocks until every caller is
// provably waiting.
func TestConfigReloadCollapsesConcurrentCallers(t *testing.T) {
	var calls atomic.Int64
	release := make(chan struct{})
	entered := make(chan struct{}, 1)

	r := NewConfigReloader(func(context.Context) error {
		calls.Add(1)
		entered <- struct{}{}
		<-release
		return nil
	}, nil)

	// First caller starts the refresh; wait until it is actually running so the
	// others cannot race ahead of it and start their own.
	var wg sync.WaitGroup
	errs := make([]error, 8)
	wg.Add(1)
	go func() {
		defer wg.Done()
		errs[0] = r.Reload(context.Background())
	}()
	<-entered

	for i := 1; i < len(errs); i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = r.Reload(context.Background())
		}(i)
	}
	// Give the joiners a moment to queue up behind the in-flight call, then let it
	// finish. (Sleeping only delays the assertion; it cannot make it pass falsely,
	// because a second refresh would increment calls.)
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("underlying refreshes=%d, want 1 — concurrent callers must share one", got)
	}
	for i, err := range errs {
		if err != nil {
			t.Errorf("caller %d: %v", i, err)
		}
	}
}

// TestConfigReloadSequentialCallsEachRefresh pins the design decision: NO time
// window. An admin who saves, tests, saves again and tests again must get fresh
// configuration both times — a debounce would serve the second test from the
// pre-save snapshot, which is the bug this code exists to remove.
func TestConfigReloadSequentialCallsEachRefresh(t *testing.T) {
	var calls atomic.Int64
	r := NewConfigReloader(func(context.Context) error {
		calls.Add(1)
		return nil
	}, nil)

	for i := 0; i < 3; i++ {
		if err := r.Reload(context.Background()); err != nil {
			t.Fatalf("reload %d: %v", i, err)
		}
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("refreshes=%d, want 3 (one per sequential call, no debounce)", got)
	}
}

// A failed refresh must reach every waiter: the caller decides what to do about
// it (the provider test answers from the last snapshot and says so).
func TestConfigReloadPropagatesTheError(t *testing.T) {
	boom := errors.New("dial tcp: connection refused")
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	r := NewConfigReloader(func(context.Context) error {
		entered <- struct{}{}
		<-release
		return boom
	}, nil)

	var wg sync.WaitGroup
	got := make([]error, 3)
	wg.Add(1)
	go func() { defer wg.Done(); got[0] = r.Reload(context.Background()) }()
	<-entered
	for i := 1; i < len(got); i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); got[i] = r.Reload(context.Background()) }(i)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()

	for i, err := range got {
		if !errors.Is(err, boom) {
			t.Errorf("caller %d got %v, want the refresh error", i, err)
		}
	}
}

// A client that hangs up must not abort a refresh the other waiters need, and
// must not be reported as a successful refresh either.
func TestConfigReloadCancelledCallerDoesNotAbortTheRefresh(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	finished := make(chan struct{})
	r := NewConfigReloader(func(ctx context.Context) error {
		entered <- struct{}{}
		<-release
		// The refresh runs on a detached context: the caller's cancellation must
		// not have propagated here.
		if err := ctx.Err(); err != nil {
			t.Errorf("refresh context was cancelled by the caller: %v", err)
		}
		close(finished)
		return nil
	}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- r.Reload(ctx) }()
	<-entered
	cancel()

	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller got %v, want context.Canceled", err)
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("refresh did not complete after its caller cancelled")
	}
}
