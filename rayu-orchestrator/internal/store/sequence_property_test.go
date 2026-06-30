package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"testing"

	"pgregory.net/rapid"
)

// Property P2 — Gap-free, monotonic per-build Sequence_Number.
//
// For K events and ANY interleaving of concurrent AppendEvent calls for one
// build, the set of persisted Sequence_Numbers equals exactly {1, 2, …, K} —
// no gaps, no duplicates — and reading them in insertion order yields a
// strictly increasing sequence starting at 1. A fault-injection variant fires
// concurrent appends against an unknown build: those fail and must burn no
// number, so the surviving committed seqs are still exactly {1..K}.
//
// Validates: Requirements 8.8, 9.1, 9.2, 9.3
func TestPropertyP2GapFreeMonotonicSeq(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		k := rapid.IntRange(1, 200).Draw(rt, "events")
		workers := rapid.IntRange(1, 8).Draw(rt, "workers")
		// Fault-injection variant: concurrent appends to a build that does not
		// exist. Each must return ErrNotFound and consume no sequence number.
		faults := rapid.IntRange(0, 60).Draw(rt, "faulted_appends")

		s := NewInMemoryStore()
		ctx := context.Background()
		if err := s.CreateBuild(ctx, Build{ID: "b", OwnerID: "o", Prompt: "p"}); err != nil {
			rt.Fatalf("CreateBuild: %v", err)
		}

		assigned := make(chan int64, k)
		errs := make(chan error, k+faults)
		var wg sync.WaitGroup

		// Distribute the K real appends across `workers` goroutines so the
		// allocator is exercised under genuine concurrency.
		base, rem := k/workers, k%workers
		for i := 0; i < workers; i++ {
			n := base
			if i < rem {
				n++
			}
			wg.Add(1)
			go func(n int) {
				defer wg.Done()
				for j := 0; j < n; j++ {
					ev, err := s.AppendEvent(ctx, "b", "log", json.RawMessage(`{}`))
					if err != nil {
						errs <- fmt.Errorf("AppendEvent(b): %w", err)
						return
					}
					assigned <- ev.Seq
				}
			}(n)
		}
		// Interleave failed appends against an unknown build.
		for i := 0; i < faults; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := s.AppendEvent(ctx, "missing", "log", json.RawMessage(`{}`)); err != ErrNotFound {
					errs <- fmt.Errorf("AppendEvent(missing) err = %v, want ErrNotFound", err)
				}
			}()
		}

		wg.Wait()
		close(assigned)
		close(errs)
		for err := range errs {
			rt.Fatalf("%v", err)
		}

		// (a) The returned seqs are exactly {1..K}: no gap, no duplicate.
		got := make([]int64, 0, k)
		for seq := range assigned {
			got = append(got, seq)
		}
		if len(got) != k {
			rt.Fatalf("got %d assigned seqs, want %d", len(got), k)
		}
		sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
		seen := make(map[int64]bool, k)
		for i, v := range got {
			if seen[v] {
				rt.Fatalf("duplicate assigned seq %d", v)
			}
			seen[v] = true
			if v != int64(i+1) {
				rt.Fatalf("assigned seqs not gap-free: sorted[%d] = %d, want %d", i, v, i+1)
			}
		}

		// (b) Persisted events read in insertion order are strictly increasing
		// 1..K — the fault appends burned nothing.
		evs, err := s.ReadEvents(ctx, "b", 0)
		if err != nil {
			rt.Fatalf("ReadEvents: %v", err)
		}
		if len(evs) != k {
			rt.Fatalf("persisted %d events, want %d (a faulted append leaked a number)", len(evs), k)
		}
		var prev int64
		for i, ev := range evs {
			if ev.Seq != int64(i+1) {
				rt.Fatalf("persisted seq[%d] = %d, want %d", i, ev.Seq, i+1)
			}
			if ev.Seq <= prev {
				rt.Fatalf("persisted seqs not strictly increasing at %d: %d <= %d", i, ev.Seq, prev)
			}
			prev = ev.Seq
		}

		// (c) The build's NextSeq advanced by exactly K (one per committed
		// append), confirming no fault consumed an allocation.
		b, err := s.GetBuild(ctx, "b")
		if err != nil {
			rt.Fatalf("GetBuild: %v", err)
		}
		if b.NextSeq != int64(k+1) {
			rt.Fatalf("NextSeq = %d, want %d", b.NextSeq, k+1)
		}
	})
}
