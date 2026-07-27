// Package entitlements caches the gateway's read-mostly config (hosted models +
// app settings) in memory and resolves per-user entitlements (status, active
// plan, allowed models, top-up balance) with a short TTL for speed.
package entitlements

import (
	"context"
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

// Cache holds config + per-user entitlement caches.
type Cache struct {
	st      *store.Store
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

	mu       sync.RWMutex
	models   []store.HostedModel
	settings store.AppSettings
	// routes is the validated provider registry, keyed by provider id, rebuilt on
	// every refresh. Building it here (rather than per request) means a request
	// never re-reads the environment, re-parses a URL, or re-validates a row.
	routes map[int64]ProviderRoute

	umu   sync.Mutex
	users map[int64]userEntry
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

type userEntry struct {
	ent Entitlement
	exp time.Time
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
		refresh:   refresh,
		userTTL:   userTTL,
		routeOpts: routeOpts,
		opener:    opener,
		keys:      providerkeys.New(onKeyState),
		users:     map[int64]userEntry{},
		routes:    map[int64]ProviderRoute{},
	}
}

// Keys exposes the live key registry (rotation + health).
func (c *Cache) Keys() *providerkeys.Registry { return c.keys }

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
	c.settings = settings
	c.routes = routes
	c.mu.Unlock()
	return nil
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

// Resolve returns the user's entitlement using a short-TTL per-user cache.
func (c *Cache) Resolve(ctx context.Context, userID int64) (Entitlement, error) {
	now := time.Now()
	c.umu.Lock()
	if e, ok := c.users[userID]; ok && e.exp.After(now) {
		c.umu.Unlock()
		return e.ent, nil
	}
	c.umu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, resolveDeadline)
	defer cancel()

	status, err := c.st.UserStatus(ctx, userID)
	if err != nil {
		return Entitlement{}, err
	}
	plan, periodEnd, err := c.st.ActivePlan(ctx, userID, now)
	if err != nil {
		return Entitlement{}, err
	}
	if plan == nil {
		plan = &store.Plan{Code: "free"}
	}
	topup, err := c.st.TopupBalance(ctx, userID)
	if err != nil {
		return Entitlement{}, err
	}

	ent := Entitlement{
		UserID:        userID,
		Status:        status,
		Plan:          *plan,
		PeriodEnd:     periodEnd,
		AllowedModels: AllowedModels(c.Models(), plan.Code),
		TopupBalance:  topup,
	}
	c.umu.Lock()
	c.users[userID] = userEntry{ent: ent, exp: now.Add(c.userTTL)}
	c.umu.Unlock()
	return ent, nil
}

// Invalidate drops a user's cached entitlement so the next Resolve re-reads
// (used after a settle changes the top-up balance).
func (c *Cache) Invalidate(userID int64) {
	c.umu.Lock()
	delete(c.users, userID)
	c.umu.Unlock()
}
