package build

import (
	"context"
	"errors"
	"testing"

	"pgregory.net/rapid"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// Property P1 — State-machine transition validity.
//
// Over random transition sequences applied to a Machine over an InMemoryStore,
// starting from the initial status `queued`:
//
//   - the persisted status is always one reachable from `queued` by following
//     only permitted edges — proven by keeping a reference model in lockstep
//     with the store and asserting they agree after every step (Req 2.1, 2.2);
//   - an attempted edge that is not permitted leaves the status unchanged and
//     returns ErrInvalidTransition (Req 2.3);
//   - terminals are sticky: from a Terminal_Status the only accepted edge is
//     live→terminated (Req 2.5 stream/cancel terminality);
//   - each rejected attempt emits exactly one `log` event; each accepted
//     attempt emits exactly one `status` event; and a `failed` transition emits
//     exactly one `error` event carrying — and recording — the reason (Req 2.4,
//     2.6).
//
// The reference model is CanTransition itself, which the exhaustive 81-pair
// table test (TestCanTransitionExhaustive81Pairs) pins to the spec edge set, so
// this property builds on a model that is independently proven correct.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.5
func TestPropertyP1StateMachineTransitionValidity(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		st := store.NewInMemoryStore()
		em := &recordingEmitter{}
		m := NewMachine(st, em)
		ctx := context.Background()

		const buildID = "b"
		if err := st.CreateBuild(ctx, store.Build{
			ID: buildID, OwnerID: "o", Prompt: "p", Status: store.StatusQueued,
		}); err != nil {
			rt.Fatalf("CreateBuild: %v", err)
		}

		// model mirrors the persisted status, advanced ONLY along permitted
		// edges from queued; asserting persisted == model after each step proves
		// the persisted status is always reachable from queued (Req 2.1, 2.2).
		model := store.StatusQueued
		steps := rapid.IntRange(1, 80).Draw(rt, "steps")

		for i := 0; i < steps; i++ {
			// Persisted status and the model agree at the start of every step.
			if cur := persistedStatus(rt, st, buildID); cur != model {
				rt.Fatalf("step %d: persisted status %s != model %s", i, cur, model)
			}
			prev := model

			to := rapid.SampledFrom(allStatuses()).Draw(rt, "to")
			reason := rapid.StringMatching(`[a-z]{1,20}`).Draw(rt, "reason")

			before := em.count()
			err := m.Transition(ctx, buildID, to, reason)
			newEvents := em.snapshot()[before:]
			got := persistedStatus(rt, st, buildID)

			if CanTransition(prev, to) {
				// --- Accepted edge (Req 2.4 / 2.6) ---
				if err != nil {
					rt.Fatalf("accepted %s->%s returned error: %v", prev, to, err)
				}
				model = to
				if got != model {
					rt.Fatalf("accepted %s->%s: persisted %s, want %s", prev, to, got, model)
				}

				if to == store.StatusFailed {
					// Exactly one `status` then one `error`; the reason is both
					// carried by the error event and recorded on the record.
					if len(newEvents) != 2 {
						rt.Fatalf("%s->failed emitted %d events, want 2 (status,error)", prev, len(newEvents))
					}
					if newEvents[0].Kind != stream.KindStatus {
						rt.Fatalf("%s->failed event[0] kind = %s, want status", prev, newEvents[0].Kind)
					}
					if newEvents[1].Kind != stream.KindError {
						rt.Fatalf("%s->failed event[1] kind = %s, want error", prev, newEvents[1].Kind)
					}
					if s, _ := newEvents[0].Payload["status"].(string); s != string(to) {
						rt.Fatalf("status payload = %q, want %q", s, to)
					}
					if r, _ := newEvents[1].Payload["reason"].(string); r != reason {
						rt.Fatalf("error payload reason = %q, want %q", r, reason)
					}
					b, gerr := st.GetBuild(ctx, buildID)
					if gerr != nil {
						rt.Fatalf("GetBuild: %v", gerr)
					}
					if b.FailureReason != reason {
						rt.Fatalf("persisted failure reason = %q, want %q", b.FailureReason, reason)
					}
				} else {
					// Exactly one `status` event (Req 2.4).
					if len(newEvents) != 1 {
						rt.Fatalf("accepted %s->%s emitted %d events, want 1 (status)", prev, to, len(newEvents))
					}
					if newEvents[0].Kind != stream.KindStatus {
						rt.Fatalf("accepted %s->%s event kind = %s, want status", prev, to, newEvents[0].Kind)
					}
					if s, _ := newEvents[0].Payload["status"].(string); s != string(to) {
						rt.Fatalf("status payload = %q, want %q", s, to)
					}
				}
			} else {
				// --- Rejected edge (Req 2.3) ---
				if !errors.Is(err, ErrInvalidTransition) {
					rt.Fatalf("rejected %s->%s returned err %v, want ErrInvalidTransition", prev, to, err)
				}
				if got != prev {
					rt.Fatalf("rejected %s->%s changed status to %s", prev, to, got)
				}
				if len(newEvents) != 1 {
					rt.Fatalf("rejected %s->%s emitted %d events, want 1 (log)", prev, to, len(newEvents))
				}
				if newEvents[0].Kind != stream.KindLog {
					rt.Fatalf("rejected %s->%s event kind = %s, want log", prev, to, newEvents[0].Kind)
				}
			}

			// Terminals are sticky: from a terminal status the ONLY permitted
			// edge is live->terminated.
			if IsTerminal(prev) {
				liveToTerminated := prev == store.StatusLive && to == store.StatusTerminated
				if CanTransition(prev, to) && !liveToTerminated {
					rt.Fatalf("terminal %s accepted transition to %s (only live->terminated permitted)", prev, to)
				}
			}
		}
	})
}

// persistedStatus reads the current persisted status of a build, failing the
// property if the build cannot be read.
func persistedStatus(rt *rapid.T, st store.Store, buildID string) store.Status {
	b, err := st.GetBuild(context.Background(), buildID)
	if err != nil {
		rt.Fatalf("GetBuild(%s): %v", buildID, err)
	}
	return b.Status
}
