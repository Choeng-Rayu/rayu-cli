// Command gateway is the Rayu streaming gateway: it authenticates paid users by
// their Rayu JWT, enforces credit windows, and proxies metered streaming
// completions to upstream LLM providers using Rayu's own provider keys.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/server"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

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

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           server.New(cfg, cache, lim, st),
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
	log.Println("rayu-gateway stopped")
}
