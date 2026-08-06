package build

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// recordingEmitter is a fake stream.Emitter that records every emitted event in
// order, so tests can assert the exact kind, payload, and count the state
// machine produces. It assigns its own monotonic Seq, mirroring the Hub
// contract that Emit returns a populated event. failAt optionally makes the Nth
// Emit call fail, to exercise error propagation.
type recordingEmitter struct {
	mu     sync.Mutex
	events []stream.ProgressEvent
	seq    int64
	calls  int
	failAt int // 1-based index of the Emit call that should fail; 0 = never
}

var _ stream.Emitter = (*recordingEmitter)(nil)

func (e *recordingEmitter) Emit(_ context.Context, buildID string, kind stream.Kind, payload map[string]any) (stream.ProgressEvent, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls++
	if e.failAt != 0 && e.calls == e.failAt {
		return stream.ProgressEvent{}, errors.New("injected emit failure")
	}
	e.seq++
	ev := stream.ProgressEvent{
		BuildID: buildID,
		Seq:     e.seq,
		Kind:    kind,
		Payload: payload,
		Ts:      time.Now(),
	}
	e.events = append(e.events, ev)
	return ev, nil
}

func (e *recordingEmitter) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.events)
}

func (e *recordingEmitter) snapshot() []stream.ProgressEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]stream.ProgressEvent, len(e.events))
	copy(out, e.events)
	return out
}

// allStatuses returns the nine lifecycle statuses (Req 2.1) in a stable order.
func allStatuses() []store.Status {
	return []store.Status{
		store.StatusQueued,
		store.StatusProvisioning,
		store.StatusBuilding,
		store.StatusBuildSucceeded,
		store.StatusDeploying,
		store.StatusLive,
		store.StatusFailed,
		store.StatusCanceled,
		store.StatusTerminated,
	}
}

// newMachineWithBuild returns a Machine over a fresh InMemoryStore plus a
// recording emitter, with one build "b" created in the given initial status.
func newMachineWithBuild(t *testing.T, initial store.Status) (*Machine, *store.InMemoryStore, *recordingEmitter) {
	t.Helper()
	st := store.NewInMemoryStore()
	em := &recordingEmitter{}
	m := NewMachine(st, em)
	if err := st.CreateBuild(context.Background(), store.Build{
		ID: "b", OwnerID: "o", Prompt: "p", Status: initial,
	}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	return m, st, em
}

func mustGetBuild(t *testing.T, st store.Store, id string) store.Build {
	t.Helper()
	b, err := st.GetBuild(context.Background(), id)
	if err != nil {
		t.Fatalf("GetBuild(%s): %v", id, err)
	}
	return b
}

// TestCanTransitionExhaustive81Pairs asserts CanTransition against an
// independently-specified edge set for ALL 9×9 = 81 ordered status pairs, so
// the table the state machine consults is pinned to the spec (Req 2.2). This
// proves the reference model that Property P1 relies on.
func TestCanTransitionExhaustive81Pairs(t *testing.T) {
	type edge struct{ from, to store.Status }

	// The 21 permitted directed edges, written out independently of the
	// production allowedTransitions table so the test is a true cross-check.
	permitted := map[edge]bool{
		// forward path
		{store.StatusQueued, store.StatusProvisioning}:      true,
		{store.StatusProvisioning, store.StatusBuilding}:    true,
		{store.StatusBuilding, store.StatusBuildSucceeded}:  true,
		{store.StatusBuildSucceeded, store.StatusDeploying}: true,
		{store.StatusDeploying, store.StatusLive}:           true,
		// any non-terminal → failed
		{store.StatusQueued, store.StatusFailed}:         true,
		{store.StatusProvisioning, store.StatusFailed}:   true,
		{store.StatusBuilding, store.StatusFailed}:       true,
		{store.StatusBuildSucceeded, store.StatusFailed}: true,
		{store.StatusDeploying, store.StatusFailed}:      true,
		// any non-terminal → canceled
		{store.StatusQueued, store.StatusCanceled}:         true,
		{store.StatusProvisioning, store.StatusCanceled}:   true,
		{store.StatusBuilding, store.StatusCanceled}:       true,
		{store.StatusBuildSucceeded, store.StatusCanceled}: true,
		{store.StatusDeploying, store.StatusCanceled}:      true,
		// any non-terminal → terminated
		{store.StatusQueued, store.StatusTerminated}:         true,
		{store.StatusProvisioning, store.StatusTerminated}:   true,
		{store.StatusBuilding, store.StatusTerminated}:       true,
		{store.StatusBuildSucceeded, store.StatusTerminated}: true,
		{store.StatusDeploying, store.StatusTerminated}:      true,
		// live → terminated only
		{store.StatusLive, store.StatusTerminated}: true,
	}
	if len(permitted) != 21 {
		t.Fatalf("reference model has %d edges, want 21", len(permitted))
	}

	statuses := allStatuses()
	if len(statuses) != 9 {
		t.Fatalf("expected 9 statuses, got %d", len(statuses))
	}

	checked := 0
	for _, from := range statuses {
		for _, to := range statuses {
			checked++
			want := permitted[edge{from, to}]
			if got := CanTransition(from, to); got != want {
				t.Errorf("CanTransition(%s, %s) = %v, want %v", from, to, got, want)
			}
		}
	}
	if checked != 81 {
		t.Fatalf("checked %d ordered pairs, want 81", checked)
	}
}

// No status may transition to itself (Req 2.2 lists no self-loop).
func TestCanTransitionRejectsSelfLoops(t *testing.T) {
	for _, s := range allStatuses() {
		if CanTransition(s, s) {
			t.Errorf("CanTransition(%s, %s) = true, want false (no self-loops)", s, s)
		}
	}
}

// IsTerminal must agree with the canonical store predicate and with the
// glossary's four terminal statuses.
func TestIsTerminalMatchesStore(t *testing.T) {
	terminal := map[store.Status]bool{
		store.StatusLive:       true,
		store.StatusFailed:     true,
		store.StatusCanceled:   true,
		store.StatusTerminated: true,
	}
	for _, s := range allStatuses() {
		if IsTerminal(s) != s.IsTerminal() {
			t.Errorf("IsTerminal(%s) = %v, store predicate = %v", s, IsTerminal(s), s.IsTerminal())
		}
		if IsTerminal(s) != terminal[s] {
			t.Errorf("IsTerminal(%s) = %v, want %v", s, IsTerminal(s), terminal[s])
		}
	}
}

// Req 2.4 — an accepted transition persists the new status and emits exactly
// one `status` event carrying it, with no `log`/`error` events.
func TestTransitionAcceptedPersistsAndEmitsStatus(t *testing.T) {
	m, st, em := newMachineWithBuild(t, store.StatusQueued)

	if err := m.Transition(context.Background(), "b", store.StatusProvisioning, ""); err != nil {
		t.Fatalf("Transition: %v", err)
	}

	if got := mustGetBuild(t, st, "b").Status; got != store.StatusProvisioning {
		t.Fatalf("persisted status = %s, want provisioning", got)
	}
	evs := em.snapshot()
	if len(evs) != 1 {
		t.Fatalf("emitted %d events, want 1", len(evs))
	}
	if evs[0].Kind != stream.KindStatus {
		t.Errorf("event kind = %s, want status", evs[0].Kind)
	}
	if s, _ := evs[0].Payload["status"].(string); s != "provisioning" {
		t.Errorf("status payload = %q, want provisioning", s)
	}
}

// Req 2.6 — a `failed` transition records the failure reason and emits a
// `status` event followed by exactly one `error` event carrying the reason.
func TestTransitionFailedRecordsReasonAndEmitsError(t *testing.T) {
	m, st, em := newMachineWithBuild(t, store.StatusBuilding)

	const reason = "result_error_subtype"
	if err := m.Transition(context.Background(), "b", store.StatusFailed, reason); err != nil {
		t.Fatalf("Transition: %v", err)
	}

	b := mustGetBuild(t, st, "b")
	if b.Status != store.StatusFailed {
		t.Fatalf("persisted status = %s, want failed", b.Status)
	}
	if b.FailureReason != reason {
		t.Fatalf("persisted failure reason = %q, want %q", b.FailureReason, reason)
	}

	evs := em.snapshot()
	if len(evs) != 2 {
		t.Fatalf("emitted %d events, want 2 (status, error)", len(evs))
	}
	if evs[0].Kind != stream.KindStatus {
		t.Errorf("event[0] kind = %s, want status", evs[0].Kind)
	}
	if s, _ := evs[0].Payload["status"].(string); s != "failed" {
		t.Errorf("status payload = %q, want failed", s)
	}
	if evs[1].Kind != stream.KindError {
		t.Errorf("event[1] kind = %s, want error", evs[1].Kind)
	}
	if r, _ := evs[1].Payload["reason"].(string); r != reason {
		t.Errorf("error payload reason = %q, want %q", r, reason)
	}
}

// Req 2.3 — a rejected transition retains the status, emits exactly one `log`
// event, and returns ErrInvalidTransition.
func TestTransitionRejectedRetainsStatusAndEmitsLog(t *testing.T) {
	m, st, em := newMachineWithBuild(t, store.StatusBuilding)

	// building → queued is not a permitted edge.
	err := m.Transition(context.Background(), "b", store.StatusQueued, "")
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("err = %v, want ErrInvalidTransition", err)
	}
	if got := mustGetBuild(t, st, "b").Status; got != store.StatusBuilding {
		t.Fatalf("status changed to %s, want building retained", got)
	}

	evs := em.snapshot()
	if len(evs) != 1 {
		t.Fatalf("emitted %d events, want 1 (log)", len(evs))
	}
	if evs[0].Kind != stream.KindLog {
		t.Errorf("event kind = %s, want log", evs[0].Kind)
	}
	if from, _ := evs[0].Payload["from"].(string); from != "building" {
		t.Errorf("log payload from = %q, want building", from)
	}
	if to, _ := evs[0].Payload["to"].(string); to != "queued" {
		t.Errorf("log payload to = %q, want queued", to)
	}
}

// `live` is forward-terminal: the only edge leaving it is live→terminated.
func TestTransitionLiveOnlyToTerminated(t *testing.T) {
	// live → terminated is accepted.
	m, st, _ := newMachineWithBuild(t, store.StatusLive)
	if err := m.Transition(context.Background(), "b", store.StatusTerminated, "idle_reaped"); err != nil {
		t.Fatalf("live->terminated: %v", err)
	}
	if got := mustGetBuild(t, st, "b").Status; got != store.StatusTerminated {
		t.Fatalf("status = %s, want terminated", got)
	}

	// live → failed and live → canceled are rejected.
	for _, to := range []store.Status{store.StatusFailed, store.StatusCanceled, store.StatusDeploying} {
		m2, st2, _ := newMachineWithBuild(t, store.StatusLive)
		if err := m2.Transition(context.Background(), "b", to, "x"); !errors.Is(err, ErrInvalidTransition) {
			t.Errorf("live->%s err = %v, want ErrInvalidTransition", to, err)
		}
		if got := mustGetBuild(t, st2, "b").Status; got != store.StatusLive {
			t.Errorf("live->%s changed status to %s, want live retained", to, got)
		}
	}
}

// A transition request for an unknown Build returns store.ErrNotFound and emits
// nothing.
func TestTransitionUnknownBuildReturnsNotFound(t *testing.T) {
	st := store.NewInMemoryStore()
	em := &recordingEmitter{}
	m := NewMachine(st, em)

	err := m.Transition(context.Background(), "missing", store.StatusProvisioning, "")
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Transition(missing) err = %v, want ErrNotFound", err)
	}
	if n := em.count(); n != 0 {
		t.Fatalf("emitted %d events for an unknown build, want 0", n)
	}
}
