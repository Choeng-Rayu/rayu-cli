// Package eventqueue is a bounded, async, single-flight write queue for
// best-effort durability writes (credit ledger rows, usage-tracking events)
// that must never block the request path they're attached to.
//
// It is a Go port of the CLI's SerialBatchEventUploader protocol
// (rayu/src/cli/transports/SerialBatchEventUploader.ts), which the gateway's
// own hot path was NOT using: server.go previously spawned one untracked
// goroutine per write via safeGo("record_ledger", ...) / safeGo(
// "proxy_usage_event", ...), each opening its own short-lived MySQL
// connection with no shared backpressure. Under concurrent load those
// goroutines compete for the same limited connection pool as the
// synchronous request path (entitlement lookups), starving both.
//
// This package fixes that by giving all such writes ONE bounded channel and
// ONE drain loop per Queue:
//   - Enqueue is non-blocking up to a bounded capacity (fast path for the
//     request handler); a full queue drops the oldest pending item rather than
//     blocking the caller or growing memory unbounded — a dropped ledger/usage
//     row is an acceptable, logged loss under extreme load, but stalling the
//     request that scheduled it is not.
//   - The drain loop processes one item at a time (serial, like the TS
//     uploader's single in-flight POST) so writes never fan out into more
//     concurrent MySQL connections than the configured Workers count.
//   - A failed write is retried with exponential backoff + jitter, mirroring
//     SerialBatchEventUploader.retryDelay.
//   - After MaxConsecutiveFailures retries, the item is dropped (logged) and
//     the drain loop moves on — the TS uploader's "poison batch" escape hatch,
//     preventing one bad/never-succeeding write from wedging the whole queue.
package eventqueue

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"
)

// Item is a queued write plus the function that performs it. Run is invoked
// with a fresh, short background context on every attempt (the queue is
// detached from any originating request's context by design — the whole
// point is that a client disconnecting must not cancel a durable write that
// is already queued).
type Item struct {
	// Name identifies the item for logging (e.g. "record_ledger").
	Name string
	// Run performs the write. Returning a non-nil error triggers a retry
	// (up to Config.MaxConsecutiveFailures) with backoff.
	Run func(ctx context.Context) error
}

// Config controls queue capacity, concurrency, and retry policy. All
// durations mirror the shape (not the exact values) of
// SerialBatchEventUploaderConfig in the TS original.
type Config struct {
	// Capacity is the max number of pending items before Enqueue starts
	// dropping the oldest pending item to make room. 0 uses DefaultCapacity.
	Capacity int
	// Workers is how many items may be in-flight (Run executing) at once.
	// Bounds how many concurrent MySQL connections this queue can hold,
	// independent of how many HTTP requests are enqueueing concurrently.
	// 0 uses DefaultWorkers.
	Workers int
	// RunTimeout bounds a single Run attempt. 0 uses DefaultRunTimeout.
	RunTimeout time.Duration
	// BaseDelay, MaxDelay, Jitter shape the exponential backoff between
	// retries of the SAME item, same roles as SerialBatchEventUploader's
	// baseDelayMs/maxDelayMs/jitterMs. Zero values use the Default* consts.
	BaseDelay time.Duration
	MaxDelay  time.Duration
	Jitter    time.Duration
	// MaxConsecutiveFailures caps retries for a single item before it is
	// dropped (logged via OnDrop) and the worker moves to the next item —
	// mirrors the TS uploader's maxConsecutiveFailures poison-batch escape.
	// 0 uses DefaultMaxConsecutiveFailures.
	MaxConsecutiveFailures int
	// OnDrop is called (from a worker goroutine) when an item is dropped
	// after exhausting MaxConsecutiveFailures, or when Enqueue evicts the
	// oldest pending item to make room for a new one under sustained
	// overload. reason is "max_failures" or "queue_full". Optional.
	OnDrop func(item Item, reason string, err error)
}

// Defaults mirror sane production values: small enough to bound MySQL
// connection usage, large enough that a normal request burst never drops.
const (
	DefaultCapacity               = 4096
	DefaultWorkers                = 4
	DefaultRunTimeout             = 5 * time.Second
	DefaultBaseDelay              = 250 * time.Millisecond
	DefaultMaxDelay               = 10 * time.Second
	DefaultJitter                 = 250 * time.Millisecond
	DefaultMaxConsecutiveFailures = 5
)

// Queue is a bounded async write queue. Zero value is not usable; construct
// with New.
type Queue struct {
	cfg Config

	mu      sync.Mutex
	pending []Item
	notify  chan struct{} // buffered(1); signals workers a new item may be ready

	closed    atomic.Bool
	closeOnce sync.Once
	done      chan struct{}
	wg        sync.WaitGroup

	// metrics — read via Enqueued/Dropped/Succeeded for tests/observability.
	enqueued  atomic.Int64
	dropped   atomic.Int64
	succeeded atomic.Int64
}

// New builds a Queue and starts its worker goroutines. Call Close to stop
// them; Close does not wait for in-flight Run calls beyond RunTimeout.
func New(cfg Config) *Queue {
	if cfg.Capacity <= 0 {
		cfg.Capacity = DefaultCapacity
	}
	if cfg.Workers <= 0 {
		cfg.Workers = DefaultWorkers
	}
	if cfg.RunTimeout <= 0 {
		cfg.RunTimeout = DefaultRunTimeout
	}
	if cfg.BaseDelay <= 0 {
		cfg.BaseDelay = DefaultBaseDelay
	}
	if cfg.MaxDelay <= 0 {
		cfg.MaxDelay = DefaultMaxDelay
	}
	if cfg.Jitter < 0 {
		cfg.Jitter = DefaultJitter
	}
	if cfg.MaxConsecutiveFailures <= 0 {
		cfg.MaxConsecutiveFailures = DefaultMaxConsecutiveFailures
	}
	q := &Queue{
		cfg:    cfg,
		notify: make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
	for i := 0; i < cfg.Workers; i++ {
		q.wg.Add(1)
		go q.worker()
	}
	return q
}

// Enqueue adds an item to the pending buffer. Never blocks: if the queue is
// at Capacity, the oldest pending item is evicted (and reported via OnDrop
// with reason "queue_full") to make room. This is the fast, non-blocking path
// the request handler uses — an HTTP request must never wait on this call.
//
// A no-op after Close.
func (q *Queue) Enqueue(item Item) {
	if q.closed.Load() {
		return
	}
	q.mu.Lock()
	if len(q.pending) >= q.cfg.Capacity {
		evicted := q.pending[0]
		q.pending = q.pending[1:]
		q.mu.Unlock()
		q.dropped.Add(1)
		if q.cfg.OnDrop != nil {
			q.cfg.OnDrop(evicted, "queue_full", nil)
		}
		q.mu.Lock()
	}
	q.pending = append(q.pending, item)
	q.mu.Unlock()
	q.enqueued.Add(1)
	q.wake()
}

// wake signals workers without blocking (buffered(1) channel: at most one
// pending wake is ever needed since workers re-check the queue in a loop).
func (q *Queue) wake() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

func (q *Queue) take() (Item, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.pending) == 0 {
		return Item{}, false
	}
	item := q.pending[0]
	q.pending = q.pending[1:]
	return item, true
}

func (q *Queue) worker() {
	defer q.wg.Done()
	for {
		item, ok := q.take()
		if !ok {
			select {
			case <-q.done:
				return
			case <-q.notify:
				continue
			}
		}
		q.runWithRetry(item)
	}
}

// runWithRetry runs item.Run, retrying with exponential backoff + jitter on
// failure, up to MaxConsecutiveFailures — the same shape as
// SerialBatchEventUploader.drain()'s per-batch failure handling.
//
// A panic inside item.Run is recovered and treated as a failed attempt
// (subject to the same retry/drop policy) instead of crashing the worker
// goroutine. A goroutine's panic is NOT caught by an HTTP handler's own
// recover or by chi's Recoverer middleware — it terminates the entire Go
// process immediately, taking down every in-flight request/stream on the
// gateway, not just the best-effort write that scheduled it. This recover is
// the queue's replacement for the gateway's old per-call-site safeGo helper.
func (q *Queue) runWithRetry(item Item) {
	var failures int
	for {
		ctx, cancel := context.WithTimeout(context.Background(), q.cfg.RunTimeout)
		err := q.runOnce(ctx, item)
		cancel()
		if err == nil {
			q.succeeded.Add(1)
			return
		}
		failures++
		if failures >= q.cfg.MaxConsecutiveFailures {
			q.dropped.Add(1)
			if q.cfg.OnDrop != nil {
				q.cfg.OnDrop(item, "max_failures", err)
			}
			return
		}
		delay := q.retryDelay(failures, err)
		select {
		case <-q.done:
			return
		case <-time.After(delay):
		}
	}
}

// runOnce invokes item.Run with panic recovery, converting a panic into an
// error so runWithRetry's normal retry/drop accounting handles it uniformly.
func (q *Queue) runOnce(ctx context.Context, item Item) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic in eventqueue item %q: %v", item.Name, r)
		}
	}()
	return item.Run(ctx)
}

// retryDelay mirrors SerialBatchEventUploader.retryDelay: exponential backoff
// clamped to MaxDelay, plus uniform jitter. A RetryAfter-carrying error
// (e.g. a MySQL/Redis-side rate limit surfaced as an error) overrides the
// exponential base, same as the TS RetryableError.retryAfterMs path.
func (q *Queue) retryDelay(failures int, err error) time.Duration {
	jitter := time.Duration(0)
	if q.cfg.Jitter > 0 {
		jitter = time.Duration(rand.Int63n(int64(q.cfg.Jitter)))
	}
	var ra RetryAfter
	if errors.As(err, &ra) && ra.RetryAfter > 0 {
		d := ra.RetryAfter
		if d < q.cfg.BaseDelay {
			d = q.cfg.BaseDelay
		}
		if d > q.cfg.MaxDelay {
			d = q.cfg.MaxDelay
		}
		return d + jitter
	}
	exp := q.cfg.BaseDelay << uint(failures-1) // 2^(failures-1) * base
	if exp <= 0 || exp > q.cfg.MaxDelay {      // overflow guard + clamp
		exp = q.cfg.MaxDelay
	}
	return exp + jitter
}

// RetryAfter lets a Run implementation carry a server-supplied backoff hint
// (e.g. a 429/Retry-After from a downstream), mirroring the TS
// RetryableError. Wrap it into a returned error and unwrap via errors.As.
type RetryAfter struct {
	Err        error
	RetryAfter time.Duration
}

func (r RetryAfter) Error() string { return r.Err.Error() }
func (r RetryAfter) Unwrap() error { return r.Err }

// Enqueued, Dropped, and Succeeded report lifetime counters — useful for
// tests and for exposing queue health via a metrics/debug endpoint.
func (q *Queue) Enqueued() int64  { return q.enqueued.Load() }
func (q *Queue) Dropped() int64   { return q.dropped.Load() }
func (q *Queue) Succeeded() int64 { return q.succeeded.Load() }

// Pending reports the current queue depth.
func (q *Queue) Pending() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.pending)
}

// Close stops accepting new items and signals workers to stop after their
// current item finishes. It does not wait for workers to exit — use Wait for
// that (e.g. during graceful shutdown with its own deadline).
func (q *Queue) Close() {
	q.closeOnce.Do(func() {
		q.closed.Store(true)
		close(q.done)
	})
}

// Wait blocks until all worker goroutines have exited (must call Close
// first, or this blocks forever). Intended for graceful shutdown with an
// outer deadline (e.g. select on Wait's return channel vs. a timeout).
func (q *Queue) Wait() {
	q.wg.Wait()
}
