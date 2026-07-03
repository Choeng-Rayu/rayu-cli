package eventqueue

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// waitFor polls cond until it's true or the timeout elapses, failing the
// test otherwise. Keeps the async assertions below free of sleep-and-hope.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !cond() {
		t.Fatalf("condition not met within %v", timeout)
	}
}

func TestEnqueue_RunsSuccessfully(t *testing.T) {
	q := New(Config{Workers: 1, BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond})
	defer q.Close()

	var ran atomic.Bool
	q.Enqueue(Item{
		Name: "test",
		Run: func(ctx context.Context) error {
			ran.Store(true)
			return nil
		},
	})

	waitFor(t, time.Second, ran.Load)
	if q.Succeeded() != 1 {
		t.Fatalf("Succeeded()=%d, want 1", q.Succeeded())
	}
	if q.Dropped() != 0 {
		t.Fatalf("Dropped()=%d, want 0", q.Dropped())
	}
}

func TestEnqueue_RetriesOnFailureThenSucceeds(t *testing.T) {
	q := New(Config{
		Workers:   1,
		BaseDelay: time.Millisecond,
		MaxDelay:  5 * time.Millisecond,
		Jitter:    0,
	})
	defer q.Close()

	var attempts atomic.Int32
	q.Enqueue(Item{
		Name: "flaky",
		Run: func(ctx context.Context) error {
			n := attempts.Add(1)
			if n < 3 {
				return errors.New("transient failure")
			}
			return nil
		},
	})

	waitFor(t, time.Second, func() bool { return q.Succeeded() == 1 })
	if got := attempts.Load(); got != 3 {
		t.Fatalf("attempts=%d, want 3 (2 failures then success)", got)
	}
}

func TestEnqueue_DropsAfterMaxConsecutiveFailures(t *testing.T) {
	var dropReason string
	var dropCalled atomic.Bool
	q := New(Config{
		Workers:                1,
		BaseDelay:              time.Millisecond,
		MaxDelay:               2 * time.Millisecond,
		MaxConsecutiveFailures: 3,
		OnDrop: func(item Item, reason string, err error) {
			dropReason = reason
			dropCalled.Store(true)
		},
	})
	defer q.Close()

	var attempts atomic.Int32
	q.Enqueue(Item{
		Name: "always-fails",
		Run: func(ctx context.Context) error {
			attempts.Add(1)
			return errors.New("permanent failure")
		},
	})

	waitFor(t, time.Second, dropCalled.Load)
	if got := attempts.Load(); got != 3 {
		t.Fatalf("attempts=%d, want 3 (MaxConsecutiveFailures)", got)
	}
	if dropReason != "max_failures" {
		t.Fatalf("drop reason=%q, want max_failures", dropReason)
	}
	if q.Dropped() != 1 {
		t.Fatalf("Dropped()=%d, want 1", q.Dropped())
	}
	if q.Succeeded() != 0 {
		t.Fatalf("Succeeded()=%d, want 0", q.Succeeded())
	}
}

func TestEnqueue_QueueFullEvictsOldest(t *testing.T) {
	// Block the single worker on the first item so the queue backs up, then
	// verify the 3rd Enqueue (capacity=2, so items 1 and 2 fill it) evicts
	// item 1 rather than blocking the caller.
	release := make(chan struct{})
	var dropped []string
	var mu sync.Mutex

	q := New(Config{
		Workers:  1,
		Capacity: 2,
		OnDrop: func(item Item, reason string, err error) {
			mu.Lock()
			dropped = append(dropped, item.Name+":"+reason)
			mu.Unlock()
		},
	})
	defer q.Close()

	var firstStarted sync.WaitGroup
	firstStarted.Add(1)
	q.Enqueue(Item{
		Name: "first",
		Run: func(ctx context.Context) error {
			firstStarted.Done()
			<-release // block the only worker so the queue backs up
			return nil
		},
	})
	firstStarted.Wait() // ensure "first" is already executing, not just pending

	q.Enqueue(Item{Name: "second", Run: func(ctx context.Context) error { return nil }})
	q.Enqueue(Item{Name: "third", Run: func(ctx context.Context) error { return nil }})
	// Capacity=2 and "first" is already off the pending slice (it's running),
	// so "second" and "third" together exceed capacity and "second" (the
	// oldest still-pending item) should be evicted to make room.
	q.Enqueue(Item{Name: "fourth", Run: func(ctx context.Context) error { return nil }})

	close(release)

	waitFor(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(dropped) >= 1
	})
	mu.Lock()
	defer mu.Unlock()
	if len(dropped) == 0 || dropped[0] != "second:queue_full" {
		t.Fatalf("dropped=%v, want first entry \"second:queue_full\"", dropped)
	}
}

func TestEnqueue_PanicIsRecoveredAndTreatedAsFailure(t *testing.T) {
	var dropCalled atomic.Bool
	var dropErr error
	var mu sync.Mutex
	q := New(Config{
		Workers:                1,
		BaseDelay:              time.Millisecond,
		MaxDelay:               2 * time.Millisecond,
		MaxConsecutiveFailures: 1,
		OnDrop: func(item Item, reason string, err error) {
			mu.Lock()
			dropErr = err
			mu.Unlock()
			dropCalled.Store(true)
		},
	})
	defer q.Close()

	q.Enqueue(Item{
		Name: "panics",
		Run: func(ctx context.Context) error {
			panic("boom")
		},
	})

	waitFor(t, time.Second, dropCalled.Load)
	mu.Lock()
	defer mu.Unlock()
	if dropErr == nil {
		t.Fatal("expected a non-nil error captured from the panic")
	}
	// The worker goroutine must still be alive after the panic — verify by
	// enqueueing and running a second, unrelated item successfully.
	var ranAfterPanic atomic.Bool
	q.Enqueue(Item{
		Name: "after-panic",
		Run: func(ctx context.Context) error {
			ranAfterPanic.Store(true)
			return nil
		},
	})
	waitFor(t, time.Second, ranAfterPanic.Load)
}

func TestRetryAfter_OverridesBackoffBase(t *testing.T) {
	q := New(Config{BaseDelay: time.Second, MaxDelay: time.Minute, Jitter: 0})
	d := q.retryDelay(1, RetryAfter{Err: errors.New("rate limited"), RetryAfter: 3 * time.Second})
	if d != 3*time.Second {
		t.Fatalf("retryDelay with RetryAfter=3s -> %v, want 3s", d)
	}
}

func TestRetryAfter_ClampedToMaxDelay(t *testing.T) {
	q := New(Config{BaseDelay: time.Second, MaxDelay: 5 * time.Second, Jitter: 0})
	d := q.retryDelay(1, RetryAfter{Err: errors.New("rate limited"), RetryAfter: time.Hour})
	if d != 5*time.Second {
		t.Fatalf("retryDelay with a huge RetryAfter -> %v, want clamped to MaxDelay=5s", d)
	}
}

func TestRetryDelay_ExponentialWithoutRetryAfter(t *testing.T) {
	q := New(Config{BaseDelay: 100 * time.Millisecond, MaxDelay: 10 * time.Second, Jitter: 0})
	// failures=1 -> base * 2^0 = base
	if d := q.retryDelay(1, errors.New("plain")); d != 100*time.Millisecond {
		t.Fatalf("retryDelay(1)=%v, want 100ms", d)
	}
	// failures=3 -> base * 2^2 = 400ms
	if d := q.retryDelay(3, errors.New("plain")); d != 400*time.Millisecond {
		t.Fatalf("retryDelay(3)=%v, want 400ms", d)
	}
}

func TestClose_StopsAcceptingNewItems(t *testing.T) {
	q := New(Config{Workers: 1})
	q.Close()

	var ran atomic.Bool
	q.Enqueue(Item{
		Name: "after-close",
		Run: func(ctx context.Context) error {
			ran.Store(true)
			return nil
		},
	})
	// Give any (incorrectly still-running) worker a moment, then assert it
	// never ran — Enqueue after Close must be a no-op.
	time.Sleep(20 * time.Millisecond)
	if ran.Load() {
		t.Fatal("Enqueue after Close should be a no-op")
	}
}

func TestPending_ReflectsQueueDepth(t *testing.T) {
	release := make(chan struct{})
	q := New(Config{Workers: 1, Capacity: 10})
	defer q.Close()

	var started sync.WaitGroup
	started.Add(1)
	q.Enqueue(Item{
		Name: "blocker",
		Run: func(ctx context.Context) error {
			started.Done()
			<-release
			return nil
		},
	})
	started.Wait()

	q.Enqueue(Item{Name: "waiting-1", Run: func(ctx context.Context) error { return nil }})
	q.Enqueue(Item{Name: "waiting-2", Run: func(ctx context.Context) error { return nil }})

	waitFor(t, time.Second, func() bool { return q.Pending() == 2 })
	close(release)
}
