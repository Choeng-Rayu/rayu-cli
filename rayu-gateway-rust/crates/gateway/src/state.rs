//! Dependencies shared across every handler, plus the two valves that protect the
//! process under load.
//!
//! Port of the `Server` struct and `inflightLimiter` from the Go gateway's
//! `internal/server/server.go`.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use axum::response::Response;
use chrono::{DateTime, Utc};
use http::StatusCode;
use rayu_core::eventqueue::Queue;
use rayu_core::httpx;
use rayu_core::store::{AppSettings, HostedModel, MediaModel, Store};
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::configreload::ConfigReloader;
use crate::entitlements::{self, Entitlement, ProviderRoute, ResolveError};
use crate::limiter::Limiter;
use crate::providerkeys::Registry;

/// Caps a request body, so one client cannot make the gateway buffer without bound.
pub const MAX_REQUEST_BYTES: usize = 8 << 20; // 8 MiB

/// Resolves per-user entitlements and exposes cached app settings plus the resolved
/// provider registry.
///
/// Backed by [`entitlements::Cache`] in production and a fake in tests, so the
/// chat/proxy handlers can be exercised without a live MySQL.
#[async_trait::async_trait]
pub trait EntSource: Send + Sync {
    async fn resolve(&self, user_id: i64) -> Result<Entitlement, ResolveError>;
    fn settings(&self) -> AppSettings;
    fn invalidate(&self, user_id: i64);
    /// The validated upstream route for a provider id, resolved once per config
    /// refresh (never per request).
    fn route(&self, provider_id: i64) -> Option<ProviderRoute>;
    fn routes(&self) -> std::collections::HashMap<i64, ProviderRoute>;
    /// The live per-key registry: which of a provider's API keys may serve a request
    /// right now, plus their health. Decryption already happened during the config
    /// refresh, so this is pure in-memory bookkeeping.
    fn keys(&self) -> Arc<Registry>;
    /// The whole hosted catalog, not one user's allowed subset: the admin provider
    /// test must be able to exercise a model no plan can use yet.
    fn models(&self) -> Vec<HostedModel>;
    /// The whole image/video generation catalog. Plan filtering is applied per
    /// request by [`entitlements::allowed_media_models`], mirroring `models`.
    fn media_models(&self) -> Vec<MediaModel>;
    /// Refreshes the config snapshot immediately. ADMIN paths only: the snapshot
    /// exists precisely so a request never queries the database.
    async fn reload(&self) -> Result<(), String>;
}

#[async_trait::async_trait]
impl EntSource for entitlements::Cache {
    async fn resolve(&self, user_id: i64) -> Result<Entitlement, ResolveError> {
        entitlements::Cache::resolve(self, user_id).await
    }
    fn settings(&self) -> AppSettings {
        entitlements::Cache::settings(self)
    }
    fn invalidate(&self, user_id: i64) {
        entitlements::Cache::invalidate(self, user_id)
    }
    fn route(&self, provider_id: i64) -> Option<ProviderRoute> {
        entitlements::Cache::route(self, provider_id)
    }
    fn routes(&self) -> std::collections::HashMap<i64, ProviderRoute> {
        entitlements::Cache::routes(self)
    }
    fn keys(&self) -> Arc<Registry> {
        entitlements::Cache::keys(self).clone()
    }
    fn models(&self) -> Vec<HostedModel> {
        entitlements::Cache::models(self)
    }
    fn media_models(&self) -> Vec<MediaModel> {
        entitlements::Cache::media_models(self)
    }
    async fn reload(&self) -> Result<(), String> {
        entitlements::Cache::reload(self)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Caps how many hosted STREAMING requests the gateway actively processes at once.
///
/// Streaming holds a full connection chain (client -> gateway -> upstream) open for
/// the whole generation, so a burst of concurrent users can otherwise exhaust the
/// origin's connections/FDs/tasks and drag the whole process down -- which surfaces
/// to clients as a Cloudflare `origin_bad_gateway` with NO gateway log line, because
/// the saturated origin can no longer accept new connections. At capacity we shed
/// IMMEDIATELY with a clean, retryable 503 (the CLI renders it as the friendly
/// "temporarily unavailable" message) and, critically, LOG the rejection so overload
/// is visible instead of silent.
///
/// This is a graceful-degradation valve, NOT added capacity: set `RAYU_MAX_INFLIGHT`
/// to a value the instance can sustain, and scale the gateway horizontally for real
/// throughput. 0 = unlimited (disabled).
#[derive(Debug)]
pub struct InflightLimiter {
    sem: Option<Arc<Semaphore>>,
    max: i64,
}

impl InflightLimiter {
    pub fn new(max: i64) -> Self {
        if max <= 0 {
            return Self { sem: None, max: 0 }; // unlimited
        }
        Self {
            sem: Some(Arc::new(Semaphore::new(max as usize))),
            max,
        }
    }

    pub fn max(&self) -> i64 {
        self.max
    }

    /// Takes a slot, or `None` when saturated.
    ///
    /// This uses `try_acquire`, NOT `acquire`: Go's `select` with a `default` sheds
    /// immediately and never queues. A queueing limiter would convert overload into
    /// unbounded latency, which is the failure mode this valve exists to prevent.
    pub fn try_acquire(&self) -> Option<InflightGuard> {
        match &self.sem {
            None => Some(InflightGuard { _permit: None }),
            Some(sem) => sem
                .clone()
                .try_acquire_owned()
                .ok()
                .map(|p| InflightGuard { _permit: Some(p) }),
        }
    }

    /// How many slots are currently free (for the admin stats route).
    pub fn available(&self) -> Option<usize> {
        self.sem.as_ref().map(|s| s.available_permits())
    }
}

/// Holds a concurrency slot for as long as the request runs.
pub struct InflightGuard {
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

/// The response sent when the gateway is at capacity.
pub fn at_capacity_response(max: i64, path: &str) -> Response {
    tracing::warn!("reject: gateway at capacity (RAYU_MAX_INFLIGHT={max}) path={path}");
    let mut resp = httpx::write_provider_unavailable(StatusCode::SERVICE_UNAVAILABLE);
    resp.headers_mut().insert(
        http::header::RETRY_AFTER,
        http::HeaderValue::from_static("5"),
    );
    resp
}

/// Everything the handlers share.
pub struct AppState {
    pub cfg: Arc<rayu_core::config::Config>,
    pub ent: Arc<dyn EntSource>,
    pub lim: Option<Arc<Limiter>>,
    pub store: Option<Arc<Store>>,
    /// Resolves TEAM billing state for a JWT that carries an `orgId` claim.
    ///
    /// `None` when the gateway has no database handle (unit tests), in which case an
    /// org claim is IGNORED and the caller is billed individually -- the same behaviour
    /// as a gateway build from before teams existed.
    pub orgs: Option<Arc<crate::orgcredits::Resolver>>,
    pub wq: Arc<Queue>,
    pub inflight: Arc<InflightLimiter>,
    pub reloader: Arc<ConfigReloader>,
    /// The shared upstream HTTP client plus its circuit breakers.
    pub upstream: Arc<crate::upstream::Upstream>,
    /// Counts requests shed by the in-flight valve, for the admin stats route (I4).
    pub shed_total: AtomicI64,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("max_in_flight", &self.inflight.max())
            .field("has_store", &self.store.is_some())
            .field("has_limiter", &self.lim.is_some())
            .finish_non_exhaustive()
    }
}

impl AppState {
    /// Records that a request was shed, for observability.
    pub fn note_shed(&self) {
        self.shed_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn shed_count(&self) -> i64 {
        self.shed_total.load(Ordering::Relaxed)
    }
}

/// Translates an entitlement lookup failure into the response Go sends.
///
/// A deadline is a 503 with `Retry-After: 1` (the gateway is busy, the request is
/// worth retrying), while anything else is a 500 -- the CLI treats those very
/// differently.
pub fn entitlement_error_response(err: &ResolveError) -> Response {
    match err {
        ResolveError::Deadline => {
            let mut resp = httpx::write_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway busy, please retry",
            );
            resp.headers_mut().insert(
                http::header::RETRY_AFTER,
                http::HeaderValue::from_static("1"),
            );
            resp
        }
        ResolveError::Store(_) => httpx::write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "entitlement lookup failed",
        ),
    }
}

/// Renders an account status, defaulting to `"unknown"` so the message is never
/// `"account is "`.
pub fn status_or_unknown(s: &str) -> &str {
    if s.is_empty() {
        "unknown"
    } else {
        s
    }
}

/// Renders an optional timestamp as RFC3339, or JSON null.
pub fn iso_time(t: Option<DateTime<Utc>>) -> Value {
    match t {
        // `to_rfc3339_opts` with `Secs` and `use_z = true` matches Go's
        // time.RFC3339 rendering for a UTC instant.
        Some(t) => Value::String(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_max_means_unlimited() {
        let l = InflightLimiter::new(0);
        assert!(l.available().is_none());
        // Every acquire succeeds, and there is no permit to hold.
        let guards: Vec<_> = (0..1000).filter_map(|_| l.try_acquire()).collect();
        assert_eq!(guards.len(), 1000);
        // A negative value is also unlimited, matching Go's `max <= 0`.
        assert!(InflightLimiter::new(-5).try_acquire().is_some());
    }

    #[test]
    fn the_valve_sheds_immediately_at_capacity() {
        let l = InflightLimiter::new(2);
        let a = l.try_acquire().expect("slot 1");
        let b = l.try_acquire().expect("slot 2");
        assert!(
            l.try_acquire().is_none(),
            "at capacity the valve must shed, NOT queue"
        );
        assert_eq!(l.available(), Some(0));
        drop(a);
        let c = l.try_acquire().expect("a released slot is reusable");
        assert_eq!(l.available(), Some(0), "the reused slot is held again");
        drop(b);
        assert_eq!(l.available(), Some(1));
        drop(c);
        assert_eq!(l.available(), Some(2), "every slot returns");
    }

    /// The guard must release on drop even when the handler panics, or one panic
    /// would permanently shrink capacity.
    #[test]
    fn a_panicking_handler_still_releases_its_slot() {
        let l = Arc::new(InflightLimiter::new(1));
        let l2 = l.clone();
        // AssertUnwindSafe is correct here: the semaphore is internally
        // synchronised, so a panic cannot leave it half-updated.
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = l2.try_acquire().expect("slot");
            panic!("handler exploded");
        }));
        assert!(res.is_err());
        assert!(
            l.try_acquire().is_some(),
            "the slot leaked after a panic -- capacity would decay to zero"
        );
    }

    #[tokio::test]
    async fn the_capacity_response_is_a_retryable_503() {
        let resp = at_capacity_response(4, "/anthropic/v1/messages");
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(resp.headers().get("retry-after").unwrap(), "5");
    }

    #[tokio::test]
    async fn a_resolve_deadline_is_a_503_and_anything_else_a_500() {
        let busy = entitlement_error_response(&ResolveError::Deadline);
        assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            busy.headers().get("retry-after").unwrap(),
            "1",
            "the CLI retries on this header"
        );

        let broken = entitlement_error_response(&ResolveError::Store("boom".into()));
        assert_eq!(broken.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(broken.headers().get("retry-after").is_none());
    }

    #[test]
    fn status_and_time_helpers() {
        assert_eq!(status_or_unknown(""), "unknown");
        assert_eq!(status_or_unknown("suspended"), "suspended");
        assert_eq!(iso_time(None), Value::Null);

        let t = DateTime::parse_from_rfc3339("2026-08-01T07:45:09Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            iso_time(Some(t)),
            Value::String("2026-08-01T07:45:09Z".into())
        );
    }
}
