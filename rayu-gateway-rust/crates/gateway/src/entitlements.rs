//! Caches the gateway's read-mostly config (hosted models, media models, app
//! settings, provider routes) in memory and resolves per-user entitlements
//! (status, active plan, allowed models, top-up balance) with a short TTL.
//!
//! Port of the Go gateway's `internal/entitlements`.
//!
//! Two very different caches live here:
//!
//! * the CONFIG snapshot, swapped atomically on reload ([`arc_swap`]), so a
//!   request reads it without a lock;
//! * the per-USER entry, held for `USER_CACHE_TTL_SECONDS`, with concurrent
//!   resolves of the same user sharing ONE database read.
//!
//! The allowed-model list is deliberately NOT part of the cached user entry: it is
//! derived from the LIVE snapshot on every read, so enabling a model in the
//! dashboard takes effect on the user's next request instead of waiting out this
//! user's TTL on top of the config refresh.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use rayu_core::secretbox::Opener;
use rayu_core::store::{AppSettings, HostedModel, MediaModel, Plan, ProviderKey, Store};
use zeroize::Zeroizing;

use crate::providercfg::{self, Options, Route};
use crate::providerkeys::{self, Registry};

/// Bounds the cache-miss path (three sequential MySQL round-trips: user status,
/// active plan, top-up balance).
///
/// Without this, a saturated connection pool under load queues the request
/// indefinitely -- the caller (and its client) sees a hang until the reverse proxy
/// in front of the gateway times out and returns a 502, instead of the gateway
/// itself returning a fast, diagnosable error. This must stay comfortably under any
/// upstream proxy timeout so the gateway is always the one that answers first.
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(3);

/// The resolved access state for a single user.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Entitlement {
    pub user_id: i64,
    pub status: String,
    pub plan: Plan,
    /// Subscription period end (`None` for free / no-expiry).
    pub period_end: Option<DateTime<Utc>>,
    pub allowed_models: Vec<HostedModel>,
    pub topup_balance: i64,
}

impl Entitlement {
    /// Whether the user may use the gateway at all.
    pub fn active(&self) -> bool {
        self.status == "active"
    }
}

/// A provider registry row resolved for use: either a usable route, or the reason
/// it must not be routed.
///
/// Invalid rows are KEPT (rather than dropped) so the request path can answer with
/// a precise, sanitized error and the health endpoint can show an operator exactly
/// what is wrong.
#[derive(Debug, Clone)]
pub struct ProviderRoute {
    pub route: Route,
    pub err: Option<providercfg::ConfigError>,
}

impl ProviderRoute {
    /// Whether the route may serve traffic right now: valid config, provider
    /// enabled, and at least one API key configured.
    pub fn usable(&self) -> bool {
        self.err.is_none() && self.route.enabled && self.route.has_key()
    }
}

/// The whole config snapshot, replaced atomically on reload.
#[derive(Debug, Default)]
pub struct Snapshot {
    pub models: Vec<HostedModel>,
    /// The image/video generation catalog. Snapshotted alongside the chat models
    /// so serving it costs a memory read, exactly like `/v1/models`.
    pub media_models: Vec<MediaModel>,
    pub settings: AppSettings,
    /// The validated provider registry, keyed by provider id, rebuilt on every
    /// refresh. Building it here (rather than per request) means a request never
    /// re-reads the environment, re-parses a URL, or re-validates a row.
    pub routes: HashMap<i64, ProviderRoute>,
}

/// What is actually CACHED for a user: only the parts that come from the database.
#[derive(Debug, Clone)]
struct UserEntry {
    status: String,
    plan: Plan,
    period_end: Option<DateTime<Utc>>,
    topup: i64,
    exp: DateTime<Utc>,
}

/// Why a resolve failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResolveError {
    /// The [`RESOLVE_DEADLINE`] guard tripped -- almost always a saturated MySQL
    /// pool. Reported as a fast, retryable 503 rather than an opaque 500.
    #[error("entitlement resolve timed out")]
    Deadline,
    /// The database read failed.
    #[error("{0}")]
    Store(String),
}

/// The slice of the store that per-user resolution needs.
///
/// Narrowing it here (rather than taking the whole [`Store`]) is what makes
/// [`Cache::resolve`] testable: the cache can be driven by a counting fake, so
/// "one database read per burst" and "a catalog change is visible immediately" are
/// provable without a live MySQL.
#[async_trait::async_trait]
pub trait UserSource: Send + Sync {
    async fn user_status(&self, user_id: i64) -> Result<String, String>;
    async fn active_plan(
        &self,
        user_id: i64,
        now: DateTime<Utc>,
    ) -> Result<(Option<Plan>, Option<DateTime<Utc>>), String>;
    async fn topup_balance(&self, user_id: i64) -> Result<i64, String>;
}

#[async_trait::async_trait]
impl UserSource for Store {
    async fn user_status(&self, user_id: i64) -> Result<String, String> {
        Store::user_status(self, user_id)
            .await
            .map_err(|e| e.to_string())
    }
    async fn active_plan(
        &self,
        user_id: i64,
        now: DateTime<Utc>,
    ) -> Result<(Option<Plan>, Option<DateTime<Utc>>), String> {
        Store::active_plan(self, user_id, now)
            .await
            .map_err(|e| e.to_string())
    }
    async fn topup_balance(&self, user_id: i64) -> Result<i64, String> {
        Store::topup_balance(self, user_id)
            .await
            .map_err(|e| e.to_string())
    }
}

/// The result of an in-flight shared resolve. `None` means "still running".
type ResolveSlot = tokio::sync::watch::Receiver<Option<Result<UserEntry, ResolveError>>>;

/// Config plus per-user entitlement caches.
pub struct Cache {
    /// Present in production; `None` in tests that only exercise resolution.
    store: Option<Arc<Store>>,
    user_src: Arc<dyn UserSource>,
    user_ttl: Duration,
    /// Controls how provider rows are validated into routes (dev flag).
    route_opts: Options,
    /// Decrypts stored provider API keys. `None` when `RAYU_PROVIDER_SECRET` is
    /// unusable -- every key then reports as undecryptable rather than the gateway
    /// silently routing without one.
    opener: Option<Arc<Opener>>,
    /// Holds live per-key health plus the decrypted secrets. Decryption happens
    /// ONCE per refresh, never on the request path.
    keys: Arc<Registry>,

    snapshot: ArcSwap<Snapshot>,

    /// Per-user cache. A plain sharded map with an explicit expiry check plus a
    /// sweep on reload, mirroring Go: an LRU's approximate entry count and lazy
    /// eviction would make the sweep unobservable and change the memory profile.
    ///
    /// Behind an `Arc` because the detached resolve task must keep it alive even if
    /// every caller has hung up.
    users: Arc<DashMap<i64, UserEntry>>,
    /// Deduplicates concurrent resolves of the SAME user. A cache miss is three
    /// sequential MySQL round-trips, and a user's requests arrive in bursts (the
    /// agent loop fires side queries alongside the main turn), so without this one
    /// expiry multiplies into N x 3 queries against a shared pool.
    inflight: Arc<DashMap<i64, ResolveSlot>>,
    /// Counts completed database reads (diagnostics/tests).
    reads: Arc<AtomicUsize>,
}

impl std::fmt::Debug for Cache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cache")
            .field("cached_users", &self.users.len())
            .field("inflight", &self.inflight.len())
            .finish()
    }
}

impl Cache {
    /// Creates a cache. Call [`Cache::reload`] to load the config.
    ///
    /// `opener` decrypts provider API keys (`None` is tolerated: keys then load as
    /// undecryptable, which surfaces in the health endpoint instead of failing
    /// boot). `on_key_state` receives per-key health transitions for durable
    /// write-back; pass `None` to keep state in memory only.
    pub fn new(
        store: Arc<Store>,
        user_ttl: Duration,
        route_opts: Options,
        opener: Option<Arc<Opener>>,
        on_key_state: Option<providerkeys::Sink>,
    ) -> Self {
        let user_src: Arc<dyn UserSource> = store.clone();
        Self {
            store: Some(store),
            user_src,
            user_ttl,
            route_opts,
            opener,
            keys: Arc::new(Registry::new(on_key_state)),
            snapshot: ArcSwap::from_pointee(Snapshot::default()),
            users: Arc::new(DashMap::new()),
            inflight: Arc::new(DashMap::new()),
            reads: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Builds a cache with no database, driven by a fake user source. Test seam.
    #[doc(hidden)]
    pub fn for_tests(user_src: Arc<dyn UserSource>, user_ttl: Duration) -> Self {
        Self {
            store: None,
            user_src,
            user_ttl,
            route_opts: Options::default(),
            opener: None,
            keys: Arc::new(Registry::new(None)),
            snapshot: ArcSwap::from_pointee(Snapshot::default()),
            users: Arc::new(DashMap::new()),
            inflight: Arc::new(DashMap::new()),
            reads: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Replaces the hosted-model catalog without a database. Test seam.
    #[doc(hidden)]
    pub fn set_models_for_tests(&self, models: Vec<HostedModel>) {
        let current = self.snapshot.load();
        self.snapshot.store(Arc::new(Snapshot {
            models,
            media_models: current.media_models.clone(),
            settings: current.settings,
            routes: current.routes.clone(),
        }));
    }

    /// Replaces the media catalog without a database. Test seam.
    #[doc(hidden)]
    pub fn set_media_models_for_tests(&self, media_models: Vec<MediaModel>) {
        let current = self.snapshot.load();
        self.snapshot.store(Arc::new(Snapshot {
            models: current.models.clone(),
            media_models,
            settings: current.settings,
            routes: current.routes.clone(),
        }));
    }

    /// The live key registry (rotation + health).
    pub fn keys(&self) -> &Arc<Registry> {
        &self.keys
    }

    /// The current config snapshot. Cloning the `Arc` is the whole read cost.
    pub fn snapshot(&self) -> arc_swap::Guard<Arc<Snapshot>> {
        self.snapshot.load()
    }

    /// The cached app settings.
    pub fn settings(&self) -> AppSettings {
        self.snapshot.load().settings
    }

    /// The cached hosted-model catalog.
    pub fn models(&self) -> Vec<HostedModel> {
        self.snapshot.load().models.clone()
    }

    /// The cached image/video generation catalog.
    pub fn media_models(&self) -> Vec<MediaModel> {
        self.snapshot.load().media_models.clone()
    }

    /// The resolved provider route for a provider id.
    ///
    /// Served from the in-memory snapshot: no environment read, URL parse, or
    /// validation happens on the request path.
    pub fn route(&self, provider_id: i64) -> Option<ProviderRoute> {
        self.snapshot.load().routes.get(&provider_id).cloned()
    }

    /// A copy of the whole resolved registry (admin health view).
    pub fn routes(&self) -> HashMap<i64, ProviderRoute> {
        self.snapshot.load().routes.clone()
    }

    /// Finds a cached model by its Rayu code.
    pub fn model_by_code(&self, code: &str) -> Option<HostedModel> {
        self.snapshot
            .load()
            .models
            .iter()
            .find(|m| m.code == code)
            .cloned()
    }

    /// Turns a stored row into a usable key.
    ///
    /// A key that cannot be decrypted is KEPT but marked invalid rather than
    /// dropped: an operator needs to see "this key can't be decrypted -- is
    /// `RAYU_PROVIDER_SECRET` the same value as the backend's?" instead of a key
    /// silently vanishing from rotation.
    fn open_key(&self, k: &ProviderKey) -> providerkeys::Key {
        let mut out = providerkeys::Key {
            id: k.id,
            label: k.label.clone(),
            secret: Zeroizing::new(String::new()),
            masked: k.masked_key.clone(),
            priority: k.priority,
            enabled: k.enabled,
            status: Some(providerkeys::Status::from_db(&k.status)),
            cooldown_until: k.cooldown_until,
        };
        let Some(opener) = &self.opener else {
            out.status = Some(providerkeys::Status::Invalid);
            return out;
        };
        match opener.open(&k.encrypted_key) {
            Ok(secret) => {
                out.secret = secret;
                out
            }
            Err(_) => {
                out.status = Some(providerkeys::Status::Invalid);
                out
            }
        }
    }

    /// Refreshes the config snapshot NOW.
    ///
    /// The request path must never call this -- it is several database queries, and
    /// the whole point of the snapshot is that a request reads memory. It exists
    /// for the periodic refresh and for ADMIN actions that need to see their own
    /// write immediately: a key or model saved a second ago is not in the snapshot
    /// yet, so "save then test" would otherwise fail for up to the refresh
    /// interval and look like a broken feature.
    pub async fn reload(&self) -> Result<(), sqlx::Error> {
        let Some(store) = &self.store else {
            return Ok(()); // no database (tests)
        };

        let models = store.load_models().await?;
        let settings = store.load_settings().await?;
        // The MEDIA catalog is best-effort: a database that predates the
        // media_models migration must not stop the gateway from serving chat
        // traffic. A load failure keeps the previous snapshot and the CLI falls
        // back to its documented offline behaviour.
        let media_result = store.load_media_models().await;
        let media_models = match media_result {
            Ok(m) => Some(m),
            Err(e) => {
                tracing::warn!(
                    "entitlements: media model catalog unavailable, keeping last snapshot: {e}"
                );
                None
            }
        };
        let providers = store.load_providers().await?;
        let stored_keys = store.load_provider_keys().await?;

        // Decrypt ONCE per refresh, here, and hand the plaintext to the in-memory
        // registry. A request then never touches the database or the cipher.
        let mut by_provider: HashMap<i64, Vec<providerkeys::Key>> = HashMap::new();
        for k in &stored_keys {
            by_provider
                .entry(k.provider_id)
                .or_default()
                .push(self.open_key(k));
        }

        let mut routes = HashMap::with_capacity(providers.len());
        for p in &providers {
            let keys = by_provider.get(&p.id).cloned().unwrap_or_default();
            let key_count = keys.len();
            self.keys.replace(p.id, keys);
            let (route, err) = providercfg::build(
                providercfg::Row {
                    name: p.name.clone(),
                    format: p.format.clone(),
                    base_url: p.base_url.clone(),
                    endpoint_path: p.endpoint_path.clone(),
                    auth_scheme: p.auth_scheme.clone(),
                    enabled: p.enabled,
                    // Tells the route whether it has anything to authenticate
                    // with, without exposing the keys themselves.
                    key_count,
                },
                self.route_opts,
            );
            routes.insert(p.id, ProviderRoute { route, err });
        }

        // A provider deleted in the dashboard must not keep its keys in memory.
        for id in by_provider.keys() {
            if !providers.iter().any(|p| p.id == *id) {
                self.keys.forget(*id);
            }
        }

        let previous = self.snapshot.load();
        self.snapshot.store(Arc::new(Snapshot {
            models,
            media_models: media_models.unwrap_or_else(|| previous.media_models.clone()),
            settings,
            routes,
        }));

        // Drop expired per-user entries. Nothing else removes them: invalidate is
        // targeted and a re-resolve only overwrites the users who came back, so a
        // long-running gateway would otherwise keep an entry for every account that
        // has ever made a request. Piggy-backing on the refresh keeps it free of
        // its own timer.
        self.sweep_users(Utc::now());
        Ok(())
    }

    /// Removes per-user entries whose TTL has passed.
    pub fn sweep_users(&self, now: DateTime<Utc>) {
        self.users.retain(|_, e| e.exp > now);
    }

    /// Returns the user's entitlement, caching only the database-derived parts for
    /// the configured TTL.
    ///
    /// The allowed-model list is rebuilt from the current config snapshot on every
    /// call, so a catalog change is visible on the next request rather than after
    /// this user's TTL also expires.
    ///
    /// Concurrent resolves of the same user share one database read. A caller that
    /// gives up (its future is dropped because the client disconnected) does NOT
    /// abort that read: it runs on a detached task, so its result still populates
    /// the cache for everyone else.
    pub async fn resolve(&self, user_id: i64) -> Result<Entitlement, ResolveError> {
        let now = Utc::now();
        if let Some(e) = self.users.get(&user_id) {
            if e.exp > now {
                let entry = e.clone();
                drop(e);
                return Ok(self.entitlement_for(user_id, &entry));
            }
        }

        let mut rx = self.begin_resolve(user_id);
        loop {
            if let Some(result) = rx.borrow_and_update().clone() {
                return result.map(|entry| self.entitlement_for(user_id, &entry));
            }
            if rx.changed().await.is_err() {
                // The sender was dropped without publishing, which the detached
                // task never does; treat it as a transient failure rather than
                // hanging.
                return Err(ResolveError::Store(
                    "entitlement resolve produced no result".into(),
                ));
            }
        }
    }

    /// Joins (or starts) the shared read for `user_id`.
    fn begin_resolve(&self, user_id: i64) -> ResolveSlot {
        // `entry` holds the shard lock, so exactly one caller can create the slot.
        match self.inflight.entry(user_id) {
            dashmap::mapref::entry::Entry::Occupied(e) => e.get().clone(),
            dashmap::mapref::entry::Entry::Vacant(e) => {
                let (tx, rx) = tokio::sync::watch::channel(None);
                e.insert(rx.clone());

                let src = self.user_src.clone();
                let ttl = self.user_ttl;
                // Cloning these Arc-backed handles keeps the task independent of
                // the caller's lifetime; it must outlive a disconnected client.
                let users = self.users.clone();
                let inflight = self.inflight.clone();
                let reads = self.reads.clone();

                tokio::spawn(async move {
                    let result = match tokio::time::timeout(
                        RESOLVE_DEADLINE,
                        read_user(&*src, user_id, ttl),
                    )
                    .await
                    {
                        Ok(Ok(entry)) => Ok(entry),
                        Ok(Err(e)) => Err(ResolveError::Store(e)),
                        Err(_) => Err(ResolveError::Deadline),
                    };
                    reads.fetch_add(1, Ordering::Relaxed);

                    // Clear the in-flight slot BEFORE waking the waiters, so a
                    // caller arriving from here on starts a fresh read instead of
                    // joining one that has already read the database.
                    inflight.remove(&user_id);
                    if let Ok(entry) = &result {
                        users.insert(user_id, entry.clone());
                    }
                    // A failure is deliberately NOT cached: the next request retries.
                    let _ = tx.send(Some(result));
                });
                rx
            }
        }
    }

    /// Drops a user's cached entitlement so the next [`Cache::resolve`] re-reads
    /// (used after a settle changes the top-up balance).
    pub fn invalidate(&self, user_id: i64) {
        self.users.remove(&user_id);
    }

    /// How many per-user entries are held right now (tests/diagnostics).
    pub fn cached_users(&self) -> usize {
        self.users.len()
    }

    /// How many database reads have completed (tests/diagnostics).
    pub fn read_count(&self) -> usize {
        self.reads.load(Ordering::Relaxed)
    }

    /// Joins a cached user entry to the CURRENT catalog snapshot.
    fn entitlement_for(&self, user_id: i64, e: &UserEntry) -> Entitlement {
        Entitlement {
            user_id,
            status: e.status.clone(),
            plan: e.plan.clone(),
            period_end: e.period_end,
            allowed_models: allowed_models(&self.snapshot.load().models, &e.plan.code),
            topup_balance: e.topup,
        }
    }
}

/// The database half: status, active plan, top-up balance.
async fn read_user(src: &dyn UserSource, user_id: i64, ttl: Duration) -> Result<UserEntry, String> {
    let now = Utc::now();
    let status = src.user_status(user_id).await?;
    let (plan, period_end) = src.active_plan(user_id, now).await?;
    let topup = src.topup_balance(user_id).await?;
    Ok(UserEntry {
        status,
        // A user with no subscription resolves to the free plan rather than an error.
        plan: plan.unwrap_or_else(|| Plan {
            code: "free".into(),
            ..Default::default()
        }),
        period_end,
        topup,
        exp: now
            + chrono::Duration::from_std(ttl).unwrap_or_else(|_| chrono::Duration::seconds(10)),
    })
}

/// Returns enabled models whose `allowedPlanCodes` include `plan_code`.
///
/// An EMPTY `allowedPlanCodes` means NOBODY -- the opposite of the media catalog's
/// rule. A chat model must be granted to a plan explicitly.
pub fn allowed_models(models: &[HostedModel], plan_code: &str) -> Vec<HostedModel> {
    models
        .iter()
        .filter(|m| m.enabled && m.allowed_plan_codes.iter().any(|pc| pc == plan_code))
        .cloned()
        .collect()
}

/// Returns the ENABLED media models a plan may use, optionally narrowed to one
/// media type (`"image"` / `"video"`; empty means both).
///
/// An EMPTY `allowedPlanCodes` means EVERY plan -- the opposite of
/// [`allowed_models`]. Media generation is gated by the per-plan
/// `image_generation` / `video_generation` feature flags, so an unrestricted model
/// is the normal case and reading an empty list as "nobody" would hide the whole
/// catalog.
pub fn allowed_media_models(
    models: &[MediaModel],
    plan_code: &str,
    media_type: &str,
) -> Vec<MediaModel> {
    models
        .iter()
        .filter(|m| m.enabled)
        .filter(|m| media_type.is_empty() || m.media_type == media_type)
        .filter(|m| {
            m.allowed_plan_codes.is_empty() || m.allowed_plan_codes.iter().any(|pc| pc == plan_code)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicI64;

    /// The three per-user queries with a call counter, standing in for MySQL. Each
    /// resolve miss is three sequential round-trips in production.
    struct CountingUserStore {
        calls: AtomicI64,
        status: std::sync::Mutex<String>,
        plan: Option<Plan>,
        topup: i64,
        err: Option<String>,
        /// When set, reads wait on it (so a test can line up a burst).
        gate: Option<Arc<tokio::sync::Notify>>,
        /// Signalled once a read has started.
        entered: Option<Arc<tokio::sync::Notify>>,
    }

    impl CountingUserStore {
        fn new(status: &str, plan: Option<Plan>, topup: i64) -> Self {
            Self {
                calls: AtomicI64::new(0),
                status: std::sync::Mutex::new(status.into()),
                plan,
                topup,
                err: None,
                gate: None,
                entered: None,
            }
        }
        fn failing(err: &str) -> Self {
            Self {
                err: Some(err.into()),
                ..Self::new("active", None, 0)
            }
        }
        fn calls(&self) -> i64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl UserSource for CountingUserStore {
        async fn user_status(&self, _user_id: i64) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(e) = &self.entered {
                e.notify_waiters();
            }
            if let Some(g) = &self.gate {
                g.notified().await;
            }
            if let Some(e) = &self.err {
                return Err(e.clone());
            }
            Ok(self.status.lock().unwrap().clone())
        }
        async fn active_plan(
            &self,
            _user_id: i64,
            _now: DateTime<Utc>,
        ) -> Result<(Option<Plan>, Option<DateTime<Utc>>), String> {
            if let Some(e) = &self.err {
                return Err(e.clone());
            }
            Ok((self.plan.clone(), None))
        }
        async fn topup_balance(&self, _user_id: i64) -> Result<i64, String> {
            if let Some(e) = &self.err {
                return Err(e.clone());
            }
            Ok(self.topup)
        }
    }

    fn pro_plan() -> Plan {
        Plan {
            code: "pro".into(),
            ..Default::default()
        }
    }

    fn pro_model(code: &str, enabled: bool) -> HostedModel {
        HostedModel {
            code: code.into(),
            label: code.into(),
            provider_id: 1,
            upstream_model_id: code.into(),
            enabled,
            allowed_plan_codes: vec!["pro".into()],
            ..Default::default()
        }
    }

    fn cache_with(
        us: Arc<CountingUserStore>,
        ttl: Duration,
        models: Vec<HostedModel>,
    ) -> Arc<Cache> {
        let c = Arc::new(Cache::for_tests(us, ttl));
        c.set_models_for_tests(models);
        c
    }

    /// A burst of requests from one user (the agent loop fires side queries
    /// alongside the main turn) must cost ONE resolve, not one per request: each
    /// miss is three sequential MySQL round-trips against a shared pool.
    #[tokio::test]
    async fn resolve_collapses_a_concurrent_burst() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let us = Arc::new(CountingUserStore {
            gate: Some(gate.clone()),
            entered: Some(entered.clone()),
            ..CountingUserStore::new("active", Some(pro_plan()), 5)
        });
        let c = cache_with(
            us.clone(),
            Duration::from_secs(60),
            vec![pro_model("m1", true)],
        );

        // Start one resolve and wait until it is genuinely inside the store, so the
        // others cannot race ahead and start their own.
        let entered_wait = entered.notified();
        let first = {
            let c = c.clone();
            tokio::spawn(async move { c.resolve(7).await })
        };
        entered_wait.await;

        let mut handles = vec![first];
        for _ in 1..8 {
            let c = c.clone();
            handles.push(tokio::spawn(async move { c.resolve(7).await }));
        }
        // Yield until every joiner has been polled at least once, so each has
        // registered in `inflight` before the gate opens. A fixed sleep would make
        // this test scheduling-dependent: a starved runtime could open the gate
        // before a joiner registered, and that joiner would then start a SECOND
        // read and fail the assertion for the wrong reason.
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        gate.notify_waiters();

        for h in handles {
            let ent = h.await.expect("task").expect("resolve");
            assert_eq!(ent.plan.code, "pro");
            assert_eq!(ent.topup_balance, 5);
        }
        assert_eq!(
            us.calls(),
            1,
            "a burst must share one resolve, not one read per request"
        );
    }

    /// Different users must NOT be serialised behind each other -- the dedupe is
    /// per user, not global.
    #[tokio::test]
    async fn resolve_does_not_serialise_different_users() {
        let us = Arc::new(CountingUserStore::new("active", Some(pro_plan()), 0));
        let c = cache_with(us.clone(), Duration::from_secs(60), vec![]);
        for uid in [1, 2, 3] {
            c.resolve(uid).await.expect("resolve");
        }
        assert_eq!(us.calls(), 3, "one read per distinct user");
    }

    /// THE FRESHNESS RULE: the allowed-model list must come from the live snapshot,
    /// not from whatever it was when the user's entry was cached. Otherwise enabling
    /// a model in the dashboard waits for the config refresh AND then this user's
    /// TTL, and the model stays "not available on your plan" in the meantime.
    #[tokio::test]
    async fn resolve_sees_a_catalog_change_within_the_user_ttl() {
        let us = Arc::new(CountingUserStore::new("active", Some(pro_plan()), 0));
        let c = cache_with(
            us.clone(),
            Duration::from_secs(3600),
            vec![pro_model("m1", true)],
        );

        let first = c.resolve(7).await.expect("resolve");
        assert_eq!(first.allowed_models.len(), 1);

        // The admin adds a model and enables it; the config snapshot picks it up.
        c.set_models_for_tests(vec![pro_model("m1", true), pro_model("m2", true)]);
        let second = c.resolve(7).await.expect("resolve");
        assert_eq!(
            second.allowed_models.len(),
            2,
            "the new model must be usable immediately"
        );
        // ...and that must not have cost another database read.
        assert_eq!(
            us.calls(),
            1,
            "freshness must not come from re-querying the user"
        );

        // Disabling one is visible the same way.
        c.set_models_for_tests(vec![pro_model("m1", true), pro_model("m2", false)]);
        let third = c.resolve(7).await.expect("resolve");
        assert_eq!(third.allowed_models.len(), 1);
    }

    /// An expired entry must be re-read, not served stale.
    #[tokio::test]
    async fn resolve_refreshes_after_the_ttl() {
        let us = Arc::new(CountingUserStore::new("active", Some(pro_plan()), 0));
        let c = cache_with(us.clone(), Duration::from_millis(1), vec![]);

        c.resolve(7).await.expect("resolve");
        tokio::time::sleep(Duration::from_millis(10)).await;
        *us.status.lock().unwrap() = "suspended".into();

        let got = c.resolve(7).await.expect("resolve");
        assert_eq!(got.status, "suspended");
        assert!(!got.active());
        assert_eq!(us.calls(), 2);
    }

    /// A failed resolve must not be cached (the next request should retry) and must
    /// reach every waiter in the burst.
    #[tokio::test]
    async fn resolve_does_not_cache_failures() {
        let us = Arc::new(CountingUserStore::failing("dial tcp: i/o timeout"));
        let c = cache_with(us.clone(), Duration::from_secs(60), vec![]);

        for attempt in 0..2 {
            let err = c.resolve(7).await.expect_err("must fail");
            assert!(
                matches!(err, ResolveError::Store(ref m) if m.contains("i/o timeout")),
                "attempt {attempt} got {err:?}"
            );
        }
        assert_eq!(us.calls(), 2, "a failure must not be cached");
        assert_eq!(c.cached_users(), 0);
    }

    /// The per-user map only ever grew: invalidate is targeted and a re-resolve
    /// overwrites just the users who came back, so a long-lived gateway kept an
    /// entry for every account that ever made a request.
    #[tokio::test]
    async fn sweep_removes_expired_users() {
        let us = Arc::new(CountingUserStore::new("active", Some(pro_plan()), 0));
        let c = cache_with(us, Duration::from_millis(10), vec![]);

        for uid in [1, 2, 3] {
            c.resolve(uid).await.expect("resolve");
        }
        assert_eq!(c.cached_users(), 3);

        // Nothing has expired yet.
        c.sweep_users(Utc::now());
        assert_eq!(c.cached_users(), 3, "an early sweep must keep live entries");

        tokio::time::sleep(Duration::from_millis(25)).await;
        c.sweep_users(Utc::now());
        assert_eq!(c.cached_users(), 0);
    }

    /// A caller that gives up (client disconnected) must not poison the shared
    /// read: the resolve completes and populates the cache for everyone else.
    ///
    /// In Rust "giving up" is dropping the future, so the test drops it via
    /// `select!` rather than cancelling a context.
    #[tokio::test]
    async fn cancelled_caller_does_not_abort_the_read() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let us = Arc::new(CountingUserStore {
            gate: Some(gate.clone()),
            entered: Some(entered.clone()),
            ..CountingUserStore::new("active", Some(pro_plan()), 0)
        });
        let c = cache_with(us.clone(), Duration::from_secs(60), vec![]);

        // Abandon the caller while the read is still inside the store.
        let entered_wait = entered.notified();
        let abandoned = async {
            tokio::select! {
                _ = c.resolve(7) => panic!("resolve should not have completed yet"),
                _ = entered_wait => {}
            }
        };
        abandoned.await;

        gate.notify_waiters();

        // The detached read still finished, so the next caller is served from cache.
        for _ in 0..200 {
            if c.cached_users() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            c.cached_users(),
            1,
            "the abandoned resolve did not populate the cache"
        );
        c.resolve(7).await.expect("resolve after cancellation");
        assert_eq!(us.calls(), 1, "the completed read must be reused");
    }

    /// A user with no subscription resolves to the free plan rather than an error.
    #[tokio::test]
    async fn resolve_falls_back_to_free() {
        let us = Arc::new(CountingUserStore::new("active", None, 0));
        let c = cache_with(us, Duration::from_secs(60), vec![]);
        let got = c.resolve(7).await.expect("resolve");
        assert_eq!(got.plan.code, "free");
    }

    /// A read that outlives the deadline is reported as [`ResolveError::Deadline`]
    /// so the route can answer 503 "gateway busy" instead of an opaque 500.
    #[tokio::test]
    async fn resolve_deadline_is_classified_separately() {
        struct Slow;
        #[async_trait::async_trait]
        impl UserSource for Slow {
            async fn user_status(&self, _u: i64) -> Result<String, String> {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok("active".into())
            }
            async fn active_plan(
                &self,
                _u: i64,
                _n: DateTime<Utc>,
            ) -> Result<(Option<Plan>, Option<DateTime<Utc>>), String> {
                Ok((None, None))
            }
            async fn topup_balance(&self, _u: i64) -> Result<i64, String> {
                Ok(0)
            }
        }
        // Pause the clock so the 3s deadline is reached without a real 3s wait.
        tokio::time::pause();
        let c = Arc::new(Cache::for_tests(Arc::new(Slow), Duration::from_secs(60)));
        let handle = {
            let c = c.clone();
            tokio::spawn(async move { c.resolve(7).await })
        };
        tokio::time::advance(RESOLVE_DEADLINE + Duration::from_secs(1)).await;
        let err = handle.await.expect("task").expect_err("must time out");
        assert_eq!(err, ResolveError::Deadline);
        assert_eq!(c.cached_users(), 0, "a timeout must not be cached");
    }

    /// Port of Go's `TestAllowedModels`.
    #[test]
    fn allowed_models_is_an_explicit_grant() {
        let paid = vec!["pro".to_string(), "pro_plus".to_string(), "max".to_string()];
        let models = vec![
            HostedModel {
                code: "deepseek-v4-flash".into(),
                enabled: true,
                allowed_plan_codes: paid.clone(),
                ..Default::default()
            },
            HostedModel {
                code: "deepseek-v4-pro".into(),
                enabled: true,
                allowed_plan_codes: paid,
                ..Default::default()
            },
            HostedModel {
                code: "disabled-model".into(),
                enabled: false,
                allowed_plan_codes: vec!["pro".into()],
                ..Default::default()
            },
            HostedModel {
                code: "ultra-only".into(),
                enabled: true,
                allowed_plan_codes: vec!["max".into()],
                ..Default::default()
            },
        ];

        assert_eq!(allowed_models(&models, "pro").len(), 2);
        // An empty allow-list, or a plan not on it, means NOBODY.
        assert_eq!(allowed_models(&models, "free").len(), 0);
        assert_eq!(allowed_models(&models, "max").len(), 3);
        assert_eq!(allowed_models(&models, "pro_plus").len(), 2);
        // A disabled model is never allowed, even for a plan that lists it.
        assert!(!allowed_models(&models, "pro")
            .iter()
            .any(|m| m.code == "disabled-model"));
    }

    /// The media catalog inverts the empty-list rule: unrestricted means everyone.
    #[test]
    fn allowed_media_models_inverts_the_empty_list_rule() {
        let models = vec![
            MediaModel {
                code: "flux-schnell".into(),
                media_type: "image".into(),
                enabled: true,
                allowed_plan_codes: vec![], // every plan
                ..Default::default()
            },
            MediaModel {
                code: "veo-3".into(),
                media_type: "video".into(),
                enabled: true,
                allowed_plan_codes: vec!["max".into()],
                ..Default::default()
            },
            MediaModel {
                code: "off".into(),
                media_type: "image".into(),
                enabled: false,
                allowed_plan_codes: vec![],
                ..Default::default()
            },
        ];

        // Empty filter = both media types.
        let free = allowed_media_models(&models, "free", "");
        assert_eq!(free.len(), 1, "an unrestricted model is open to every plan");
        assert_eq!(free[0].code, "flux-schnell");

        let max = allowed_media_models(&models, "max", "");
        assert_eq!(max.len(), 2);

        // Media-type filter.
        assert_eq!(allowed_media_models(&models, "max", "image").len(), 1);
        assert_eq!(allowed_media_models(&models, "max", "video").len(), 1);
        assert_eq!(allowed_media_models(&models, "free", "video").len(), 0);
        // A disabled model is never listed.
        assert!(!allowed_media_models(&models, "max", "")
            .iter()
            .any(|m| m.code == "off"));
    }

    #[test]
    fn provider_route_usability() {
        let ok = Route {
            enabled: true,
            key_count: 1,
            ..Default::default()
        };
        assert!(ProviderRoute {
            route: ok.clone(),
            err: None
        }
        .usable());
        // An invalid row is never usable, however healthy it looks.
        assert!(!ProviderRoute {
            route: ok.clone(),
            err: Some(providercfg::ConfigError::BaseUrlNotHttps)
        }
        .usable());
        // Disabled by the admin.
        assert!(!ProviderRoute {
            route: Route {
                enabled: false,
                ..ok.clone()
            },
            err: None
        }
        .usable());
        // No key configured.
        assert!(!ProviderRoute {
            route: Route { key_count: 0, ..ok },
            err: None
        }
        .usable());
    }

    #[test]
    fn entitlement_active_only_for_active_status() {
        for (status, want) in [
            ("active", true),
            ("suspended", false),
            ("banned", false),
            ("", false),
        ] {
            let e = Entitlement {
                status: status.into(),
                ..Default::default()
            };
            assert_eq!(e.active(), want, "status={status}");
        }
    }

    /// A key that cannot be opened must be KEPT and marked invalid, never dropped
    /// and never usable: an operator has to be able to see "this key can't be
    /// decrypted" instead of a key silently vanishing.
    #[test]
    fn open_key_keeps_undecryptable_keys_as_invalid() {
        const MASTER: &str = "entitlements-master-secret-0123456789abcdef";
        // Sealed by the same envelope format the backend writes.
        let sealed = seal_for_test(MASTER, "sk-live-secret");

        for (name, master) in [
            (
                "wrong master key",
                Some("a-different-master-secret-0123456789abcdef"),
            ),
            ("no master key", None),
        ] {
            let opener = master.map(|m| Arc::new(Opener::new(m).expect("opener")));
            let c = Cache {
                opener,
                ..Cache::for_tests(
                    Arc::new(CountingUserStore::new("active", None, 0)),
                    Duration::from_secs(60),
                )
            };
            let got = c.open_key(&ProviderKey {
                id: 3,
                provider_id: 1,
                masked_key: "sk-…xyz".into(),
                encrypted_key: sealed.clone(),
                enabled: true,
                status: "active".into(),
                ..Default::default()
            });
            assert_eq!(
                got.status,
                Some(providerkeys::Status::Invalid),
                "{name}: must be marked invalid"
            );
            assert!(
                got.secret.is_empty(),
                "{name}: a key that failed to open must carry no secret"
            );
            assert_eq!(got.id, 3, "{name}: the key was dropped instead of reported");
            assert_eq!(got.masked, "sk-…xyz");
        }
    }

    /// A decryptable key must reach the registry with its plaintext and its stored
    /// admin/health state intact -- that plaintext is what makes "no decryption on
    /// the request path" possible.
    #[test]
    fn open_key_decrypts_and_restores_persisted_health() {
        const MASTER: &str = "entitlements-master-secret-0123456789abcdef";
        let sealed = seal_for_test(MASTER, "sk-live-secret");
        let cool = Utc::now() + chrono::Duration::seconds(30);

        let c = Cache {
            opener: Some(Arc::new(Opener::new(MASTER).expect("opener"))),
            ..Cache::for_tests(
                Arc::new(CountingUserStore::new("active", None, 0)),
                Duration::from_secs(60),
            )
        };
        let got = c.open_key(&ProviderKey {
            id: 7,
            provider_id: 1,
            label: "primary".into(),
            masked_key: "sk-…def".into(),
            encrypted_key: sealed,
            priority: 2,
            enabled: true,
            status: "rate_limited".into(),
            cooldown_until: Some(cool),
        });
        assert_eq!(got.secret.as_str(), "sk-live-secret");
        assert_eq!(got.id, 7);
        assert_eq!(got.label, "primary");
        assert_eq!(got.masked, "sk-…def");
        assert_eq!(got.priority, 2);
        assert!(got.enabled);
        assert_eq!(got.status, Some(providerkeys::Status::RateLimited));
        assert_eq!(got.cooldown_until, Some(cool));
    }

    /// Produces an envelope byte-for-byte the way the BACKEND does. The gateway is
    /// decrypt-only on purpose -- it never needs to create a key -- so the sealing
    /// half lives here, in the test, and any drift in the shared envelope format
    /// shows up as a failure to open.
    fn seal_for_test(master: &str, plaintext: &str) -> String {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Key, Nonce};
        use base64::Engine as _;
        use sha2::{Digest, Sha256};

        let digest = Sha256::digest(master.as_bytes());
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&digest));
        let iv = [7u8; 12]; // deterministic: this is a test fixture, not a secret
        let sealed = cipher
            .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
            .expect("encrypt");
        let (ct, tag) = sealed.split_at(sealed.len() - 16);
        let mut env = Vec::with_capacity(12 + 16 + ct.len());
        env.extend_from_slice(&iv);
        env.extend_from_slice(tag);
        env.extend_from_slice(ct);
        format!(
            "v1:{}",
            base64::engine::general_purpose::STANDARD.encode(env)
        )
    }

    /// Route building must reflect how many keys a provider actually has, because
    /// `key_count` is what makes a keyless provider visibly unroutable at boot.
    #[test]
    fn keys_registry_drives_route_key_count() {
        let c = Cache::for_tests(
            Arc::new(CountingUserStore::new("active", None, 0)),
            Duration::from_secs(60),
        );
        c.keys().replace(
            1,
            vec![
                providerkeys::Key {
                    id: 1,
                    secret: Zeroizing::new("a".into()),
                    enabled: true,
                    status: Some(providerkeys::Status::Active),
                    ..Default::default()
                },
                providerkeys::Key {
                    id: 2,
                    secret: Zeroizing::new("b".into()),
                    enabled: true,
                    status: Some(providerkeys::Status::Active),
                    ..Default::default()
                },
            ],
        );
        assert_eq!(c.keys().usable(1), 2);

        // Forget is what a deleted provider must trigger: its decrypted keys cannot
        // stay resident in memory.
        c.keys().forget(1);
        assert_eq!(c.keys().usable(1), 0);
    }
}
