package build

import (
	"context"
	"errors"
	"fmt"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// ErrInvalidTransition is returned by Machine.Transition when the requested
// edge is not one of the permitted transitions (Req 2.3). On rejection the
// Build's current status is retained and a single `log` Progress_Event
// recording the rejected transition is emitted; callers can detect this with
// errors.Is.
var ErrInvalidTransition = errors.New("build: invalid status transition")

// allowedTransitions is the authoritative, table-driven adjacency list of the
// permitted Build status transitions (Req 2.2). It is the single source of
// truth CanTransition consults; the exhaustive 81-pair table test pins it to
// the spec edge set, and Property P1 uses CanTransition as its reference model.
//
// Permitted edges:
//   - the forward path
//     queued→provisioning→building→build_succeeded→deploying→live;
//   - any non-terminal status → failed | canceled | terminated; and
//   - live→terminated only — the sole edge leaving the otherwise-terminal
//     `live`, taken by the Idle_Reaper or a delete (Req 19.3, 1.6).
//
// The terminal statuses failed, canceled, and terminated have no outgoing
// edges. No status lists itself, so a self-transition is never permitted.
var allowedTransitions = map[store.Status][]store.Status{
	store.StatusQueued: {
		store.StatusProvisioning,
		store.StatusFailed, store.StatusCanceled, store.StatusTerminated,
	},
	store.StatusProvisioning: {
		store.StatusBuilding,
		store.StatusFailed, store.StatusCanceled, store.StatusTerminated,
	},
	store.StatusBuilding: {
		store.StatusBuildSucceeded,
		store.StatusFailed, store.StatusCanceled, store.StatusTerminated,
	},
	store.StatusBuildSucceeded: {
		store.StatusDeploying,
		store.StatusFailed, store.StatusCanceled, store.StatusTerminated,
	},
	store.StatusDeploying: {
		store.StatusLive,
		store.StatusFailed, store.StatusCanceled, store.StatusTerminated,
	},
	store.StatusLive: {
		store.StatusTerminated,
	},
	store.StatusFailed:     {},
	store.StatusCanceled:   {},
	store.StatusTerminated: {},
}

// CanTransition reports whether moving a Build from `from` to `to` is one of the
// permitted directed edges (Req 2.2). It is pure and table-driven — it consults
// allowedTransitions only, with no side effects — so it doubles as the
// reference model the lifecycle property test (P1) checks the Machine against.
// Self-transitions (from == to) are never permitted, since no status lists
// itself as a successor.
func CanTransition(from, to store.Status) bool {
	for _, next := range allowedTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// IsTerminal reports whether s is a Terminal_Status: live, failed, canceled, or
// terminated. It delegates to the canonical predicate on store.Status (the
// status enum lives in the data layer) so the lifecycle state machine and the
// store can never disagree about which statuses are terminal.
func IsTerminal(s store.Status) bool { return s.IsTerminal() }

// Machine applies Build status transitions, enforcing the permitted-edge table
// and the Progress_Event side effects required by Requirement 2. It depends on
// the store for persistence and on an injected stream.Emitter for events, so it
// can be driven in tests by an InMemoryStore and a fake emitter.
//
// Concurrency: a Build's lifecycle is driven by its single owning goroutine
// (see the build engine), so Transition is not internally synchronized;
// concurrent Transition calls for the same Build are a caller error.
type Machine struct {
	store   store.Store
	emitter stream.Emitter
}

// NewMachine returns a Machine that persists through st and emits
// Progress_Events through em.
func NewMachine(st store.Store, em stream.Emitter) *Machine {
	return &Machine{store: st, emitter: em}
}

// Transition moves the Build identified by buildID to status `to`.
//
// On a permitted edge it persists the new status and then emits exactly one
// `status` Progress_Event carrying it, so the Build_Record and its `status`
// event are both in place before the next transition is processed (Req 2.4). A
// transition to `failed` additionally records `reason` on the Build_Record and
// emits exactly one `error` Progress_Event carrying that reason, after the
// `status` event (Req 2.6).
//
// On a rejected edge it changes nothing: the current status is retained, a
// single `log` Progress_Event recording the rejected transition is emitted (Req
// 2.3), and ErrInvalidTransition is returned. A request for an unknown Build
// returns store.ErrNotFound and emits nothing.
func (m *Machine) Transition(ctx context.Context, buildID string, to store.Status, reason string) error {
	b, err := m.store.GetBuild(ctx, buildID)
	if err != nil {
		return err
	}
	from := b.Status

	if !CanTransition(from, to) {
		// Rejected: retain the current status and record the rejected
		// transition as a single `log` event (Req 2.3).
		if _, emitErr := m.emitter.Emit(ctx, buildID, stream.KindLog, map[string]any{
			"message":  fmt.Sprintf("rejected transition %s -> %s", from, to),
			"from":     string(from),
			"to":       string(to),
			"rejected": true,
		}); emitErr != nil {
			return emitErr
		}
		return fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, from, to)
	}

	// Accepted: persist the new status — and the failure reason first for a
	// `failed` transition (Req 2.6) — before emitting any event, so the
	// Build_Record is consistent before delivery (Req 2.4).
	if err := m.store.SetStatus(ctx, buildID, to); err != nil {
		return err
	}
	if to == store.StatusFailed {
		if err := m.store.SetFailureReason(ctx, buildID, reason); err != nil {
			return err
		}
	}

	// Exactly one `status` event carrying the new status (Req 2.4).
	if _, err := m.emitter.Emit(ctx, buildID, stream.KindStatus, map[string]any{
		"status": string(to),
	}); err != nil {
		return err
	}

	// A `failed` transition emits exactly one `error` event carrying the
	// recorded reason, after the `status` event (Req 2.6).
	if to == store.StatusFailed {
		if _, err := m.emitter.Emit(ctx, buildID, stream.KindError, map[string]any{
			"reason": reason,
		}); err != nil {
			return err
		}
	}

	return nil
}
