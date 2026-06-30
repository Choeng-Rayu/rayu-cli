package build

import (
	"context"
	"fmt"
	"testing"

	"pgregory.net/rapid"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// Property P7 — Quota accounting consistency.
//
// For all create/terminal interleavings, an owner's tracked Active_Build count
// (Quota.ActiveCount) equals the number of that owner's non-terminal builds in
// the Store (CountActiveByOwner), is never negative, and is decremented exactly
// once per build reaching a Terminal_Status.
//
// The model drives the Store and the Quota in lockstep — exactly as the engine
// does (Track on create, Untrack on terminal) — under a randomized mix of
// operations:
//
//   - create:    a new queued build → store.CreateBuild + quota.Track
//   - terminal:  an active build → store.SetStatus(terminal) + quota.Untrack
//   - reuntrack: quota.Untrack on an already-terminal build, which must be a
//     no-op (proving the decrement is exactly-once and the count never goes
//     negative)
//
// After every operation the invariant quota.ActiveCount(owner) ==
// store.CountActiveByOwner(owner) is asserted for every owner, and the tracked
// count is asserted non-negative.
//
// Validates: Requirements 17.1, 17.5
func TestPropertyP7QuotaAccountingConsistency(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		st := store.NewInMemoryStore()
		// Limits are irrelevant here — this property exercises the Track/Untrack
		// accounting, not the create-time admission check — so they are set high.
		q := NewQuota(st, 1_000_000, 1_000_000)
		ctx := context.Background()

		owners := []string{"o0", "o1", "o2"}
		terminals := []store.Status{store.StatusFailed, store.StatusCanceled, store.StatusTerminated, store.StatusLive}

		// active[id] reports whether the build is still non-terminal in the model;
		// terminalIDs accumulates builds that have reached a terminal status (for
		// the re-untrack no-op case).
		active := map[string]bool{}
		var activeIDs, terminalIDs []string
		nextID := 0

		ops := rapid.IntRange(1, 60).Draw(rt, "ops")
		for i := 0; i < ops; i++ {
			switch rapid.SampledFrom([]string{"create", "terminal", "reuntrack"}).Draw(rt, "op") {
			case "create":
				owner := rapid.SampledFrom(owners).Draw(rt, "owner")
				id := fmt.Sprintf("b%d", nextID)
				nextID++
				if err := st.CreateBuild(ctx, store.Build{ID: id, OwnerID: owner, Status: store.StatusQueued, Prompt: "p"}); err != nil {
					rt.Fatalf("CreateBuild: %v", err)
				}
				q.Track(owner, id)
				active[id] = true
				activeIDs = append(activeIDs, id)

			case "terminal":
				if len(activeIDs) == 0 {
					continue
				}
				k := rapid.IntRange(0, len(activeIDs)-1).Draw(rt, "active_idx")
				id := activeIDs[k]
				activeIDs = append(activeIDs[:k], activeIDs[k+1:]...)
				to := rapid.SampledFrom(terminals).Draw(rt, "terminal_status")
				if err := st.SetStatus(ctx, id, to); err != nil {
					rt.Fatalf("SetStatus: %v", err)
				}
				q.Untrack(id)
				active[id] = false
				terminalIDs = append(terminalIDs, id)

			case "reuntrack":
				if len(terminalIDs) == 0 {
					continue
				}
				k := rapid.IntRange(0, len(terminalIDs)-1).Draw(rt, "terminal_idx")
				// Untrack an already-terminal build: an exactly-once decrement makes
				// this a no-op, so the invariant below must still hold.
				q.Untrack(terminalIDs[k])
			}

			// Invariant: tracked active count == non-terminal builds in the store,
			// and is never negative, for every owner.
			for _, owner := range owners {
				want, err := st.CountActiveByOwner(ctx, owner)
				if err != nil {
					rt.Fatalf("CountActiveByOwner: %v", err)
				}
				got := q.ActiveCount(owner)
				if got < 0 {
					rt.Fatalf("owner %s tracked active count is negative: %d", owner, got)
				}
				if got != want {
					rt.Fatalf("owner %s tracked active count = %d, store non-terminal = %d (after op %d)", owner, got, want, i)
				}
			}
		}
	})
}
