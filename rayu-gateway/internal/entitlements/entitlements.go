// Package entitlements caches the gateway's read-mostly config (hosted models +
// app settings) in memory and resolves per-user entitlements (status, active
// plan, allowed models, top-up balance) with a short TTL for speed.
package entitlements

import (
	"context"
	"sync"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// Entitlement is the resolved access state for a single user.
type Entitlement struct {
	UserID        int64
	Status        string
	Plan          store.Plan
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

	mu       sync.RWMutex
	models   []store.HostedModel
	settings store.AppSettings

	umu   sync.Mutex
	users map[int64]userEntry
}

type userEntry struct {
	ent Entitlement
	exp time.Time
}

// New creates a cache. Call Start to load config and begin refreshing.
func New(st *store.Store, refresh, userTTL time.Duration) *Cache {
	return &Cache{st: st, refresh: refresh, userTTL: userTTL, users: map[int64]userEntry{}}
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
	c.mu.Lock()
	c.models = models
	c.settings = settings
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

// Resolve returns the user's entitlement using a short-TTL per-user cache.
func (c *Cache) Resolve(ctx context.Context, userID int64) (Entitlement, error) {
	now := time.Now()
	c.umu.Lock()
	if e, ok := c.users[userID]; ok && e.exp.After(now) {
		c.umu.Unlock()
		return e.ent, nil
	}
	c.umu.Unlock()

	status, err := c.st.UserStatus(ctx, userID)
	if err != nil {
		return Entitlement{}, err
	}
	plan, err := c.st.ActivePlan(ctx, userID, now)
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
