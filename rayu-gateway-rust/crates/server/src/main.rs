//! The Rayu streaming gateway: authenticates paid users by their Rayu JWT,
//! enforces credit windows, and proxies metered streaming completions to upstream
//! LLM providers using Rayu's own provider keys.
//!
//! Port of the Go gateway's `cmd/gateway/main.go`. The boot sequence, the log lines,
//! and the fatal conditions are reproduced deliberately: operators diagnose
//! deployments from this output.
//!
//! NOTE: the periodic config refresh, the invalidation-bus subscriber and the
//! queue-draining shutdown are completed in Task 24; the boot order below is already
//! Go's.

use std::sync::atomic::AtomicI64;
use std::sync::Arc;
use std::time::Duration;

use rayu_core::config::{Config, MIN_RECOMMENDED_JWT_SECRET_LEN};
use rayu_core::eventqueue::{self, Queue};
use rayu_core::secretbox::{self, Opener};
use rayu_core::store::Store;
use rayu_gateway_lib::configreload::ConfigReloader;
use rayu_gateway_lib::entitlements::Cache;
use rayu_gateway_lib::limiter::Limiter;
use rayu_gateway_lib::providercfg::Options;
use rayu_gateway_lib::state::{AppState, InflightLimiter};
use rayu_gateway_lib::{providerkeys, routes, upstream};

#[tokio::main]
async fn main() {
    // Dev convenience: load a local .env and let it OVERRIDE any variables already
    // present in the shell, so a stale `export ...` cannot silently win over .env.
    // No-op in production: the container has no .env (gitignored + .dockerignored),
    // so this finds nothing and compose-injected env is used.
    let _ = dotenvy::dotenv_override();

    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            // Logging is not up yet, and this must be visible even if the subscriber
            // never initialises.
            eprintln!("config: {e}");
            std::process::exit(1);
        }
    };
    rayu_core::logging::init(cfg.log_format);

    tracing::info!(
        "config: port={} allow_insecure_provider_base_url={}",
        cfg.port,
        cfg.allow_insecure_provider_base_url
    );
    tracing::info!(
        "config: model_fidelity_enforce={} proxy_body_read_timeout={}s",
        cfg.enforce_model_fidelity,
        cfg.proxy_body_read_timeout_seconds
    );
    tracing::info!(
        "proxy: upstream response-header timeout={:?} (stalled upstreams fail fast \
         -> clean 502, no Cloudflare origin_bad_gateway)",
        upstream::UPSTREAM_RESPONSE_HEADER_TIMEOUT
    );

    // I5: a short shared secret weakens every token in the system. The Go gateway
    // does not check, and refusing to boot could strand a running deployment, so this
    // warns instead.
    if cfg.jwt_secret.len() < MIN_RECOMMENDED_JWT_SECRET_LEN {
        tracing::warn!(
            "config: RAYU_JWT_SECRET is only {} bytes; {} or more is recommended \
             (generate one with `openssl rand -base64 48`)",
            cfg.jwt_secret.len(),
            MIN_RECOMMENDED_JWT_SECRET_LEN
        );
    }

    if cfg.database_url.is_empty() {
        tracing::error!("DATABASE_URL is required");
        std::process::exit(1);
    }

    let store = match Store::open(&cfg.database_url).await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            tracing::error!("mysql: {e}");
            std::process::exit(1);
        }
    };

    // Provider API keys are stored encrypted; the gateway needs the SAME master key
    // as the backend to open them. A missing/weak secret is NOT fatal -- the BYO-key
    // proxy path and every non-hosted endpoint still work -- but it is logged loudly
    // because no hosted request can succeed without it.
    let opener = match Opener::new(&std::env::var(secretbox::SECRET_ENV).unwrap_or_default()) {
        Ok(o) => {
            tracing::info!(
                "provider keys: {} configured; keys are decrypted once per config refresh",
                secretbox::SECRET_ENV
            );
            Some(Arc::new(o))
        }
        Err(e) => {
            tracing::warn!(
                "provider keys: {e} — hosted models cannot be served until this is set \
                 to the same value as the backend's {}",
                secretbox::SECRET_ENV
            );
            None
        }
    };

    // Per-key health observed at request time is persisted through a BOUNDED queue, so
    // a status write never lands on the request path and can never open more DB
    // connections than the queue allows. A stalled MySQL therefore cannot accumulate
    // unbounded writes.
    let key_writes = Arc::new(Queue::new(eventqueue::Config {
        on_drop: Some(Arc::new(
            |item: &eventqueue::Item, reason: &str, err: Option<&eventqueue::EventError>| {
                // Losing a health write is survivable: the in-memory state is already
                // correct for this process, and the next failure re-reports it.
                tracing::warn!(
                    "provider key state: dropped {:?} (reason={reason}): {}",
                    item.name,
                    err.map(|e| e.message.as_str()).unwrap_or("-")
                );
            },
        )),
        ..Default::default()
    }));
    let key_sink: providerkeys::Sink = {
        let store = store.clone();
        let q = key_writes.clone();
        Arc::new(move |c: providerkeys::StateChange| {
            let store = store.clone();
            q.enqueue(eventqueue::Item::new("provider_key_state", move || {
                let store = store.clone();
                let c = c.clone();
                async move {
                    store
                        .update_provider_key_state(
                            c.key_id,
                            c.status.as_str(),
                            c.cooldown_until,
                            &c.last_error,
                            c.used_at,
                        )
                        .await
                        .map_err(Into::into)
                }
            }));
        })
    };

    let cache = Arc::new(Cache::new(
        store.clone(),
        Duration::from_secs(cfg.user_cache_ttl.max(0) as u64),
        Options {
            allow_insecure: cfg.allow_insecure_provider_base_url,
        },
        opener,
        Some(key_sink),
    ));
    if let Err(e) = cache.reload().await {
        // A missing table means the shared database was never migrated to the schema
        // this build needs. The raw driver error tells an operator nothing actionable,
        // so say what to do.
        if rayu_core::store::is_missing_table_err(&e) {
            tracing::error!(
                "entitlements load: {e}\n\n\
                 The database is missing a table this gateway needs (the provider registry).\n\
                 Run migrations first:  cd rayu-backend && npx prisma migrate deploy\n\
                 (point DATABASE_URL at the SAME database this gateway uses), then start again."
            );
        } else {
            tracing::error!("entitlements load: {e}");
        }
        std::process::exit(1);
    }

    let limiter = match Limiter::connect(&cfg.redis_url).await {
        Ok(l) => {
            if let Err(e) = l.load_scripts().await {
                tracing::warn!("redis: script preload failed ({e}); falling back to EVAL");
            }
            Some(Arc::new(l))
        }
        Err(e) => {
            tracing::error!("redis: {e}");
            std::process::exit(1);
        }
    };

    // The request-path write queue: credit-ledger and usage-event rows. One bounded,
    // serialized queue so those best-effort durable writes can never open more MySQL
    // connections than the queue's worker count, regardless of concurrency.
    let wq = Arc::new(Queue::new(eventqueue::Config {
        on_drop: Some(Arc::new(
            |item: &eventqueue::Item, reason: &str, err: Option<&eventqueue::EventError>| {
                tracing::warn!(
                    "eventqueue: dropped item {:?} (reason={reason}): {}",
                    item.name,
                    err.map(|e| e.message.as_str()).unwrap_or("-")
                );
            },
        )),
        ..Default::default()
    }));

    let reloader = {
        let cache = cache.clone();
        Arc::new(ConfigReloader::from_fn(
            move || {
                let cache = cache.clone();
                async move { cache.reload().await.map_err(|e| e.to_string()) }
            },
            None,
        ))
    };

    // Team billing needs the database. Without one an `orgId` claim is simply
    // ignored and billing stays individual.
    let orgs = Some(Arc::new(rayu_gateway_lib::orgcredits::Resolver::new(
        store.clone(),
        Duration::from_secs(cfg.user_cache_ttl.max(0) as u64),
    )));

    let port = cfg.port.clone();
    let max_in_flight = cfg.max_in_flight;
    let state = Arc::new(AppState {
        cfg: Arc::new(cfg),
        ent: cache,
        lim: limiter,
        store: Some(store),
        orgs,
        wq,
        inflight: Arc::new(InflightLimiter::new(max_in_flight)),
        reloader,
        upstream: Arc::new(upstream::Upstream::new()),
        shed_total: AtomicI64::new(0),
    });
    tracing::info!(
        "adapters: {} wire formats registered ({})",
        rayu_gateway_lib::adapters::formats().len(),
        rayu_gateway_lib::adapters::formats().join(", ")
    );
    if max_in_flight > 0 {
        tracing::info!("load shedding: RAYU_MAX_INFLIGHT={max_in_flight}");
    } else {
        tracing::info!("load shedding: disabled (RAYU_MAX_INFLIGHT=0)");
    }

    let app = routes::router(state);
    let addr = format!("0.0.0.0:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("server: bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!("rayu-gateway listening on :{port}");

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!("server: {e}");
        std::process::exit(1);
    }
    tracing::info!("rayu-gateway stopped");
}

/// Resolves on SIGINT or SIGTERM so in-flight streams finish rather than being cut.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => tracing::warn!("shutdown: cannot listen for SIGTERM: {e}"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("shutdown: SIGINT"),
        _ = terminate => tracing::info!("shutdown: SIGTERM"),
    }
}
