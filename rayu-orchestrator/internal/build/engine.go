package build

import (
	"context"
	"errors"
	"sync"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// --- Build-creation contract (shared with the API; defined here to avoid an
// import cycle) ---
//
// The API's Controller interface is satisfied STRUCTURALLY by *Engine: the
// `api` package depends on `build` (it constructs a Machine and references these
// types), so `build` must not depend on `api`. The Controller's request and
// error types therefore live here, in `build`, and `api.Controller` references
// them — main.go constructs the *Engine and passes it as api.Deps.Builds without
// `build` ever importing `api` (Go's structural interfaces make that work).

// ErrNotCancelable is returned by Cancel when the target build is already in a
// Terminal_Status and so cannot be canceled (Req 2.5). The API maps it to 409.
var ErrNotCancelable = errors.New("build: build is already in a terminal status")

// BYOK is an End_User's bring-your-own-key credential supplied with a build
// request. It is handled in memory only and is NEVER persisted to any store
// (Req 18.1); the key vault (task 19) takes ownership of it for the build's
// lifetime.
type BYOK struct {
	BaseURL string
	APIKey  string
	Model   string
}

// CreateRequest is the validated input the API hands to Create. The HTTP handler
// performs syntactic validation (non-empty prompt and owner); the engine owns id
// allocation, quota admission, persistence, and worker-pool hand-off.
type CreateRequest struct {
	Prompt  string
	OwnerID string
	BYOK    *BYOK
}

// createIDAttempts bounds the Build_Id allocation retry loop. A collision over
// 80 bits of randomness is astronomically unlikely, so a single attempt
// essentially always succeeds; the retries are a pure-correctness backstop.
const createIDAttempts = 5

// eventStreamer is what the engine needs from the SSE hub: emit Progress_Events
// (Emitter) and signal that a build's stream is fully terminal so open SSE
// connections flush and close (CloseBuild, Req 10.5). *stream.Hub satisfies it.
type eventStreamer interface {
	stream.Emitter
	CloseBuild(buildID string)
}

// EngineConfig carries the admission/quota limits the engine wires into its pool
// and quota (Req 3.1, 17.1, 17.3).
type EngineConfig struct {
	MaxConcurrentBuilds int
	PerUserConcurrency  int
	PerUserDaily        int
}

// Engine is the production build Controller. It owns the build lifecycle:
// quota-gated creation, worker-pool admission, the per-build owning goroutine,
// and cancel/delete teardown. It composes the lifecycle Machine, the worker
// Pool, the Quota accounting, and the SSE Hub; *Engine structurally satisfies
// api.Controller.
//
// Each admitted build runs in one owning goroutine driven by a context.Context
// derived from the engine's base context. Canceling that context (via Cancel,
// Delete, or engine shutdown) unblocks the goroutine, which frees its
// worker-pool slot so the next queued build is admitted.
type Engine struct {
	store   store.Store
	machine *Machine
	pool    *Pool
	quota   *Quota
	hub     eventStreamer
	newID   func() (string, error)

	baseCtx    context.Context
	cancelBase context.CancelFunc

	createMu sync.Mutex // serializes quota-check + create so the concurrency quota is exact

	mu      sync.Mutex
	running map[string]context.CancelFunc // buildID -> cancel for its owning goroutine
}

// NewEngine constructs the build engine over st and hub with the given limits.
// newID allocates Build_Ids (injected so `build` need not import the API's id
// package); main.go passes api.GenerateBuildID.
func NewEngine(st store.Store, hub eventStreamer, cfg EngineConfig, newID func() (string, error)) *Engine {
	baseCtx, cancel := context.WithCancel(context.Background())
	e := &Engine{
		store:      st,
		machine:    NewMachine(st, hub),
		quota:      NewQuota(st, cfg.PerUserConcurrency, cfg.PerUserDaily),
		hub:        hub,
		newID:      newID,
		baseCtx:    baseCtx,
		cancelBase: cancel,
		running:    map[string]context.CancelFunc{},
	}
	e.pool = NewPool(baseCtx, e.machine, hub, cfg.MaxConcurrentBuilds, cfg.PerUserConcurrency, e.startBuild)
	return e
}

// Create runs the per-user quota check BEFORE admission (Req 17.2, 17.4): on a
// breach it returns ErrConcurrencyQuotaExceeded or ErrDailyQuotaExceeded (which
// the API maps to 429) and creates no Build_Record. Otherwise it allocates a
// DNS-safe Build_Id, persists a queued Build_Record (Req 1.1), begins tracking
// the owner's active count (Req 17.5), and hands the build to the worker pool
// for admission. The BYOK credential is never persisted (Req 18.1).
func (e *Engine) Create(ctx context.Context, req CreateRequest) (store.Build, error) {
	// BYOK is memory-only: the key vault (task 19) takes ownership here and drops
	// it at terminal. Until then it is discarded — never written to the store,
	// never logged.
	_ = req.BYOK

	// Serialize the check + create so two concurrent creates for one owner cannot
	// both pass the concurrency check against the same store snapshot and then
	// both create, momentarily exceeding PER_USER_CONCURRENCY.
	e.createMu.Lock()
	defer e.createMu.Unlock()

	if err := e.quota.CheckOnCreate(ctx, req.OwnerID); err != nil {
		return store.Build{}, err
	}

	var lastErr error
	for i := 0; i < createIDAttempts; i++ {
		id, err := e.newID()
		if err != nil {
			return store.Build{}, err
		}
		b := store.Build{
			ID:      id,
			OwnerID: req.OwnerID,
			Status:  store.StatusQueued,
			Prompt:  req.Prompt,
		}
		if err := e.store.CreateBuild(ctx, b); err != nil {
			// Almost certainly an id collision; retry with fresh randomness.
			lastErr = err
			continue
		}
		// Capture the queued snapshot (with timestamps) BEFORE admission: the
		// pool advances the build queued→provisioning synchronously, so re-reading
		// after Enqueue could report provisioning, but the create response must
		// report the queued status the build was created in (Req 1.1).
		created, err := e.store.GetBuild(ctx, id)
		if err != nil {
			return store.Build{}, err
		}
		// Track the new active build (Req 17.5 accounting) and admit it. The pool
		// advances it queued→provisioning when a slot is free and the owner is
		// under PER_USER_CONCURRENCY, emitting queue-position events while it waits.
		e.quota.Track(req.OwnerID, id)
		e.pool.Enqueue(id, req.OwnerID)
		return created, nil
	}
	if lastErr == nil {
		lastErr = errors.New("build: could not allocate a unique build id")
	}
	return store.Build{}, lastErr
}

// Cancel drives an active build toward the canceled Terminal_Status (Req 1.5).
// It returns store.ErrNotFound for an unknown build and ErrNotCancelable when the
// build is already terminal (Req 2.5). A still-queued build is removed from the
// admission queue so the pool never starts it; a running build has its owning
// context canceled so its goroutine stops and frees its slot. Either way the
// Machine performs the canceled transition (keeping the status + events valid),
// the active count is decremented, and the SSE stream is closed.
func (e *Engine) Cancel(ctx context.Context, buildID string) error {
	b, err := e.store.GetBuild(ctx, buildID)
	if err != nil {
		return err // store.ErrNotFound → 404 in the handler
	}
	if b.Status.IsTerminal() {
		return ErrNotCancelable
	}

	e.stopBuild(buildID)

	if err := e.machine.Transition(ctx, buildID, store.StatusCanceled, "canceled by request"); err != nil {
		// A concurrent cancel/delete may have already driven it terminal.
		if errors.Is(err, ErrInvalidTransition) {
			return ErrNotCancelable
		}
		return err
	}
	e.finalize(buildID)
	return nil
}

// Delete terminates a build — stopping its runtime and tearing down its route —
// and drives it to the terminated Terminal_Status when that edge is reachable
// (Req 1.6, 19.3). An already-terminal build (failed/canceled/terminated) has no
// edge to terminated, so after teardown its status is left unchanged. Returns
// store.ErrNotFound for an unknown build.
func (e *Engine) Delete(ctx context.Context, buildID string) error {
	b, err := e.store.GetBuild(ctx, buildID)
	if err != nil {
		return err // store.ErrNotFound → 404 in the handler
	}

	e.stopBuild(buildID)
	e.teardown(ctx, buildID)

	// CanTransition covers every active status and the lone live→terminated edge;
	// a terminal build returns false and is left as-is.
	if CanTransition(b.Status, store.StatusTerminated) {
		if err := e.machine.Transition(ctx, buildID, store.StatusTerminated, "terminated by request"); err != nil && !errors.Is(err, ErrInvalidTransition) {
			return err
		}
	}
	e.finalize(buildID)
	return nil
}

// Close stops admission and cancels every build's owning goroutine, then returns
// once shutdown is signalled. It satisfies the engine's lifecycle so main.go and
// tests can release the per-build goroutines deterministically.
func (e *Engine) Close() error {
	e.pool.Stop()
	e.cancelBase()
	return nil
}

// startBuild is the pool's RunHook: it begins a newly-admitted build's owning
// goroutine under a cancelable context derived from the engine's base context.
func (e *Engine) startBuild(buildID, ownerID string) {
	ctx, cancel := context.WithCancel(e.baseCtx)
	e.mu.Lock()
	e.running[buildID] = cancel
	e.mu.Unlock()
	go e.run(ctx, buildID, ownerID)
}

// run is a build's owning goroutine. On exit it always removes itself from the
// running set and releases its worker-pool slot, so a freed slot immediately
// admits the next queued build.
//
// Phase 1 seam: the hardened sandbox run (task 10) and the deploy pipeline
// (task 16) execute here, advancing provisioning→building→build_succeeded→…→live
// and streaming progress. Until those land, the owning goroutine simply holds
// its slot and waits on its context; Cancel/Delete (or engine shutdown) cancels
// that context, which both performs the terminal transition and unblocks this
// goroutine so the slot is released.
func (e *Engine) run(ctx context.Context, buildID string, _ string) {
	defer func() {
		e.mu.Lock()
		delete(e.running, buildID)
		e.mu.Unlock()
		e.pool.Release(buildID)
	}()

	<-ctx.Done()
}

// stopBuild removes a build from the pool if it is still queued, or cancels its
// owning goroutine's context if it is running. Safe to call for a build that is
// in neither state (no-op).
func (e *Engine) stopBuild(buildID string) {
	if e.pool.Remove(buildID) {
		return // was still queued; never admitted, so no goroutine to stop
	}
	e.mu.Lock()
	cancel := e.running[buildID]
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// finalize performs the terminal-status bookkeeping shared by Cancel and Delete:
// decrement the owner's active count exactly once (Req 17.5) and close the build's
// SSE stream so open connections flush the final tail and disconnect (Req 10.5).
// Both underlying operations are idempotent, so finalize is safe to call once per
// terminal even if the build raced to terminal by another path.
func (e *Engine) finalize(buildID string) {
	e.quota.Untrack(buildID)
	e.hub.CloseBuild(buildID)
}

// teardown is the resource-reclamation seam invoked on delete: stop the Sandbox
// and App_Container and deregister the route. It is intentionally a no-op until
// the sandbox/deploy/routing subsystems are wired (tasks 9/16/20) and is designed
// to be idempotent, so deleting an already-torn-down build is safe.
func (e *Engine) teardown(_ context.Context, _ string) {}
