package stream

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// defaultHeartbeatInterval is the SSE idle keep-alive period (Req 10.4). It is
// injectable via WithHeartbeatInterval so tests need not wait in real time.
const defaultHeartbeatInterval = 15 * time.Second

// Redactor removes secrets from a serialized payload before it is persisted and
// delivered. It is the Hub's redaction seam (Req 18.3/18.5, 22.5): every
// Progress_Event payload is routed through it before the gap-free
// Sequence_Number is assigned and the event is appended/streamed, so no event
// path can leak the active BYOK key or a configured secret.
//
// The default is an identity no-op; the real central Redact is installed via
// SetRedactor in a later task (mirroring the obs logger's SetRedactor pattern),
// making the Hub a single choke point through which no secret can escape.
type Redactor func(buildID, s string) string

func identityRedactor(_ string, s string) string { return s }

// subscriber is one open SSE connection's handle on a build's live tail. The
// Hub never delivers event bodies over these channels: the durable store is the
// single ordered source of truth (so persist-before-deliver, Req 9.1, is
// structural and the replay→live boundary cannot gap or duplicate). Instead,
//
//   - wake is a coalescing notification ("new events are persisted, read the
//     tail"); a buffered-1, non-blocking signal means a slow reader can never
//     stall a producer and a dropped wake is always covered by the next
//     ascending store read, and
//   - done is closed by CloseBuild when the build is fully terminal so the
//     reader flushes the final tail and closes the stream (Req 10.5).
type subscriber struct {
	wake      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

func (s *subscriber) markDone() { s.closeOnce.Do(func() { close(s.done) }) }

// Hub is the production Emitter and the SSE fan-out point. It owns the redaction
// seam, persists every Progress_Event to the store before delivery, and tracks
// a per-build set of live SSE subscribers it wakes when new events land.
//
// Delivery model: live events are read from the durable store (the same
// ascending read path as replay, Req 9.4), driven by a coalescing per-build
// wake. This makes "append before deliver" (Req 9.1) inherent — a subscriber
// can only ever observe events that are already persisted — and makes the
// replay→live handoff a single monotonic cursor over the store with no boundary
// gap or duplicate (Req 10.3, P3).
type Hub struct {
	store store.Store

	redactMu sync.RWMutex
	redactor Redactor

	subMu sync.Mutex
	subs  map[string]map[*subscriber]struct{}

	heartbeatInterval time.Duration
}

// Option configures a Hub at construction.
type Option func(*Hub)

// WithHeartbeatInterval overrides the SSE idle heartbeat period (Req 10.4).
// Values <= 0 are ignored. Tests inject a short interval to avoid real waits.
func WithHeartbeatInterval(d time.Duration) Option {
	return func(h *Hub) {
		if d > 0 {
			h.heartbeatInterval = d
		}
	}
}

// WithRedactor installs the redaction hook at construction. SetRedactor can also
// install it later (e.g. once the per-build BYOK key is known).
func WithRedactor(r Redactor) Option {
	return func(h *Hub) {
		if r != nil {
			h.redactor = r
		}
	}
}

// NewHub returns a Hub backed by st, with an identity redactor and the default
// 15s heartbeat interval unless overridden by opts.
func NewHub(st store.Store, opts ...Option) *Hub {
	h := &Hub{
		store:             st,
		redactor:          identityRedactor,
		subs:              map[string]map[*subscriber]struct{}{},
		heartbeatInterval: defaultHeartbeatInterval,
	}
	for _, o := range opts {
		o(h)
	}
	if h.heartbeatInterval <= 0 {
		h.heartbeatInterval = defaultHeartbeatInterval
	}
	if h.redactor == nil {
		h.redactor = identityRedactor
	}
	return h
}

// Hub is the production Emitter (event.go).
var _ Emitter = (*Hub)(nil)

// SetRedactor installs the redaction hook every emitted payload is routed
// through. Wiring the real Redact here (task 19) guarantees no event path can
// bypass redaction. A nil redactor resets to the identity no-op.
func (h *Hub) SetRedactor(r Redactor) {
	h.redactMu.Lock()
	defer h.redactMu.Unlock()
	if r == nil {
		r = identityRedactor
	}
	h.redactor = r
}

func (h *Hub) redact(buildID, s string) string {
	h.redactMu.RLock()
	r := h.redactor
	h.redactMu.RUnlock()
	if r == nil {
		return s
	}
	return r(buildID, s)
}

// Emit redacts the payload, assigns the next gap-free Sequence_Number, and
// appends the event to the store BEFORE delivering it to any SSE stream (Req
// 9.1), then wakes the build's live subscribers so they read the newly
// persisted tail. The fully-populated event (with Seq and Ts set, and its
// payload in redacted form) is returned for the caller's logging/inspection.
//
// Emit is the production implementation of the Emitter interface, so the build
// lifecycle state machine and engine fan out through here unchanged.
func (h *Hub) Emit(ctx context.Context, buildID string, kind Kind, payload map[string]any) (ProgressEvent, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return ProgressEvent{}, err
	}
	if len(raw) == 0 {
		raw = []byte("null")
	}

	// Redaction runs at the single serialized-payload choke point, before the
	// event is persisted or delivered (Req 18.3).
	redacted := h.redact(buildID, string(raw))

	// Persist (assigns the gap-free Seq) before any delivery (Req 9.1).
	ev, err := h.store.AppendEvent(ctx, buildID, string(kind), json.RawMessage(redacted))
	if err != nil {
		return ProgressEvent{}, err
	}

	// Wake live subscribers; they read the persisted tail from the store.
	h.notify(buildID)

	return eventToProgress(ev), nil
}

// Replay returns the persisted Progress_Events for a build with Seq > afterSeq
// in ascending order (afterSeq == 0 returns the full history). It is the
// store-backed read underpinning both SSE replay and the live tail (Req 9.4,
// 9.5, 10.3, 10.6).
func (h *Hub) Replay(ctx context.Context, buildID string, afterSeq int64) ([]ProgressEvent, error) {
	evs, err := h.store.ReadEvents(ctx, buildID, afterSeq)
	if err != nil {
		return nil, err
	}
	out := make([]ProgressEvent, 0, len(evs))
	for _, ev := range evs {
		out = append(out, eventToProgress(ev))
	}
	return out, nil
}

// CloseBuild signals every current subscriber of buildID that the build is
// fully terminal and no further Progress_Events will be produced, so each open
// SSE stream flushes its final tail and closes (Req 10.5). The engine calls
// this after a build reaches a Terminal_Status and all of its events
// (including the terminal `status` and any accompanying `error`/`deploy` event)
// have been emitted. A subscriber that connects after closure instead detects
// the terminal status from the store and replays-then-closes (Req 10.6).
func (h *Hub) CloseBuild(buildID string) {
	for _, s := range h.snapshot(buildID) {
		s.markDone()
	}
}

func (h *Hub) subscribe(buildID string) *subscriber {
	s := &subscriber{
		wake: make(chan struct{}, 1),
		done: make(chan struct{}),
	}
	h.subMu.Lock()
	set := h.subs[buildID]
	if set == nil {
		set = map[*subscriber]struct{}{}
		h.subs[buildID] = set
	}
	set[s] = struct{}{}
	h.subMu.Unlock()
	return s
}

func (h *Hub) unsubscribe(buildID string, s *subscriber) {
	h.subMu.Lock()
	if set := h.subs[buildID]; set != nil {
		delete(set, s)
		if len(set) == 0 {
			delete(h.subs, buildID)
		}
	}
	h.subMu.Unlock()
}

// notify delivers a coalescing, non-blocking wake to every live subscriber of
// buildID. A full wake buffer is intentionally a no-op: the pending wake will
// cause the reader to read all events with Seq > its cursor, covering the
// emit whose wake was dropped, so no event is ever missed.
func (h *Hub) notify(buildID string) {
	for _, s := range h.snapshot(buildID) {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

// snapshot returns the current subscriber set for a build as a slice, so the
// caller can signal each without holding the lock.
func (h *Hub) snapshot(buildID string) []*subscriber {
	h.subMu.Lock()
	defer h.subMu.Unlock()
	set := h.subs[buildID]
	if len(set) == 0 {
		return nil
	}
	out := make([]*subscriber, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	return out
}

// subscriberCount reports the number of live subscribers for a build. It exists
// for tests/observability of the in-memory registry.
func (h *Hub) subscriberCount(buildID string) int {
	h.subMu.Lock()
	defer h.subMu.Unlock()
	return len(h.subs[buildID])
}

// eventToProgress converts a persisted store.Event into a ProgressEvent,
// decoding its (already redacted) JSON payload back into a map. A payload that
// is absent or not a JSON object yields a nil map rather than an error, so a
// single odd row never breaks a stream.
func eventToProgress(ev store.Event) ProgressEvent {
	pe := ProgressEvent{
		BuildID: ev.BuildID,
		Seq:     ev.Seq,
		Kind:    Kind(ev.Kind),
		Ts:      ev.CreatedAt,
	}
	if len(ev.Payload) > 0 {
		_ = json.Unmarshal(ev.Payload, &pe.Payload)
	}
	return pe
}
