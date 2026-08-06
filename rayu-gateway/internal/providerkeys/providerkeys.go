// Package providerkeys picks which of a provider's API keys to use, and tracks
// each key's health in memory.
//
// # WHY PER-KEY STATE
//
// A provider may hold several keys precisely so that one hitting a rate limit
// doesn't stop traffic. That only works if failures are attributed to the KEY
// that caused them: treating a provider's keys as one blob means a single
// exhausted credential looks like "the provider is down".
//
// So each key has its own state:
//
//	active        usable now
//	cooling       a 429 was seen; skipped until cooldownUntil passes
//	invalid       a 401/403 was seen (or it failed to decrypt); skipped until an
//	              admin replaces it — retrying a rejected credential just burns
//	              latency and can trip provider-side abuse counters
//	disabled      an admin switched it off
//
// # SPEED
//
// Everything here is in memory: a request never reads the database and never
// decrypts. State changes are reported to a sink (the gateway's bounded event
// queue) so they survive a restart without putting a write on the request path.
package providerkeys

import (
	"sync"
	"time"
)

// Status is a key's health. Values match the backend's PROVIDER_KEY_STATUSES so
// the dashboard renders what the gateway observed.
type Status string

const (
	StatusActive      Status = "active"
	StatusRateLimited Status = "rate_limited"
	StatusInvalid     Status = "invalid"
	StatusDisabled    Status = "disabled"
)

// DefaultCooldown is how long a rate-limited key is skipped when the provider
// gives no Retry-After. Long enough to let a per-minute quota recover, short
// enough that a multi-key provider isn't left with fewer keys than it has.
const DefaultCooldown = 60 * time.Second

// MaxCooldown caps a provider-supplied Retry-After: a provider asking for an hour
// must not silently remove a key from rotation for an hour.
const MaxCooldown = 10 * time.Minute

// Key is one decrypted, ready-to-use credential.
type Key struct {
	ID       int64
	Label    string
	Secret   string // plaintext, in memory only
	Masked   string // safe to log
	Priority int
	// Enabled is the admin switch from the database.
	Enabled bool
	// Status is the persisted status the row carried at load time; the in-memory
	// state machine may move it on from there.
	Status Status
	// CooldownUntil is the persisted cooldown, so a restart doesn't immediately
	// re-hammer a key the provider was still rate-limiting.
	CooldownUntil time.Time
}

// StateChange is an observed health transition, handed to the sink for durable
// write-back. Keeping this a plain value (not a DB call) is what keeps the
// request path free of I/O.
type StateChange struct {
	KeyID         int64
	Status        Status
	CooldownUntil time.Time
	// LastError is a short, log-safe reason (e.g. "HTTP 429"). Never a key.
	LastError string
	UsedAt    time.Time
}

// Sink receives state changes asynchronously. Implementations must not block.
type Sink func(StateChange)

// keyState is the mutable half of a key, kept separate so a config refresh can
// replace the immutable half without losing live health.
type keyState struct {
	status        Status
	cooldownUntil time.Time
	// undecryptable marks "invalid because THIS gateway could not open the
	// envelope", which is a property of the master key rather than of the
	// credential. It must never be latched across refreshes: fixing
	// RAYU_PROVIDER_SECRET has to bring the key back without a restart.
	undecryptable bool
}

// Registry holds per-provider key sets and their live health.
type Registry struct {
	mu   sync.Mutex
	sets map[int64][]Key               // provider id → keys, priority order
	live map[int64]map[int64]*keyState // provider id → key id → state
	sink Sink
	now  func() time.Time
}

// New creates an empty registry. sink may be nil (state stays in memory only).
func New(sink Sink) *Registry {
	return &Registry{
		sets: map[int64][]Key{},
		live: map[int64]map[int64]*keyState{},
		sink: sink,
		now:  time.Now,
	}
}

// Replace installs the key set for a provider, PRESERVING the live health of keys
// whose CREDENTIAL is unchanged.
//
// Preserving health matters: config refreshes every 30s, and if a refresh reset
// health, a rate-limited key would be retried every 30s regardless of its
// cooldown — exactly the hammering the cooldown exists to prevent.
//
// But three cases must NOT be preserved, or a fixed key would stay dead until the
// process restarts:
//
//   - the secret is empty (it could not be decrypted): that is a statement about
//     THIS gateway's master key, not about the credential, so it is re-evaluated
//     on every refresh and never latched;
//   - the secret CHANGED: an admin replaced the key in the dashboard, so the old
//     verdict was about a credential that no longer exists;
//   - the key is new to this registry: start from what the database recorded.
func (r *Registry) Replace(providerID int64, keys []Key) {
	r.mu.Lock()
	defer r.mu.Unlock()

	prev := r.live[providerID]
	prevSecret := make(map[int64]string, len(r.sets[providerID]))
	for _, k := range r.sets[providerID] {
		prevSecret[k.ID] = k.Secret
	}

	next := make(map[int64]*keyState, len(keys))
	for _, k := range keys {
		if k.Secret == "" {
			// Unusable, but recoverable the moment the master key is fixed.
			next[k.ID] = &keyState{status: StatusInvalid, undecryptable: true}
			continue
		}
		p, wasKnown := prev[k.ID]
		if wasKnown && !p.undecryptable && prevSecret[k.ID] == k.Secret {
			next[k.ID] = p // same credential → keep observed health
			continue
		}
		if prevSecret[k.ID] != "" && prevSecret[k.ID] != k.Secret {
			// A replacement deserves a clean slate: any stored verdict describes the
			// credential that was thrown away.
			next[k.ID] = &keyState{status: StatusActive}
			continue
		}
		// New to this registry, or newly decryptable: trust what the database says.
		st := k.Status
		if st == "" {
			st = StatusActive
		}
		next[k.ID] = &keyState{status: st, cooldownUntil: k.CooldownUntil}
	}
	r.sets[providerID] = keys
	r.live[providerID] = next
}

// Forget drops a provider entirely (deleted in the dashboard).
func (r *Registry) Forget(providerID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sets, providerID)
	delete(r.live, providerID)
}

// Pick returns the keys to try for a provider, best first, EXCLUDING keys that
// are disabled, invalid, or still cooling down.
//
// It returns the whole usable list (not just one key) so the caller can fail over
// within a single request without another round of bookkeeping.
func (r *Registry) Pick(providerID int64) []Key {
	r.mu.Lock()
	now := r.now()
	states := r.live[providerID]
	out := make([]Key, 0, len(r.sets[providerID]))
	// Keys whose cooldown just elapsed. Collected here and reported AFTER the lock
	// is released: the sink is caller-supplied (it enqueues a database write), and
	// calling it under the registry lock would let an unrelated component stall
	// every request that needs a key.
	var restored []int64
	for _, k := range r.sets[providerID] {
		if !k.Enabled {
			continue
		}
		st := states[k.ID]
		if st == nil {
			out = append(out, k)
			continue
		}
		switch st.status {
		case StatusInvalid, StatusDisabled:
			continue
		case StatusRateLimited:
			if now.Before(st.cooldownUntil) {
				continue // still cooling
			}
			// Cooldown elapsed: give it another chance and say so, so the
			// dashboard stops showing a stale "rate limited".
			st.status = StatusActive
			st.cooldownUntil = time.Time{}
			restored = append(restored, k.ID)
		}
		out = append(out, k)
	}
	r.mu.Unlock()
	for _, id := range restored {
		r.emit(StateChange{KeyID: id, Status: StatusActive, UsedAt: now})
	}
	return out
}

// Usable reports how many keys could serve a request right now (health output).
func (r *Registry) Usable(providerID int64) int { return len(r.Pick(providerID)) }

// MarkRateLimited puts a key on cooldown after a 429. retryAfter of 0 uses
// DefaultCooldown; anything longer than MaxCooldown is capped so a provider can't
// remove a key from rotation indefinitely.
func (r *Registry) MarkRateLimited(providerID, keyID int64, retryAfter time.Duration) {
	if retryAfter <= 0 {
		retryAfter = DefaultCooldown
	}
	if retryAfter > MaxCooldown {
		retryAfter = MaxCooldown
	}
	r.transition(providerID, keyID, StatusRateLimited, r.now().Add(retryAfter), "HTTP 429 rate limited")
}

// MarkInvalid takes a key out of rotation after an auth/permission failure or a
// decrypt failure. It stays out until an admin replaces it: retrying a credential
// the provider has rejected wastes latency and can trip abuse counters.
func (r *Registry) MarkInvalid(providerID, keyID int64, reason string) {
	r.transition(providerID, keyID, StatusInvalid, time.Time{}, reason)
}

// MarkUsed records a successful use, which is proof the key works: any unhealthy
// status is cleared. In production a rate-limited key can only reach here after
// its cooldown elapsed, and an invalid key can only reach here via the admin
// provider test (which deliberately targets keys Pick would skip) — in both cases
// the response, not the old verdict, is the truth.
func (r *Registry) MarkUsed(providerID, keyID int64) {
	r.mu.Lock()
	st := r.live[providerID][keyID]
	if st != nil && st.status != StatusActive {
		st.status = StatusActive
		st.cooldownUntil = time.Time{}
	}
	r.mu.Unlock()
	r.emit(StateChange{KeyID: keyID, Status: StatusActive, UsedAt: r.now()})
}

func (r *Registry) transition(providerID, keyID int64, status Status, until time.Time, reason string) {
	r.mu.Lock()
	states := r.live[providerID]
	if states == nil {
		states = map[int64]*keyState{}
		r.live[providerID] = states
	}
	st := states[keyID]
	if st == nil {
		st = &keyState{}
		states[keyID] = st
	}
	st.status = status
	st.cooldownUntil = until
	r.mu.Unlock()
	r.emit(StateChange{KeyID: keyID, Status: status, CooldownUntil: until, LastError: reason, UsedAt: r.now()})
}

func (r *Registry) emit(c StateChange) {
	if r.sink != nil {
		r.sink(c)
	}
}

// Snapshot is a key's health for the admin health endpoint. It deliberately
// carries the MASK, never the secret.
type Snapshot struct {
	ID       int64  `json:"id"`
	Label    string `json:"label"`
	Masked   string `json:"maskedKey"`
	Priority int    `json:"priority"`
	Enabled  bool   `json:"enabled"`
	Status   Status `json:"status"`
	// CooldownUntil is a POINTER so "not cooling down" serializes as null rather
	// than the zero time — a dashboard showing "cooling until 0001-01-01" would be
	// worse than showing nothing.
	CooldownUntil *time.Time `json:"cooldownUntil"`
}

// Find returns one key by id, INCLUDING keys Pick would skip (disabled, invalid,
// or cooling down). Used by the admin provider test: re-checking a key that was
// taken out of rotation is exactly what an admin does after replacing it.
func (r *Registry) Find(providerID, keyID int64) (Key, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.sets[providerID] {
		if k.ID == keyID {
			return k, true
		}
	}
	return Key{}, false
}

// SnapshotFor returns the live health of every key of a provider.
func (r *Registry) SnapshotFor(providerID int64) []Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	states := r.live[providerID]
	out := make([]Snapshot, 0, len(r.sets[providerID]))
	for _, k := range r.sets[providerID] {
		s := Snapshot{
			ID: k.ID, Label: k.Label, Masked: k.Masked,
			Priority: k.Priority, Enabled: k.Enabled, Status: StatusActive,
		}
		if !k.Enabled {
			s.Status = StatusDisabled
		}
		if st := states[k.ID]; st != nil {
			s.Status = st.status
			if !st.cooldownUntil.IsZero() {
				until := st.cooldownUntil
				s.CooldownUntil = &until
			}
		}
		// The admin switch wins over observed health: a disabled key must read
		// "disabled" even if it was healthy when it was switched off.
		if !k.Enabled {
			s.Status = StatusDisabled
			s.CooldownUntil = nil
		}
		out = append(out, s)
	}
	return out
}
