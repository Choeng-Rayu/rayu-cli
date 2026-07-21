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
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
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
		parts = append(parts, fmt.Sprintf("%s→%s[%s]%s", m.Code, m.UpstreamModelID, m.Provider, state))
	}
	log.Printf("catalog: %d hosted models: %s", len(models), strings.Join(parts, ", "))
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
	log.Printf("config: port=%s, keys[%s]", cfg.Port, cfg.ProviderKeySummary())
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

	cache := entitlements.New(st,
		time.Duration(cfg.ConfigRefresh)*time.Second,
		time.Duration(cfg.UserCacheTTL)*time.Second,
	)
	if err := cache.Start(ctx); err != nil {
		log.Fatalf("entitlements load: %v", err)
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
