// Package orgcredits resolves and caches a TEAM member's billing state (the
// org's plan, the member's per-seat bucket, and the shared credit pool).
//
// It is separate from internal/entitlements on purpose. That cache answers "what
// may this USER do", keyed by user id, and every existing handler depends on that
// shape. Team billing is keyed by (org, member) and only matters for the small
// subset of requests whose JWT carries an `orgId` claim, so bolting it onto the
// user cache would have made the common path pay for a feature it never uses —
// and would have forced every test fake of that cache to grow a method.
package orgcredits

import (
	"context"
	"sync"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// Source is the slice of the store this package needs. Narrowing it here keeps
// the resolver testable without a live MySQL.
type Source interface {
	OrgMemberState(ctx context.Context, orgID, userID int64) (*store.OrgMemberState, error)
}

// resolveDeadline bounds the single database read on a cache miss, mirroring the
// user entitlement cache: the gateway must be the component that answers first,
// rather than hanging until a reverse proxy times out.
const resolveDeadline = 3 * time.Second

type key struct{ orgID, userID int64 }

type entry struct {
	state *store.OrgMemberState
	exp   time.Time
}

// Resolver caches per-(org, member) state for a short TTL.
type Resolver struct {
	src Source
	ttl time.Duration

	mu      sync.Mutex
	entries map[key]entry
}

// New builds a resolver. A zero/negative ttl falls back to 30s so a
// misconfiguration cannot turn every request into a database read.
func New(src Source, ttl time.Duration) *Resolver {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Resolver{src: src, ttl: ttl, entries: map[key]entry{}}
}

// Resolve returns the member's team billing state, or (nil, nil) when the user
// holds no seat in that org.
//
// A nil result is the deliberate fallback for a STALE claim: an access token
// lives up to an hour, so a member removed five minutes ago still presents an
// `orgId`. Rather than failing their request, the caller bills them
// individually — which is exactly what they are now.
func (r *Resolver) Resolve(ctx context.Context, orgID, userID int64) (*store.OrgMemberState, error) {
	if r == nil || r.src == nil || orgID <= 0 {
		return nil, nil
	}
	k := key{orgID, userID}
	now := time.Now()
	r.mu.Lock()
	if e, ok := r.entries[k]; ok && e.exp.After(now) {
		r.mu.Unlock()
		return e.state, nil
	}
	r.mu.Unlock()

	rctx, cancel := context.WithTimeout(ctx, resolveDeadline)
	defer cancel()
	state, err := r.src.OrgMemberState(rctx, orgID, userID)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.entries[k] = entry{state: state, exp: now.Add(r.ttl)}
	// Piggy-back the sweep on writes: nothing else removes entries, so a
	// long-running gateway would otherwise keep one per member forever.
	for ek, ev := range r.entries {
		if !ev.exp.After(now) {
			delete(r.entries, ek)
		}
	}
	r.mu.Unlock()
	return state, nil
}

// Invalidate drops a cached entry so the next Resolve re-reads MySQL. Called
// after a settle changes the bucket/pool, so the numbers a member sees follow
// their own spending instead of lagging a whole TTL behind it.
func (r *Resolver) Invalidate(orgID, userID int64) {
	if r == nil {
		return
	}
	r.mu.Lock()
	delete(r.entries, key{orgID, userID})
	r.mu.Unlock()
}

// Cached reports how many entries are held (tests/diagnostics).
func (r *Resolver) Cached() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}
