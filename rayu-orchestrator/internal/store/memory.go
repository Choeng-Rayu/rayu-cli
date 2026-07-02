package store

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// InMemoryStore is a process-memory implementation of Store. It is safe for
// concurrent use: every operation holds a single mutex, which also makes the
// per-build sequence allocation atomic (sequence read, event append, and
// next-seq increment happen together, so a failed append — e.g. an unknown
// build — consumes no number and leaves no gap).
type InMemoryStore struct {
	mu     sync.Mutex
	builds map[string]Build
	events map[string][]Event
	routes map[string]Route
	now    func() time.Time // injectable clock; defaults to time.Now
}

// NewInMemoryStore returns an empty in-memory store.
func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{
		builds: map[string]Build{},
		events: map[string][]Event{},
		routes: map[string]Route{},
		now:    time.Now,
	}
}

var _ Store = (*InMemoryStore)(nil)

func (s *InMemoryStore) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *InMemoryStore) CreateBuild(_ context.Context, b Build) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b.ID == "" {
		return errInvalid("build id is required")
	}
	if _, ok := s.builds[b.ID]; ok {
		return errInvalid("build " + b.ID + " already exists")
	}
	now := s.clock()
	if b.CreatedAt.IsZero() {
		b.CreatedAt = now
	}
	if b.UpdatedAt.IsZero() {
		b.UpdatedAt = b.CreatedAt
	}
	if b.NextSeq == 0 {
		b.NextSeq = 1
	}
	if b.Status == "" {
		b.Status = StatusQueued
	}
	s.builds[b.ID] = b
	return nil
}

func (s *InMemoryStore) GetBuild(_ context.Context, id string) (Build, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.builds[id]
	if !ok {
		return Build{}, ErrNotFound
	}
	return b, nil
}

func (s *InMemoryStore) SetStatus(_ context.Context, id string, status Status) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.builds[id]
	if !ok {
		return ErrNotFound
	}
	b.Status = status
	b.UpdatedAt = s.clock()
	s.builds[id] = b
	return nil
}

func (s *InMemoryStore) SetFailureReason(_ context.Context, id, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.builds[id]
	if !ok {
		return ErrNotFound
	}
	b.FailureReason = reason
	b.UpdatedAt = s.clock()
	s.builds[id] = b
	return nil
}

func (s *InMemoryStore) SetSubdomainURL(_ context.Context, id, url string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.builds[id]
	if !ok {
		return ErrNotFound
	}
	b.SubdomainURL = url
	b.UpdatedAt = s.clock()
	s.builds[id] = b
	return nil
}

func (s *InMemoryStore) AppendEvent(_ context.Context, buildID, kind string, payload json.RawMessage) (Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.builds[buildID]
	if !ok {
		// No number is consumed: the build's NextSeq is untouched.
		return Event{}, ErrNotFound
	}
	ev := Event{
		BuildID:   buildID,
		Seq:       b.NextSeq,
		Kind:      kind,
		Payload:   cloneRaw(payload),
		CreatedAt: s.clock(),
	}
	s.events[buildID] = append(s.events[buildID], ev)
	b.NextSeq++
	b.UpdatedAt = ev.CreatedAt
	s.builds[buildID] = b
	return cloneEvent(ev), nil
}

func (s *InMemoryStore) ReadEvents(_ context.Context, buildID string, afterSeq int64) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.builds[buildID]; !ok {
		return nil, ErrNotFound
	}
	// Stored in append order, which is ascending Seq by construction.
	var out []Event
	for _, ev := range s.events[buildID] {
		if ev.Seq > afterSeq {
			out = append(out, cloneEvent(ev))
		}
	}
	return out, nil
}

func (s *InMemoryStore) PutRoute(_ context.Context, r Route) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.BuildID == "" {
		return errInvalid("route build id is required")
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = s.clock()
	}
	if r.LastAccessAt.IsZero() {
		r.LastAccessAt = r.CreatedAt
	}
	s.routes[r.BuildID] = r
	return nil
}

func (s *InMemoryStore) GetRoute(_ context.Context, buildID string) (Route, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.routes[buildID]
	if !ok {
		return Route{}, ErrNotFound
	}
	return r, nil
}

func (s *InMemoryStore) DeleteRoute(_ context.Context, buildID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.routes[buildID]; !ok {
		return ErrNotFound
	}
	delete(s.routes, buildID)
	return nil
}

func (s *InMemoryStore) ListRoutes(_ context.Context) ([]Route, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Route, 0, len(s.routes))
	for _, r := range s.routes {
		out = append(out, r)
	}
	return out, nil
}

func (s *InMemoryStore) TouchRoute(_ context.Context, buildID string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.routes[buildID]
	if !ok {
		return ErrNotFound
	}
	// Monotonic: never move last-access backwards (Req 19 last-access semantics).
	if at.After(r.LastAccessAt) {
		r.LastAccessAt = at
		s.routes[buildID] = r
	}
	return nil
}

func (s *InMemoryStore) CountActiveByOwner(_ context.Context, ownerID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, b := range s.builds {
		if b.OwnerID == ownerID && b.Status.IsActive() {
			n++
		}
	}
	return n, nil
}

func (s *InMemoryStore) CountCreatedSince(_ context.Context, ownerID string, since time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, b := range s.builds {
		if b.OwnerID == ownerID && !b.CreatedAt.Before(since) {
			n++
		}
	}
	return n, nil
}

// Close is a no-op for the in-memory store.
func (s *InMemoryStore) Close() error { return nil }

func cloneRaw(p json.RawMessage) json.RawMessage {
	if p == nil {
		return nil
	}
	out := make(json.RawMessage, len(p))
	copy(out, p)
	return out
}

func cloneEvent(ev Event) Event {
	ev.Payload = cloneRaw(ev.Payload)
	return ev
}

type invalidError string

func (e invalidError) Error() string { return string(e) }

func errInvalid(msg string) error { return invalidError(msg) }
