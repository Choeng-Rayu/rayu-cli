// Command gateway is the Rayu streaming gateway: it authenticates paid users by
// their Rayu JWT, enforces credit windows, and proxies metered streaming
// completions to upstream LLM providers using Rayu's own provider keys.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/eventqueue"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
	"github.com/choeng-rayu/rayu-gateway/internal/secretbox"
	"github.com/choeng-rayu/rayu-gateway/internal/server"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// logCatalog logs the loaded hosted-model catalog ONCE at startup so an operator
// can immediately see what the gateway will accept — e.g. whether the model the
// CLI sends (glm-5.2) is present and which upstream/provider it maps to, and
// confirm no first-party Anthropic id (claude-haiku-4-5-…) is expected on this
// deployment. An empty catalog is called out explicitly (every hosted request
// would 403).
func logCatalog(models []store.HostedModel) {
	if len(models) == 0 {
		log.Printf("catalog: 0 hosted models loaded — every hosted request will 403 'model not available on your plan'")
		return
	}
	const maxShown = 40
	parts := make([]string, 0, len(models))
	for i := range models {
		if i >= maxShown {
			parts = append(parts, fmt.Sprintf("…(+%d more)", len(models)-maxShown))
			break
		}
		m := models[i]
		state := ""
		if !m.Enabled {
			state = "(disabled)"
		}
		parts = append(parts, fmt.Sprintf("%s→%s[%s]%s", m.Code, m.UpstreamModelID, m.Provider.Name, state))
	}
	log.Printf("catalog: %d hosted models: %s", len(models), strings.Join(parts, ", "))
}

// logProviderRegistry logs the resolved provider registry ONCE at startup: what
// the gateway loaded from the `providers` table, whether each row is valid, and
// whether it has any usable API key (masked — never the key itself).
//
// This is the boot-time answer to "why is this model failing": a provider with no
// keys, with every key rate-limited or rejected, whose base URL was refused, or
// that is simply disabled shows up here instead of only as a per-request
// rejection. Invalid rows are reported, NOT repaired: routing a key to an
// unvalidated URL is exactly what the validation exists to prevent. Startup
// deliberately continues — one bad provider row must not take down the rest.
func logProviderRegistry(routes map[int64]entitlements.ProviderRoute, keys *providerkeys.Registry) {
	if len(routes) == 0 {
		log.Printf("providers: registry EMPTY — no provider rows in the database; every hosted request will fail. " +
			"Add a provider (and at least one API key) in the admin dashboard.")
		return
	}
	ids := make([]int64, 0, len(routes))
	for id := range routes {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	problems := 0
	parts := make([]string, 0, len(routes))
	for _, id := range ids {
		pr := routes[id]
		usable := keys.Usable(id)
		state := "ok"
		switch {
		case pr.Err != nil:
			state = "INVALID"
		case !pr.Route.Enabled:
			state = "disabled"
		case pr.Route.KeyCount == 0:
			state = "NO KEY"
		case usable == 0:
			state = "NO USABLE KEY"
		}
		if state == "INVALID" || state == "NO KEY" || state == "NO USABLE KEY" {
			problems++
		}
		parts = append(parts, fmt.Sprintf("%s[%s]→%s keys=%d/%d (%s)",
			pr.Route.Name, pr.Route.Format, pr.Route.Endpoint(),
			usable, pr.Route.KeyCount, state))
	}
	log.Printf("providers: %d in registry: %s", len(routes), strings.Join(parts, " | "))

	// Spell out each unroutable provider on its own line so the reason is
	// greppable and cannot be lost in a long summary line. Per-key detail is
	// masked, so this is safe to ship to a log aggregator.
	for _, id := range ids {
		pr := routes[id]
		if pr.Err != nil {
			log.Printf("providers: %q is NOT routable — invalid config: %v (fix it in the admin dashboard)",
				pr.Route.Name, pr.Err)
			continue
		}
		if !pr.Route.Enabled {
			continue
		}
		if pr.Route.KeyCount == 0 {
			log.Printf("providers: %q is NOT routable — no API key configured. Add one in the admin dashboard (Providers → %s → Add Key).",
				pr.Route.Name, pr.Route.Name)
			continue
		}
		if keys.Usable(id) == 0 {
			for _, k := range keys.SnapshotFor(id) {
				log.Printf("providers: %q key #%d (%s) unusable: status=%s %s",
					pr.Route.Name, k.ID, k.Masked, k.Status, cooldownNote(k))
			}
			log.Printf("providers: %q has %d key(s) but NONE are usable right now — see the lines above.",
				pr.Route.Name, pr.Route.KeyCount)
		}
	}
	if problems > 0 {
		log.Printf("providers: %d of %d provider(s) cannot serve traffic (see lines above)", problems, len(routes))
	}
}

// cooldownNote renders a key's cooldown deadline, or a hint that it needs an
// admin. An "invalid" key never recovers on its own, so say so.
func cooldownNote(k providerkeys.Snapshot) string {
	switch k.Status {
	case providerkeys.StatusRateLimited:
		if !k.CooldownUntil.IsZero() {
			return "until " + k.CooldownUntil.UTC().Format(time.RFC3339)
		}
		return "(cooling down)"
	case providerkeys.StatusInvalid:
		return "(replace it in the dashboard — it will not be retried)"
	default:
		return ""
	}
}

// isMissingTableErr reports whether an error is MySQL's "table doesn't exist"
// (error 1146), which on this path always means "migrations have not been run".
func isMissingTableErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "doesn't exist") ||
		strings.Contains(msg, "does not exist") ||
		strings.Contains(msg, "error 1146")
}

func main() {
	// Dev convenience: load a local .env and let it OVERRIDE any variables already
	// present in the shell, so a stale `export DEEPSEEK_API_KEY=...` can't silently
	// win over .env. No-op in production: the container has no .env (gitignored +
	// .dockerignored), so Overload finds nothing and compose-injected env is used.
	_ = godotenv.Overload()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("config: port=%s allow_insecure_provider_base_url=%v", cfg.Port, cfg.AllowInsecureProviderBaseURL)
	log.Printf("config: model_fidelity_enforce=%v proxy_body_read_timeout=%ds",
		cfg.EnforceModelFidelity, cfg.ProxyBodyReadTimeoutSeconds)
	log.Printf("proxy: upstream response-header timeout=%s (stalled upstreams fail fast → clean 502, no Cloudflare origin_bad_gateway)", proxy.UpstreamResponseHeaderTimeout)
	if cfg.DatabaseDSN == "" {
		log.Fatal("DATABASE_URL is required")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	st, err := store.Open(cfg.DatabaseDSN)
	if err != nil {
		log.Fatalf("mysql: %v", err)
	}
	defer st.Close()

	// Provider API keys are stored encrypted; the gateway needs the SAME master
	// key as the backend to open them. A missing/weak secret is NOT fatal — the
	// BYO-key proxy path and every non-hosted endpoint still work — but it is
	// logged loudly because no hosted request can succeed without it.
	opener, oerr := secretbox.NewOpener(os.Getenv(secretbox.SecretEnv))
	if oerr != nil {
		log.Printf("provider keys: %v — hosted models cannot be served until this is set "+
			"to the same value as the backend's %s", oerr, secretbox.SecretEnv)
	} else {
		log.Printf("provider keys: %s configured; keys are decrypted once per config refresh", secretbox.SecretEnv)
	}

	// Per-key health observed at request time is persisted through the SAME
	// bounded queue as the credit ledger, so a status write never lands on the
	// request path and can never open more DB connections than the queue allows.
	// A small bounded queue of its own: the server's queue is created later (inside
	// server.New), and the registry needs its sink before that. Bounded means a
	// stalled MySQL can never accumulate unbounded writes or connections.
	keyWrites := eventqueue.New(eventqueue.Config{
		OnDrop: func(item eventqueue.Item, reason string, err error) {
			// Losing a health write is survivable: the in-memory state is already
			// correct for this process, and the next failure re-reports it.
			log.Printf("provider key state: dropped %q (reason=%s): %v", item.Name, reason, err)
		},
	})
	defer keyWrites.Close()

	keyStateSink := func(c providerkeys.StateChange) {
		var cooldown *time.Time
		if !c.CooldownUntil.IsZero() {
			t := c.CooldownUntil
			cooldown = &t
		}
		keyWrites.Enqueue(eventqueue.Item{
			Name: "provider_key_state",
			Run: func(ctx context.Context) error {
				return st.UpdateProviderKeyState(
					ctx, c.KeyID, string(c.Status), cooldown, c.LastError, c.UsedAt)
			},
		})
	}

	cache := entitlements.New(st,
		time.Duration(cfg.ConfigRefresh)*time.Second,
		time.Duration(cfg.UserCacheTTL)*time.Second,
		providercfg.Options{AllowInsecure: cfg.AllowInsecureProviderBaseURL},
		opener,
		keyStateSink,
	)
	if err := cache.Start(ctx); err != nil {
		// A missing table means the shared database was never migrated to the
		// schema this build needs. The raw driver error ("Table 'x.providers'
		// doesn't exist") tells an operator nothing actionable, so say what to do.
		if isMissingTableErr(err) {
			log.Fatalf("entitlements load: %v\n\n"+
				"The database is missing a table this gateway needs (the provider registry).\n"+
				"Run migrations first:  cd rayu-backend && npx prisma migrate deploy\n"+
				"(point DATABASE_URL at the SAME database this gateway uses), then start again.",
				err)
		}
		log.Fatalf("entitlements load: %v", err)
	}
	logProviderRegistry(cache.Routes(), cache.Keys())
	// If keys exist but cannot be opened, hosted routing is dead on arrival. Refuse
	// to start rather than serve a gateway that 500s every hosted request: the
	// cause (a missing/mismatched master key) is invisible from the outside, and a
	// half-working gateway is harder to diagnose than one that will not boot.
	if oerr != nil {
		configured := 0
		for _, pr := range cache.Routes() {
			configured += pr.Route.KeyCount
		}
		if configured > 0 {
			log.Fatalf("%s is missing or unusable, but %d provider API key(s) are stored encrypted: %v\n\n"+
				"Set %s in the gateway environment to the SAME value as the backend's, then start again.\n"+
				"Generate one with:  openssl rand -base64 48\n"+
				"(If the value is lost, every stored provider key must be re-entered in the admin dashboard.)",
				secretbox.SecretEnv, configured, oerr, secretbox.SecretEnv)
		}
	}
	logCatalog(cache.Models())

	redisOpt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("redis url: %v", err)
	}
	rdb := redis.NewClient(redisOpt)
	pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
	defer pingCancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		log.Fatalf("redis: %v", err)
	}
	defer rdb.Close()
	lim := credits.NewLimiter(rdb)

	handler := server.New(cfg, cache, lim, st)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
	}

	go func() {
		log.Printf("rayu-gateway listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)

	// Drain the credit-ledger/usage-event write queue after the HTTP server
	// has stopped accepting new requests, so a restart doesn't silently lose
	// whatever writes were still pending. Discovered via type assertion:
	// server.New's public contract stays plain http.Handler (see server.go's
	// Shutdown doc comment) so this is optional/best-effort by design.
	if drainer, ok := handler.(interface{ Shutdown(time.Duration) }); ok {
		drainer.Shutdown(5 * time.Second)
	}
	log.Println("rayu-gateway stopped")
}
