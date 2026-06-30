package api

import (
	"context"
	"errors"

	"github.com/choeng-rayu/rayu-orchestrator/internal/build"
	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// Controller is the build-lifecycle seam the HTTP handlers delegate side effects
// to. It deliberately exposes only what the API needs — create, cancel, and
// delete — so the full build engine (worker pool, admission control, sandbox
// runner, deploy pipeline; tasks 6, 9, 10, 16) can implement this interface and
// be injected via Deps.Builds without changing a single handler.
//
// Import-cycle note: the request/error types this interface uses (CreateRequest,
// BYOK, ErrNotCancelable) and the production implementation (build.Engine) live
// in the build package, because `api` depends on `build` and not the reverse.
// *build.Engine satisfies this interface structurally, so main.go can pass it as
// Deps.Builds without `build` ever importing `api`. NewMachineController provides
// a lighter Machine-backed implementation used by the API's own unit tests.
type Controller interface {
	// Create allocates a Build_Id, persists a new queued Build_Record, and hands
	// it off for admission. It returns the persisted record (with timestamps), or
	// build.ErrConcurrencyQuotaExceeded / build.ErrDailyQuotaExceeded on a quota
	// breach (mapped to 429).
	Create(ctx context.Context, req build.CreateRequest) (store.Build, error)
	// Cancel drives an active build toward the canceled Terminal_Status. It
	// returns store.ErrNotFound for an unknown build and build.ErrNotCancelable
	// when the build is already terminal.
	Cancel(ctx context.Context, buildID string) error
	// Delete terminates a build — tearing down its sandbox, App_Container, and
	// route — and drives it toward the terminated Terminal_Status when that edge
	// is reachable. It returns store.ErrNotFound for an unknown build.
	Delete(ctx context.Context, buildID string) error
}

// createIDAttempts bounds the Build_Id allocation retry loop. A collision over
// 80 bits of randomness is astronomically unlikely, so a single attempt
// essentially always succeeds; the retries are a pure-correctness backstop.
const createIDAttempts = 5

// machineController is the lightweight Machine-backed Controller used by the
// API's unit tests: it persists through a Store and performs every status
// transition through a build.Machine, so transitions stay valid and emit the
// required Progress_Events (Req 2.4/2.6). Production uses build.Engine (which
// adds the worker pool, quotas, and per-build goroutine) via main.go.
type machineController struct {
	store   store.Store
	machine *build.Machine
	newID   func() (string, error)
}

// NewMachineController returns the Machine-backed Controller, wiring a
// build.Machine over st and em so cancel/delete transitions emit events through
// the same Emitter (the SSE Hub) the rest of the system uses.
func NewMachineController(st store.Store, em stream.Emitter) Controller {
	return &machineController{
		store:   st,
		machine: build.NewMachine(st, em),
		newID:   GenerateBuildID,
	}
}

// Create persists a new queued build under a freshly generated, DNS-safe
// Build_Id (Req 1.1). Validation has already happened in the handler, so a
// reaching Create implies a well-formed request and no record is created for a
// rejected one (Req 1.2). The BYOK credential is intentionally not persisted
// (Req 18.1).
func (c *machineController) Create(ctx context.Context, req build.CreateRequest) (store.Build, error) {
	_ = req.BYOK // memory-only; never persisted, never logged.

	var lastErr error
	for i := 0; i < createIDAttempts; i++ {
		id, err := c.newID()
		if err != nil {
			return store.Build{}, err
		}
		b := store.Build{
			ID:      id,
			OwnerID: req.OwnerID,
			Status:  store.StatusQueued,
			Prompt:  req.Prompt,
		}
		if err := c.store.CreateBuild(ctx, b); err != nil {
			// Almost certainly an id collision; retry with fresh randomness.
			lastErr = err
			continue
		}
		return c.store.GetBuild(ctx, id)
	}
	if lastErr == nil {
		lastErr = errors.New("api: could not allocate a unique build id")
	}
	return store.Build{}, lastErr
}

// Cancel rejects a terminal build with build.ErrNotCancelable (Req 2.5) and
// otherwise transitions it to canceled through the Machine.
func (c *machineController) Cancel(ctx context.Context, buildID string) error {
	b, err := c.store.GetBuild(ctx, buildID)
	if err != nil {
		return err // store.ErrNotFound → 404 in the handler
	}
	if b.Status.IsTerminal() {
		return build.ErrNotCancelable
	}
	return c.machine.Transition(ctx, buildID, store.StatusCanceled, "canceled by request")
}

// Delete tears down a build's runtime and transitions it to terminated when the
// edge is reachable. An already-terminal build (failed/canceled/terminated) has
// no edge to terminated, so after teardown its status is left unchanged.
func (c *machineController) Delete(ctx context.Context, buildID string) error {
	b, err := c.store.GetBuild(ctx, buildID)
	if err != nil {
		return err // store.ErrNotFound → 404 in the handler
	}

	c.teardown(ctx, buildID)

	// CanTransition covers every active status and the lone live→terminated edge
	// (Req 1.6, 19.3); a terminal build returns false and is left as-is.
	if build.CanTransition(b.Status, store.StatusTerminated) {
		return c.machine.Transition(ctx, buildID, store.StatusTerminated, "terminated by request")
	}
	return nil
}

// teardown is the resource-reclamation seam invoked on delete. It is a no-op for
// the Machine-backed controller (the engine owns real teardown) and is designed
// to be idempotent, so deleting an already-torn-down build is safe.
func (c *machineController) teardown(_ context.Context, _ string) {}
