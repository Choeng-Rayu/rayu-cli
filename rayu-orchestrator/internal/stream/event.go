package stream

import (
	"context"
	"time"
)

// Kind is the type of a Progress_Event. Exactly ten kinds are allowed (Req
// 8.1); every event the orchestrator persists and streams carries one of them.
type Kind string

const (
	// KindStatus is a build lifecycle status change (Req 2.4).
	KindStatus Kind = "status"
	// KindPhase is a swarm phase marker: scope|plan|build|review|deploy.
	KindPhase Kind = "phase"
	// KindAgent is an agent/collaborator spawn.
	KindAgent Kind = "agent"
	// KindToolUse is a tool invocation.
	KindToolUse Kind = "tool_use"
	// KindToolResult is a tool result.
	KindToolResult Kind = "tool_result"
	// KindFileChange is a workspace file write/edit.
	KindFileChange Kind = "file_change"
	// KindLog is assistant text or an otherwise-unstructured line.
	KindLog Kind = "log"
	// KindDeploy is a deploy-pipeline milestone (Req 12.5).
	KindDeploy Kind = "deploy"
	// KindResult is the swarm's terminal generation outcome (Req 8.6).
	KindResult Kind = "result"
	// KindError is an error line/condition (Req 7.3, 5.8).
	KindError Kind = "error"
)

// allKinds is the canonical, stable ordering of the ten allowed kinds.
var allKinds = []Kind{
	KindStatus, KindPhase, KindAgent, KindToolUse, KindToolResult,
	KindFileChange, KindLog, KindDeploy, KindResult, KindError,
}

// AllKinds returns the ten allowed kinds in a stable order. The returned slice
// is a copy, so callers may not mutate the package's canonical list.
func AllKinds() []Kind {
	out := make([]Kind, len(allKinds))
	copy(out, allKinds)
	return out
}

var kindSet = func() map[Kind]struct{} {
	m := make(map[Kind]struct{}, len(allKinds))
	for _, k := range allKinds {
		m[k] = struct{}{}
	}
	return m
}()

// Valid reports whether k is one of the ten allowed kinds.
func (k Kind) Valid() bool {
	_, ok := kindSet[k]
	return ok
}

// String returns the kind's wire value.
func (k Kind) String() string { return string(k) }

// ProgressEvent is the normalized, append-only progress record (Req 8). It is
// the single event shape both persisted (as a build_events row) and delivered
// over SSE.
//
// BuildID and Seq identify the event within a build; Seq is the gap-free,
// monotonic per-build Sequence_Number (Req 8.8, 9.2) assigned by the Emitter
// when the event is persisted. Payload is the redacted, kind-specific body
// (Req 18.3); its JSON object keys are serialized in a stable (sorted) order by
// encoding/json, so a persisted event round-trips deterministically.
type ProgressEvent struct {
	BuildID string         `json:"buildId"`
	Seq     int64          `json:"seq"`
	Kind    Kind           `json:"kind"`
	Payload map[string]any `json:"payload"`
	Ts      time.Time      `json:"ts"`
}

// Emitter persists and delivers a single progress event for a build. The build
// lifecycle state machine and the build engine depend on this interface; the
// SSE Hub (implemented in a later task) is the production implementation, and a
// fake emitter is used in unit tests.
//
// Emit is responsible for assigning the gap-free Sequence_Number (via the
// store), stamping the timestamp, persisting BEFORE delivery (Req 9.1), and
// fanning out to subscribers. Callers therefore supply only the buildID, kind,
// and payload, and receive back the fully-populated event (with Seq and Ts set)
// for logging/inspection.
type Emitter interface {
	Emit(ctx context.Context, buildID string, kind Kind, payload map[string]any) (ProgressEvent, error)
}
