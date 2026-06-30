// Package store defines the durable persistence boundary for the orchestrator
// over three records — builds, build_events (append-only), and routes — and
// provides an in-memory implementation.
//
// Persistence is reached only through the Store interface so the engine can be
// driven by InMemoryStore now (the requirements-permitted first increment and
// the substrate for property tests) and a MySQLStore later, without changing
// any caller. The canonical build Status enum and its Active/Terminal
// predicates live here, in the data layer, because the store itself must
// categorize builds for the owner-scoped quota and authorization queries; the
// build package layers its transition state machine on top of these.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// ErrNotFound is returned when a build or route does not exist.
var ErrNotFound = errors.New("store: not found")

// Status is a build's lifecycle status (Req 2.1).
type Status string

const (
	StatusQueued         Status = "queued"
	StatusProvisioning   Status = "provisioning"
	StatusBuilding       Status = "building"
	StatusBuildSucceeded Status = "build_succeeded"
	StatusDeploying      Status = "deploying"
	StatusLive           Status = "live"
	StatusFailed         Status = "failed"
	StatusCanceled       Status = "canceled"
	StatusTerminated     Status = "terminated"
)

// IsTerminal reports whether s is a Terminal_Status: live, failed, canceled, or
// terminated (per the requirements glossary).
func (s Status) IsTerminal() bool {
	switch s {
	case StatusLive, StatusFailed, StatusCanceled, StatusTerminated:
		return true
	default:
		return false
	}
}

// IsActive reports whether s is an Active_Build status: queued, provisioning,
// building, build_succeeded, or deploying. Active and Terminal partition the
// status space, so IsActive == !IsTerminal.
func (s Status) IsActive() bool { return !s.IsTerminal() }

// Build is the persisted Build_Record (Req 1, 2, 16, 17, 19). The BYOK key is
// deliberately absent — it is never persisted (Req 18.1).
type Build struct {
	ID            string
	OwnerID       string
	Status        Status
	Prompt        string
	NextSeq       int64 // gap-free per-build sequence allocator; starts at 1
	FailureReason string
	SubdomainURL  string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// Event is a persisted Build_Event (Req 8, 9). Payload is opaque, redacted JSON
// owned by the stream layer; the store only assigns Seq and preserves order.
type Event struct {
	BuildID   string
	Seq       int64
	Kind      string
	Payload   json.RawMessage
	CreatedAt time.Time
}

// Route is the persisted Route_Record (Req 14, 19).
type Route struct {
	BuildID      string
	Subdomain    string
	ContainerID  string
	InternalPort int
	LastAccessAt time.Time
	CreatedAt    time.Time
}

// Store is the persistence boundary over builds, build_events, and routes.
type Store interface {
	// Builds.
	CreateBuild(ctx context.Context, b Build) error
	GetBuild(ctx context.Context, id string) (Build, error)
	SetStatus(ctx context.Context, id string, status Status) error
	SetFailureReason(ctx context.Context, id, reason string) error
	SetSubdomainURL(ctx context.Context, id, url string) error

	// Append-only events. AppendEvent assigns the next gap-free per-build
	// Sequence_Number and returns the stored event (with Seq and CreatedAt set).
	// ReadEvents returns events with Seq > afterSeq in ascending Seq order
	// (afterSeq == 0 returns the full history).
	AppendEvent(ctx context.Context, buildID, kind string, payload json.RawMessage) (Event, error)
	ReadEvents(ctx context.Context, buildID string, afterSeq int64) ([]Event, error)

	// Routes.
	PutRoute(ctx context.Context, r Route) error
	GetRoute(ctx context.Context, buildID string) (Route, error)
	DeleteRoute(ctx context.Context, buildID string) error
	ListRoutes(ctx context.Context) ([]Route, error)
	TouchRoute(ctx context.Context, buildID string, at time.Time) error

	// Owner-scoped queries backing per-user authorization and quotas (Req 16, 17).
	// CountActiveByOwner counts the owner's non-terminal builds (Concurrency_Quota);
	// CountCreatedSince counts the owner's builds created at or after t (Daily_Quota).
	CountActiveByOwner(ctx context.Context, ownerID string) (int, error)
	CountCreatedSince(ctx context.Context, ownerID string, since time.Time) (int, error)

	Close() error
}
