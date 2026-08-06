// Command orchestrator is the rayu-orchestrator control-plane: it accepts
// authenticated build requests, runs the rayu-cli collaborator swarm in a
// hardened sandbox, streams normalized progress, deploys the generated app
// behind a wildcard-subdomain reverse proxy, and reaps idle apps.
//
// This entrypoint wires the skeleton (config -> store -> http server). The build
// engine, sandbox runner, stream hub, deploy pipeline, and routing are added in
// later tasks.
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

	"github.com/choeng-rayu/rayu-orchestrator/internal/api"
	"github.com/choeng-rayu/rayu-orchestrator/internal/build"
	"github.com/choeng-rayu/rayu-orchestrator/internal/config"
	"github.com/choeng-rayu/rayu-orchestrator/internal/obs"
	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

func main() {
	// Dev convenience: load a local .env and let it override the shell, mirroring
	// rayu-gateway. No-op in production (the container ships no .env).
	_ = godotenv.Overload()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	logger := obs.NewLogger(os.Stdout)
	metrics := obs.NewMetrics()

	st, err := openStore(cfg)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	logger.Info("orchestrator starting",
		"port", cfg.Port,
		"store", storeKind(cfg.StoreDSN),
		"baseDomain", cfg.BaseDomain,
		"maxConcurrentBuilds", cfg.MaxConcurrentBuilds,
	)

	// The SSE Hub is both the production Emitter (persist-before-deliver) and the
	// SSE fan-out point. The build engine (worker pool, admission control,
	// quotas, and the per-build owning goroutine) is the production Controller and
	// drives every lifecycle transition through this same Hub.
	hub := stream.NewHub(st)
	engine := build.NewEngine(st, hub, build.EngineConfig{
		MaxConcurrentBuilds: cfg.MaxConcurrentBuilds,
		PerUserConcurrency:  cfg.PerUserConcurrency,
		PerUserDaily:        cfg.PerUserDaily,
	}, api.GenerateBuildID)
	defer engine.Close()

	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: api.NewRouter(api.Deps{
			Store:   st,
			Builds:  engine,
			Stream:  hub,
			Metrics: metrics,
			Logger:  logger,
		}),
		ReadHeaderTimeout: 15 * time.Second,
	}

	go func() {
		logger.Info("http listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	logger.Info("orchestrator stopped")
}

// openStore selects the Store implementation from STORE_DSN. The in-memory
// store is the requirements-permitted first increment; the durable MySQLStore
// is wired in a later task. A non-memory DSN fails fast rather than silently
// running non-durably.
func openStore(cfg *config.Config) (store.Store, error) {
	if cfg.StoreDSN == "" || strings.HasPrefix(cfg.StoreDSN, "memory") {
		return store.NewInMemoryStore(), nil
	}
	return nil, fmt.Errorf("STORE_DSN %q requires the MySQL store, which is not yet wired; use memory:// for now", cfg.StoreDSN)
}

func storeKind(dsn string) string {
	if dsn == "" || strings.HasPrefix(dsn, "memory") {
		return "memory"
	}
	return "mysql"
}
