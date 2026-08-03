// Package entitlements caches the gateway's read-mostly config (hosted models +
// app settings) in memory and resolves per-user entitlements (status, active
// plan, allowed models, top-up balance) with a short TTL for speed.
package entitlements

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/secretbox"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// Entitlement is the resolved access state for a single user.
type Entitlement struct {
	UserID        int64
	Status        string
	Plan          store.Plan
	PeriodEnd     *time.Time // subscription period end (nil for free/no-expiry)
	AllowedModels []store.HostedModel
	TopupBalance  int64
}

// Active reports whether the user may use the gateway at all.
func (e Entitlement) Active() bool { return e.Status == "active" }

// userStore is the slice of the store that per-user resolution needs. Narrowing it
// here (rather than taking *store.Store) is what makes Resolve testable: the cache
// can be driven by a counting fake, so "one database resolve per burst" and "a
// catalog change is visible immediately" are provable without a live MySQL.
type userStore interface {
	UserStatus(ctx context.Context, userID int64) (string, error)
	ActivePlan(ctx context.Context, userID int64, now time.Time) (*store.Plan, *time.Time, error)
	TopupBalance(ctx context.Context, userID int64) (int64, error)
}

// Cache holds config + per-user entitlement caches.
type Cache struct {
	st      *store.Store
	userSrc userStore
	refresh time.Duration
	userTTL time.Duration
	// routeOpts controls how provider rows are validated into routes (dev flag).
	routeOpts providercfg.Options
	// opener decrypts stored provider API keys. Nil when RAYU_PROVIDER_SECRET is
	// unusable — every key then reports as undecryptable rather than the gateway
	// silently routing without one.
	opener *secretbox.Opener
	// keys holds live per-key health + the decrypted secrets. Decryption happens
	// ONCE per refresh here, never on the request path.
	keys *providerkeys.Registry

	mu     sync.RWMutex
	models []store.HostedModel
	// mediaModels is the image/video generation catalog. Snapshotted alongside the
	// chat models so serving it costs a memory read, exactly like /v1/models.
	mediaModels []store.MediaModel
	settings    store.AppSettings
	// routes is the validated provider registry, keyed by provider id, rebuilt on
	// every refresh. Building it here (rather than per request) means a request
	// never re-reads the environment, re-parses a URL, or re-validates a row.
	routes map[int64]ProviderRoute

	umu   sync.Mutex
	users map[int64]userEntry
	// inflight deduplicates concurrent resolves of the SAME user. A cache miss is
	// three sequential MySQL round-trips, and a user's requests arrive in bursts
	// (the agent loop fires side queries alongside the main turn), so without this
	// one expiry multiplies into N×3 queries against a shared connection pool.
	inflight map[int64]*resolveCall
}

// resolveCall is one shared per-user resolve. Fields are written before done is
// closed, so every waiter reads them with a happens-before guarantee.
type resolveCall struct {
	done  chan struct{}
	entry userEntry
	err   error
}

// ProviderRoute is a provider registry row resolved for use: either a usable
// route, or the reason it must not be routed. Invalid rows are KEPT (rather than
// dropped) so the request path can answer with a precise, sanitized error and
// the health endpoint can show an operator exactly what is wrong.
type ProviderRoute struct {
	Route providercfg.Route
	Err   error
}

// Usable reports whether the route may serve traffic right now: valid config,
// provider enabled, and at least one usable API key.
func (p ProviderRoute) Usable() bool {
	return p.Err == nil && p.Route.Enabled && p.Route.HasKey()
}

// userEntry is what is actually CACHED for a user: only the parts that come from
// the database. The allowed-model list is deliberately NOT here — it is derived
// from the live config snapshot on every read (see Resolve), so enabling a model
// or granting a plan access to one takes effect on the user's next request instead
// of waiting out this entry's TTL on top of the config refresh.
type userEntry struct {
	status    string
	plan      store.Plan
	periodEnd *time.Time
	topup     int64
	exp       time.Time
}

// New creates a cache. Call Start to load config and begin refreshing.
//
// opener decrypts provider API keys (nil is tolerated: keys then load as
// undecryptable, which surfaces in the health endpoint instead of failing boot).
// onKeyState receives per-key health transitions for durable write-back; pass nil
// to keep state in memory only.
func New(
	st *store.Store,
	refresh, userTTL time.Duration,
	routeOpts providercfg.Options,
	opener *secretbox.Opener,
	onKeyState providerkeys.Sink,
) *Cache {
	return &Cache{
		st:        st,
		userSrc:   st,
		refresh:   refresh,
		userTTL:   userTTL,
		routeOpts: routeOpts,
		opener:    opener,
		keys:      providerkeys.New(onKeyState),
		users:     map[int64]userEntry{},
		inflight:  map[int64]*resolveCall{},
		routes:    map[int64]ProviderRoute{},
	}
}

// withUserStore replaces the per-user database reader. Test-only seam: production
// always resolves against the same *store.Store passed to New.
func (c *Cache) withUserStore(us userStore) *Cache {
	c.userSrc = us
	return c
}

// Keys exposes the live key registry (rotation + health).
func (c *Cache) Keys() *providerkeys.Registry { return c.keys }

// Reload refreshes the config snapshot NOW instead of waiting for the ticker.
//
// The request path must never call this — it is several database queries, and
// the whole point of the 30s snapshot is that a request reads memory. It exists
// for ADMIN actions that need to see their own write immediately: a key or model
// saved a second ago is not in the snapshot yet, so "save then test" would
// otherwise fail for up to the refresh interval and look like a broken feature.
func (c *Cache) Reload(ctx context.Context) error { return c.reload(ctx) }

// openKey turns a stored row into a usable key. A key that cannot be decrypted is
// kept but marked INVALID rather than dropped: an operator needs to see "this key
// can't be decrypted — is RAYU_PROVIDER_SECRET the same value as the backend's?"
// instead of a key silently vanishing from rotation.
func (c *Cache) openKey(k store.ProviderKey) providerkeys.Key {
	out := providerkeys.Key{
		ID:       k.ID,
		Label:    k.Label,
		Masked:   k.MaskedKey,
		Priority: k.Priority,
		Enabled:  k.Enabled,
		Status:   providerkeys.Status(k.Status),
	}
	if k.CooldownUntil != nil {
		out.CooldownUntil = *k.CooldownUntil
	}
	if c.opener == nil {
		out.Status = providerkeys.StatusInvalid
		return out
	}
	secret, err := c.opener.Open(k.EncryptedKey)
	if err != nil {
		out.Status = providerkeys.StatusInvalid
		return out
	}
	out.Secret = secret
	return out
}

// Start loads config once (returning any error) then refreshes on a ticker
// until ctx is cancelled.
func (c *Cache) Start(ctx context.Context) error {
	if err := c.reload(ctx); err != nil {
		return err
	}
	go func() {
		t := time.NewTicker(c.refresh)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = c.reload(ctx)
			}
		}
	}()
	return nil
}

func (c *Cache) reload(ctx context.Context) error {
	models, err := c.st.LoadModels(ctx)
	if err != nil {
		return err
	}
	settings, err := c.st.LoadSettings(ctx)
	if err != nil {
		return err
	}
	// The MEDIA catalog is best-effort: a database that predates the media_models
	// migration must not stop the gateway from serving chat traffic. A load
	// failure leaves the previous snapshot in place and the CLI falls back to its
	// documented offline behaviour instead of the whole gateway going down.
	mediaModels, mediaErr := c.st.LoadMediaModels(ctx)
	if mediaErr != nil {
		log.Printf("entitlements: media model catalog unavailable, keeping last snapshot: %v", mediaErr)
	}
	providers, err := c.st.LoadProviders(ctx)
	if err != nil {
		return err
	}
	storedKeys, err := c.st.LoadProviderKeys(ctx)
	if err != nil {
		return err
	}
	// Decrypt ONCE per refresh, here, and hand the plaintext to the in-memory
	// registry. A request then never touches the database or the cipher.
	byProvider := map[int64][]providerkeys.Key{}
	for _, k := range storedKeys {
		byProvider[k.ProviderID] = append(byProvider[k.ProviderID], c.openKey(k))
	}
	routes := make(map[int64]ProviderRoute, len(providers))
	for _, p := range providers {
		c.keys.Replace(p.ID, byProvider[p.ID])
		route, buildErr := providercfg.Build(providercfg.Row{
			Name:         p.Name,
			Format:       p.Format,
			BaseURL:      p.BaseURL,
			EndpointPath: p.EndpointPath,
			AuthScheme:   p.AuthScheme,
			Enabled:      p.Enabled,
			// KeyCount tells the route whether it has anything to authenticate
			// with, without exposing the keys themselves.
			KeyCount: len(byProvider[p.ID]),
		}, c.routeOpts)
		routes[p.ID] = ProviderRoute{Route: route, Err: buildErr}
	}
	// A provider deleted in the dashboard must not keep its keys in memory.
	seen := make(map[int64]bool, len(providers))
	for _, p := range providers {
		seen[p.ID] = true
	}
	for id := range byProvider {
		if !seen[id] {
			c.keys.Forget(id)
		}
	}
	c.mu.Lock()
	c.models = models
	if mediaErr == nil {
		c.mediaModels = mediaModels
	}
	c.settings = settings
	c.routes = routes
	c.mu.Unlock()

	// Drop expired per-user entries. Nothing else ever removes them: Invalidate is
	// targeted and a re-resolve only overwrites the users who came back, so a
	// long-running gateway otherwise keeps an entry for every account that has ever
	// made a request. Piggy-backing on the refresh keeps it free of its own timer.
	c.sweepUsers(time.Now())
	return nil
}

// sweepUsers removes per-user entries whose TTL has passed.
func (c *Cache) sweepUsers(now time.Time) {
	c.umu.Lock()
	defer c.umu.Unlock()
	for id, e := range c.users {
		if !e.exp.After(now) {
			delete(c.users, id)
		}
	}
}

// Settings returns the cached app settings.
func (c *Cache) Settings() store.AppSettings {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.settings
}

// Models returns the cached hosted models.
func (c *Cache) Models() []store.HostedModel {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.models
}

// MediaModels returns the cached image/video generation catalog.
func (c *Cache) MediaModels() []store.MediaModel {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.mediaModels
}

// AllowedMediaModels returns the ENABLED media models a plan may use, optionally
// narrowed to one media type ("image" / "video"; empty means both).
//
// An EMPTY allowedPlanCodes means EVERY plan — the opposite of the chat catalog's
// rule. Media generation is gated by the per-plan image_generation /
// video_generation feature flags, so an unrestricted model is the normal case and
// reading an empty list as "nobody" would hide the whole catalog.
func AllowedMediaModels(models []store.MediaModel, planCode, mediaType string) []store.MediaModel {
	out := []store.MediaModel{}
	for _, m := range models {
		if !m.Enabled {
			continue
		}
		if mediaType != "" && m.MediaType != mediaType {
			continue
		}
		if len(m.AllowedPlanCodes) == 0 {
			out = append(out, m)
			continue
		}
		for _, pc := range m.AllowedPlanCodes {
			if pc == planCode {
				out = append(out, m)
				break
			}
		}
	}
	return out
}

// ModelByCode finds a cached model by its Rayu code.
func (c *Cache) ModelByCode(code string) (store.HostedModel, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, m := range c.models {
		if m.Code == code {
			return m, true
		}
	}
	return store.HostedModel{}, false
}

// Route returns the resolved provider route for a provider id. Served from the
// in-memory snapshot: no environment read, URL parse, or validation happens on
// the request path.
func (c *Cache) Route(providerID int64) (ProviderRoute, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	r, ok := c.routes[providerID]
	return r, ok
}

// Routes returns a copy of the whole resolved registry (admin health view).
func (c *Cache) Routes() map[int64]ProviderRoute {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[int64]ProviderRoute, len(c.routes))
	for id, r := range c.routes {
		out[id] = r
	}
	return out
}

// AllowedModels returns enabled models whose allowedPlanCodes include planCode.
func AllowedModels(models []store.HostedModel, planCode string) []store.HostedModel {
	out := []store.HostedModel{}
	for _, m := range models {
		if !m.Enabled {
			continue
		}
		for _, pc := range m.AllowedPlanCodes {
			if pc == planCode {
				out = append(out, m)
				break
			}
		}
	}
	return out
}

// resolveDeadline bounds the cache-miss path (3 sequential MySQL round-trips:
// UserStatus, ActivePlan, TopupBalance). Without this, a saturated connection
// pool under load queues the request indefinitely — the caller (and its
// client) sees a hang until the reverse proxy in front of the gateway times
// out and returns a 502, instead of the gateway itself returning a fast,
// diagnosable error. This must stay comfortably under any upstream proxy
// timeout so the gateway is always the one that answers first.
const resolveDeadline = 3 * time.Second

// Resolve returns the user's entitlement, caching only the database-derived parts
// for userTTL. The allowed-model list is rebuilt from the current config snapshot
// on every call, so a catalog change is visible on the next request rather than
// after this user's TTL also expires.
//
// Concurrent resolves of the same user share one database read (see inflight):
// a user's requests arrive in bursts, and a burst arriving on an expired entry
// used to mean one triple-query per request.
func (c *Cache) Resolve(ctx context.Context, userID int64) (Entitlement, error) {
	now := time.Now()
	c.umu.Lock()
	if e, ok := c.users[userID]; ok && e.exp.After(now) {
		c.umu.Unlock()
		return c.entitlementFor(userID, e), nil
	}
	call := c.inflight[userID]
	if call == nil {
		call = &resolveCall{done: make(chan struct{})}
		if c.inflight == nil {
			c.inflight = map[int64]*resolveCall{}
		}
		c.inflight[userID] = call
		go c.resolveNow(userID, call)
	}
	c.umu.Unlock()

	select {
	case <-call.done:
		if call.err != nil {
			return Entitlement{}, call.err
		}
		return c.entitlementFor(userID, call.entry), nil
	case <-ctx.Done():
		// This caller gave up (client disconnected); the shared read continues for
		// the others and its result still populates the cache.
		return Entitlement{}, ctx.Err()
	}
}

// resolveNow performs the three user queries and publishes the result to every
// waiter. It runs on a DETACHED context so one caller hanging up cannot abort a
// read the others are waiting for, bounded by resolveDeadline exactly as before.
func (c *Cache) resolveNow(userID int64, call *resolveCall) {
	ctx, cancel := context.WithTimeout(context.Background(), resolveDeadline)
	defer cancel()

	entry, err := c.readUser(ctx, userID)

	c.umu.Lock()
	delete(c.inflight, userID)
	if err == nil {
		c.users[userID] = entry
	}
	c.umu.Unlock()

	call.entry, call.err = entry, err
	close(call.done)
}

// readUser is the database half: status, active plan, top-up balance.
func (c *Cache) readUser(ctx context.Context, userID int64) (userEntry, error) {
	now := time.Now()
	status, err := c.userSrc.UserStatus(ctx, userID)
	if err != nil {
		return userEntry{}, err
	}
	plan, periodEnd, err := c.userSrc.ActivePlan(ctx, userID, now)
	if err != nil {
		return userEntry{}, err
	}
	if plan == nil {
		plan = &store.Plan{Code: "free"}
	}
	topup, err := c.userSrc.TopupBalance(ctx, userID)
	if err != nil {
		return userEntry{}, err
	}
	return userEntry{
		status:    status,
		plan:      *plan,
		periodEnd: periodEnd,
		topup:     topup,
		exp:       now.Add(c.userTTL),
	}, nil
}

// entitlementFor joins a cached user entry to the CURRENT catalog snapshot.
func (c *Cache) entitlementFor(userID int64, e userEntry) Entitlement {
	return Entitlement{
		UserID:        userID,
		Status:        e.status,
		Plan:          e.plan,
		PeriodEnd:     e.periodEnd,
		AllowedModels: AllowedModels(c.Models(), e.plan.Code),
		TopupBalance:  e.topup,
	}
}

// Invalidate drops a user's cached entitlement so the next Resolve re-reads
// (used after a settle changes the top-up balance).
func (c *Cache) Invalidate(userID int64) {
	c.umu.Lock()
	delete(c.users, userID)
	c.umu.Unlock()
}

// CachedUsers is how many per-user entries are held right now (test/diagnostics).
func (c *Cache) CachedUsers() int {
	c.umu.Lock()
	defer c.umu.Unlock()
	return len(c.users)
}
