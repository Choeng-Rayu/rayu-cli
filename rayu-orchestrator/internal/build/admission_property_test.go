package build

import (
	"context"
	"fmt"
	"testing"

	"pgregory.net/rapid"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// Property P6 — Admission ordering & bounds.
//
// The admitted build is always the longest-queued whose owner is under
// PER_USER_CONCURRENCY; the count of building sandboxes never exceeds
// MAX_CONCURRENT_BUILDS; and a per-user-blocked build stays queued.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4

// TestPropertyP6SelectAdmissibleOrdering proves the pure admission-selection
// function against an INDEPENDENT reference scan: with a free global slot it
// returns the smallest index (longest-queued) whose owner is under the per-user
// cap, skipping per-user-blocked builds; with no free slot it returns -1. This
// pins the "longest-queued admissible" and "per-user-blocked is skipped"
// guarantees (Req 3.2, 3.3, 3.4) and the global-cap bound (Req 3.1).
func TestPropertyP6SelectAdmissibleOrdering(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		owners := []string{"o0", "o1", "o2", "o3"}
		maxConcurrent := rapid.IntRange(1, 5).Draw(rt, "maxConcurrent")
		perUser := rapid.IntRange(1, 4).Draw(rt, "perUserConcurrency")
		building := rapid.IntRange(0, maxConcurrent+2).Draw(rt, "building")

		n := rapid.IntRange(0, 12).Draw(rt, "queueLen")
		queue := make([]queuedBuild, n)
		for i := 0; i < n; i++ {
			o := rapid.SampledFrom(owners).Draw(rt, fmt.Sprintf("owner_%d", i))
			queue[i] = queuedBuild{buildID: fmt.Sprintf("b%d", i), ownerID: o}
		}
		perOwner := map[string]int{}
		for _, o := range owners {
			perOwner[o] = rapid.IntRange(0, perUser+1).Draw(rt, "perOwner_"+o)
		}

		// Independent reference: the expected admission decision.
		want := -1
		if building < maxConcurrent {
			for i := range queue {
				if perOwner[queue[i].ownerID] < perUser {
					want = i
					break
				}
			}
		}

		got := selectAdmissible(queue, perOwner, building, maxConcurrent, perUser)
		if got != want {
			rt.Fatalf("selectAdmissible = %d, want %d (queue=%v perOwner=%v building=%d max=%d per=%d)",
				got, want, queue, perOwner, building, maxConcurrent, perUser)
		}
	})
}

// TestPropertyP6PoolBoundsAndMaximality drives the REAL pool through random
// enqueue/release interleavings and asserts, after every operation:
//
//   - the global building count never exceeds MAX_CONCURRENT_BUILDS (Req 3.1);
//   - no owner's building count exceeds PER_USER_CONCURRENCY (Req 3.4);
//   - maximality: if a global slot is free, every still-queued build's owner is
//     at the per-user cap — i.e. the pool never leaves an admissible build
//     waiting, so the longest-queued admissible was admitted and a per-user-
//     blocked build correctly stays queued (Req 3.2, 3.3, 3.4); and
//   - admitted builds are persisted as provisioning; queued builds as queued.
func TestPropertyP6PoolBoundsAndMaximality(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		maxConcurrent := rapid.IntRange(1, 4).Draw(rt, "maxConcurrent")
		perUser := rapid.IntRange(1, 3).Draw(rt, "perUserConcurrency")
		owners := []string{"o0", "o1", "o2"}

		st := store.NewInMemoryStore()
		em := &recordingEmitter{}
		m := NewMachine(st, em)
		log := &admitLog{}
		p := NewPool(context.Background(), m, em, maxConcurrent, perUser, log.hook)
		ctx := context.Background()

		// Reference model. queuedOwner/heldOwner map a build id to its owner;
		// processed tracks how far we have reconciled the admit log.
		queuedOwner := map[string]string{}
		var queuedOrder []string // FIFO of still-queued build ids (model view)
		heldOwner := map[string]string{}
		processed := 0
		nextID := 0

		// reconcile moves builds the pool just admitted (new admit-log entries)
		// from the model's queued set into its held set.
		reconcile := func() {
			admitted := log.list()
			for ; processed < len(admitted); processed++ {
				id := admitted[processed]
				owner, ok := queuedOwner[id]
				if !ok {
					rt.Fatalf("pool admitted %s which the model did not have queued", id)
				}
				delete(queuedOwner, id)
				for i := range queuedOrder {
					if queuedOrder[i] == id {
						queuedOrder = append(queuedOrder[:i], queuedOrder[i+1:]...)
						break
					}
				}
				heldOwner[id] = owner
			}
		}

		checkInvariants := func(stepDesc string) {
			// (1) global bound.
			if p.Building() > maxConcurrent {
				rt.Fatalf("%s: building %d exceeds max %d", stepDesc, p.Building(), maxConcurrent)
			}
			if p.Building() != len(heldOwner) {
				rt.Fatalf("%s: pool building %d != model held %d", stepDesc, p.Building(), len(heldOwner))
			}
			// (2) per-user bound + per-owner agreement.
			ownerHeld := map[string]int{}
			for _, o := range heldOwner {
				ownerHeld[o]++
			}
			for _, o := range owners {
				if ownerHeld[o] > perUser {
					rt.Fatalf("%s: owner %s building %d exceeds per-user %d", stepDesc, o, ownerHeld[o], perUser)
				}
				if p.OwnerBuilding(o) != ownerHeld[o] {
					rt.Fatalf("%s: pool owner %s building %d != model %d", stepDesc, o, p.OwnerBuilding(o), ownerHeld[o])
				}
			}
			// (3) maximality: a free global slot implies every queued build's owner
			// is at the per-user cap (nothing admissible was left waiting).
			if p.Building() < maxConcurrent {
				for _, id := range queuedOrder {
					if ownerHeld[queuedOwner[id]] < perUser {
						rt.Fatalf("%s: admissible build %s (owner %s held=%d<per=%d) left queued with a free slot",
							stepDesc, id, queuedOwner[id], ownerHeld[queuedOwner[id]], perUser)
					}
				}
			}
			// (4) persisted statuses match the model.
			for id := range heldOwner {
				if s := statusOf(t, st, id); s != store.StatusProvisioning {
					rt.Fatalf("%s: held build %s status = %s, want provisioning", stepDesc, id, s)
				}
			}
			for _, id := range queuedOrder {
				if s := statusOf(t, st, id); s != store.StatusQueued {
					rt.Fatalf("%s: queued build %s status = %s, want queued", stepDesc, id, s)
				}
			}
		}

		ops := rapid.IntRange(1, 50).Draw(rt, "ops")
		for i := 0; i < ops; i++ {
			op := rapid.SampledFrom([]string{"enqueue", "enqueue", "release"}).Draw(rt, "op")
			if op == "enqueue" {
				owner := rapid.SampledFrom(owners).Draw(rt, "owner")
				id := fmt.Sprintf("b%d", nextID)
				nextID++
				if err := st.CreateBuild(ctx, store.Build{ID: id, OwnerID: owner, Status: store.StatusQueued, Prompt: "p"}); err != nil {
					rt.Fatalf("CreateBuild: %v", err)
				}
				queuedOwner[id] = owner
				queuedOrder = append(queuedOrder, id)
				p.Enqueue(id, owner)
			} else {
				// Release a currently-held build, if any.
				var held []string
				for id := range heldOwner {
					held = append(held, id)
				}
				if len(held) == 0 {
					continue
				}
				// Deterministic pick from a sorted-ish list via rapid index.
				k := rapid.IntRange(0, len(held)-1).Draw(rt, "release_idx")
				id := held[k]
				delete(heldOwner, id)
				p.Release(id)
			}
			reconcile()
			checkInvariants(fmt.Sprintf("op %d (%s)", i, op))
		}
	})
}
