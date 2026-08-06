package server

import (
	"context"
	"sync"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/configbus"
)

// Immediate config refreshes, shared by the admin paths that must see their own
// write and (later) by the invalidation bus.
//
// # WHY A SINGLE-FLIGHT AND NOT A DEBOUNCE
//
// A refresh is several MySQL queries plus AES-GCM decryption of every stored
// provider key, so it must not run once per click when the dashboard fires a
// burst. The obvious fix — "skip if we refreshed less than a second ago" — is
// WRONG here: an admin who saves, tests, saves again and tests again would get
// the second test served from the pre-save snapshot, which is precisely the bug
// this exists to remove. A time window cannot distinguish "we already have this
// write" from "a newer write landed since".
//
// Single-flight has neither problem: genuinely concurrent callers share ONE
// refresh, while sequential callers each get a fresh read of the database. The
// only overlap window is the duration of a refresh itself (a few milliseconds),
// which no human save→click cycle can fit inside.
const configReloadTimeout = 10 * time.Second

// ConfigReloader collapses concurrent immediate refreshes into one, and optionally
// announces a refresh to the other replicas.
type ConfigReloader struct {
	fn      func(context.Context) error
	publish func(context.Context, configbus.Event) error

	mu       sync.Mutex
	inflight *reloadCall
}

// reloadCall is one shared refresh. err is written before done is closed, so
// every waiter reads it with a happens-before guarantee.
type reloadCall struct {
	done chan struct{}
	err  error
}

// NewConfigReloader builds a reloader around a refresh function. publish may be
// nil (single replica, or no Redis): Broadcast then only refreshes locally.
func NewConfigReloader(
	fn func(context.Context) error,
	publish func(context.Context, configbus.Event) error,
) *ConfigReloader {
	return &ConfigReloader{fn: fn, publish: publish}
}

// Reload refreshes the config snapshot now, joining a refresh already in progress
// rather than starting a second one. A caller whose own context is cancelled stops
// waiting and returns ctx.Err(); the shared refresh continues for everyone else,
// because it is doing work the other waiters (and the next request) still need.
//
// It does NOT announce anything: this is the local-only path, used by admin reads
// (the provider test) and by the bus subscriber itself — which must never re-publish
// what it just received.
func (c *ConfigReloader) Reload(ctx context.Context) error {
	c.mu.Lock()
	call := c.inflight
	if call == nil {
		call = &reloadCall{done: make(chan struct{})}
		c.inflight = call
		go c.run(call)
	}
	c.mu.Unlock()

	select {
	case <-call.done:
		return call.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Broadcast refreshes THIS replica and then tells the others to do the same.
// Refresh first, so the replica answering the admin is never the last to know.
//
// A publish failure is returned separately from the refresh error: the local
// refresh may well have succeeded, and the caller (the admin endpoint) reports
// them differently — one means "your change is not live here", the other means
// "it is live here but other replicas will wait for their timer".
func (c *ConfigReloader) Broadcast(ctx context.Context, ev configbus.Event) (reloadErr, publishErr error) {
	reloadErr = c.Reload(ctx)
	if c.publish != nil {
		publishErr = c.publish(ctx, ev)
	}
	return reloadErr, publishErr
}

// run performs the refresh on a DETACHED context: the result is shared, so one
// client hanging up must not abort a refresh the others are waiting for. The
// timeout keeps a wedged database from pinning the call forever.
func (c *ConfigReloader) run(call *reloadCall) {
	ctx, cancel := context.WithTimeout(context.Background(), configReloadTimeout)
	defer cancel()

	err := c.fn(ctx)

	// Clear the slot BEFORE releasing the waiters: a caller arriving from here on
	// starts a new refresh instead of joining one that has already read the
	// database, so it can never be handed data older than its own arrival.
	c.mu.Lock()
	c.inflight = nil
	c.mu.Unlock()

	call.err = err
	close(call.done)
}
