//! Read access to the shared MySQL database, plus the handful of writes the
//! gateway owns.
//!
//! Port of the Go gateway's `internal/store/store.go`. It mirrors the Prisma
//! schema's table/column names (camelCase, unquoted) and applies the same
//! active-plan resolution (most-recent active subscription, free fallback) plus
//! period-expiry handling.
//!
//! Prisma owns the schema; this module never migrates. Every statement lists its
//! columns EXPLICITLY (never `SELECT *`), so a column added by a future backend
//! migration is ignored here instead of breaking decoding.

use std::time::Duration;

use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions};
use sqlx::{ConnectOptions, Row};

/// Pool sizing for a gateway that serves concurrent streaming traffic.
///
/// The prior Go defaults (10 open / 5 idle) starved under load: once concurrent
/// requests exceeded 10, queries queued waiting for a free connection with no
/// acquire timeout, so the gateway appeared to hang instead of failing fast --
/// which is what turns into a client-visible 502 once the reverse proxy in front
/// of it times out.
///
/// 64 open / 16 idle gives headroom for concurrent entitlement lookups
/// (cache-miss path: 3 sequential queries) plus the async ledger/usage writer,
/// while staying well under MySQL's default `max_connections` (151) even with the
/// backend's own Prisma pool sharing the instance.
const MAX_CONNECTIONS: u32 = 64;
const MIN_CONNECTIONS: u32 = 16;
const MAX_LIFETIME: Duration = Duration::from_secs(3 * 60);
/// Idle connections older than this are closed even when `MIN_CONNECTIONS` has
/// room, so a load spike's connections get reaped afterwards instead of sitting
/// open indefinitely.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// A row in `providers`: the admin-managed registry that tells the gateway HOW to
/// talk to an upstream (wire format, URL, auth scheme).
///
/// SECURITY: no credential lives on this row. A provider's keys are separate
/// `provider_api_keys` rows, encrypted at rest.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Provider {
    #[serde(skip)]
    pub id: i64,
    pub name: String,
    #[serde(skip)]
    pub label: String,
    #[serde(skip)]
    pub format: String,
    #[serde(skip)]
    pub base_url: String,
    #[serde(skip)]
    pub endpoint_path: String,
    #[serde(skip)]
    pub auth_scheme: String,
    #[serde(skip)]
    pub enabled: bool,
}

/// A row in `hosted_models`.
///
/// The four credit charges (`credit_multiplier` = input, plus output, cache-read
/// and cache-write) are ADMIN-ENTERED and used verbatim; nothing is derived from
/// the cost prices, which feed only the internal cost ledger.
///
/// Routing lives entirely on [`Provider`]: a model contributes only its upstream
/// model id. `supports_*` are the per-model capability flags the gateway enforces
/// (before charging credits) and exposes to the CLI.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct HostedModel {
    pub code: String,
    pub label: String,
    #[serde(skip)]
    pub provider_id: i64,
    pub provider: Provider,
    #[serde(skip)]
    pub upstream_model_id: String,
    #[serde(skip)]
    pub input_price_per_1m_cents: i64,
    #[serde(skip)]
    pub output_price_per_1m_cents: i64,
    #[serde(rename = "creditMultiplier")]
    pub credit_multiplier: f64,
    #[serde(skip)]
    pub output_credit_multiplier: f64,
    #[serde(skip)]
    pub cache_read_credit_multiplier: f64,
    #[serde(skip)]
    pub cache_write_credit_multiplier: f64,
    #[serde(skip)]
    pub allowed_plan_codes: Vec<String>,
    /// Admin-set window in TOKENS, or `None` when unset (the client then keeps
    /// its own default for the model).
    #[serde(rename = "contextWindow")]
    pub context_window: Option<i64>,
    #[serde(rename = "supportsReasoning")]
    pub supports_reasoning: bool,
    #[serde(rename = "supportsImage")]
    pub supports_image: bool,
    #[serde(rename = "supportsTools")]
    pub supports_tools: bool,
    #[serde(skip)]
    pub enabled: bool,
}

impl HostedModel {
    /// The provider slug this model routes through (used in logs and per-provider
    /// key rotation).
    pub fn provider_name(&self) -> &str {
        &self.provider.name
    }
}

/// A row in `media_models`: the admin-owned catalog of IMAGE- and
/// VIDEO-generation models the CLI offers.
///
/// Unlike [`HostedModel`] this is NOT a routing record. Media generation is not
/// proxied by the gateway -- the CLI calls NVIDIA / Vertex / fal directly with the
/// user's own key -- so there is no provider, wire format, or credential here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaModel {
    pub code: String,
    pub label: String,
    /// `"image"` | `"video"`.
    pub media_type: String,
    /// image → generate/edit; video → text2video/image2video. An array because
    /// some models do both.
    pub capabilities: Vec<String>,
    /// Upstream that serves it: nvidia | vertex | nvcf | nvidia-svd | fal.
    pub backend: String,
    /// Request-SHAPE family. The CLI keys its body builder off this string, so a
    /// new model reusing a known shape needs no client release.
    pub family: String,
    /// NVCF function UUID; empty for models that don't need one.
    pub nvcf_function_id: String,
    /// Rough generation seconds for the client's wait message.
    pub estimated_seconds: Option<i64>,
    /// Per-model request defaults, kept as raw JSON: the gateway has no business
    /// interpreting upstream request params, it just carries what the admin set.
    pub default_params: Option<serde_json::Value>,
    /// Plans allowed to use it. EMPTY = every plan (media generation is gated by
    /// the image/video feature flags, not per model).
    pub allowed_plan_codes: Vec<String>,
    /// Preferred pick for its (mediaType, backend) pair.
    pub is_default: bool,
    pub sort_order: i64,
    pub enabled: bool,
}

impl MediaModel {
    /// Whether the model declares the given capability.
    pub fn has_capability(&self, c: &str) -> bool {
        self.capabilities.iter().any(|have| have == c)
    }
}

/// The singleton `app_settings` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppSettings {
    pub baseline_credits_per_1m: i64,
    pub max_concurrent_streams: i64,
    pub max_tokens_per_request: i64,
    pub max_requests_per_5h: i64,
    /// Credit top-up pricing, as the admin set it: how many credits $1 buys
    /// (0 = top-up unavailable) and the smallest purchase in cents.
    pub credits_per_dollar: i64,
    pub min_topup_cents: i64,
}

impl Default for AppSettings {
    /// The values Go returns when `app_settings` has no row.
    fn default() -> Self {
        Self {
            baseline_credits_per_1m: 1000,
            max_concurrent_streams: 3,
            max_tokens_per_request: 0,
            max_requests_per_5h: 0,
            credits_per_dollar: 0,
            min_topup_cents: 0,
        }
    }
}

/// A plan, with the credit fields decoded from its `limits` JSON.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Plan {
    #[serde(skip)]
    pub id: i64,
    pub code: String,
    pub name: String,
    #[serde(rename = "priceCents")]
    pub price_cents: i64,
    /// Per-billing-period balance; `None` = none.
    #[serde(rename = "creditsPerPeriod")]
    pub credits_per_period: Option<i64>,
    #[serde(rename = "topUpEnabled")]
    pub top_up_enabled: bool,
    /// Per-day turn cap; `None` = unlimited.
    #[serde(rename = "maxDailyTurns")]
    pub max_daily_turns: Option<i64>,
}

/// A row in `provider_api_keys`.
///
/// `encrypted_key` is an AES-256-GCM envelope the gateway opens with
/// `RAYU_PROVIDER_SECRET`; the plaintext exists only in gateway memory.
/// `masked_key` is what may be logged.
#[derive(Debug, Clone, Default)]
pub struct ProviderKey {
    pub id: i64,
    pub provider_id: i64,
    pub label: String,
    pub encrypted_key: String,
    pub masked_key: String,
    pub priority: i64,
    pub enabled: bool,
    pub status: String,
    pub cooldown_until: Option<DateTime<Utc>>,
}

/// The gateway-relevant fields decoded from a plan's `limits` JSON.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PlanLimits {
    credits_per_period: Option<i64>,
    max_daily_turns: Option<i64>,
    top_up_enabled: bool,
}

/// Decodes the gateway-relevant fields from a plan's `limits` JSON.
///
/// All fields are optional; a missing/invalid blob yields the zero value (nil
/// caps = unlimited, top-up disabled). Numbers are read as floats and truncated,
/// matching Go's `*float64` → `int64` conversion.
fn parse_limits(raw: Option<&serde_json::Value>) -> PlanLimits {
    let Some(obj) = raw.and_then(|v| v.as_object()) else {
        return PlanLimits::default();
    };
    PlanLimits {
        credits_per_period: obj
            .get("creditsPerPeriod")
            .and_then(|v| v.as_f64())
            .map(|v| v as i64),
        max_daily_turns: obj
            .get("maxDailyTurns")
            .and_then(|v| v.as_f64())
            .map(|v| v as i64),
        top_up_enabled: obj
            .get("topUpEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// Everything the gateway needs to bill one team member: the org and seat status,
/// the ORG's plan, and both credit tiers (the member's bucket and the shared
/// pool).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrgMemberState {
    pub org_id: i64,
    /// `organizations.status`: active | suspended.
    pub org_status: String,
    /// `organization_members.status`: active | removed.
    pub member_status: String,
    pub member_role: String,
    /// Empty when the team never bought a plan.
    pub sub_status: String,
    pub plan: Plan,
    pub has_plan: bool,
    pub period_end: Option<DateTime<Utc>>,
    pub bucket_quota: i64,
    pub bucket_credits: i64,
    pub pool_total: i64,
    pub pool_used: i64,
    /// What the team BOUGHT for this period (`credit_pools.extra_credits`), on top
    /// of the plan's allowance.
    ///
    /// It is part of the HARD cap, so it has to be read on the request path -- a team
    /// that bought credits and could not spend them would be the worst possible
    /// outcome of this feature.
    pub pool_extra: i64,
}

impl OrgMemberState {
    /// The team's unspent allowance -- the HARD cap on team usage.
    pub fn pool_remaining(&self) -> i64 {
        // Purchased credits count: the plan's allowance is spent first only because
        // `pool_used` is ONE counter across both tiers.
        (self.pool_total + self.pool_extra - self.pool_used).max(0)
    }

    /// How much of the PURCHASED credits is left, which is what an admin needs to see
    /// to decide whether to buy more.
    ///
    /// Spending fills the plan's allowance first, so purchased credits are only
    /// touched once `pool_used` passes `pool_total`.
    pub fn purchased_remaining(&self) -> i64 {
        if self.pool_extra <= 0 {
            return 0;
        }
        let into_extra = (self.pool_used - self.pool_total).max(0);
        (self.pool_extra - into_extra).max(0)
    }

    /// Whether this member may spend the team's credits right now, and why not
    /// when they may not.
    ///
    /// The reason strings are stable so the HTTP layer can map them to a message
    /// without re-deriving the logic.
    pub fn usable(&self, now: DateTime<Utc>) -> (bool, String) {
        if self.org_status != "active" {
            return (false, "team_suspended".into());
        }
        if self.member_status != "active" {
            return (false, "membership_removed".into());
        }
        if !self.has_plan || self.sub_status.is_empty() {
            return (false, "team_no_plan".into());
        }
        if self.sub_status != "active" {
            // e.g. team_past_due, team_canceled
            return (false, format!("team_{}", self.sub_status));
        }
        if self.period_end.is_some_and(|pe| pe < now) {
            return (false, "team_period_ended".into());
        }
        (true, String::new())
    }
}

/// Wraps the connection pool.
#[derive(Debug, Clone)]
pub struct Store {
    pool: MySqlPool,
}

/// Reports whether an error is MySQL's "table doesn't exist" (error 1146), which
/// on the boot path always means "migrations have not been run".
pub fn is_missing_table_err(err: &sqlx::Error) -> bool {
    let msg = err.to_string().to_lowercase();
    msg.contains("doesn't exist") || msg.contains("does not exist") || msg.contains("1146")
}

impl Store {
    /// Connects to MySQL with a pool sized for concurrent gateway traffic and
    /// verifies connectivity.
    ///
    /// `SET time_zone = '+00:00'` on every connection reproduces the Go DSN's
    /// `parseTime=true&loc=UTC`: MySQL `DATETIME` has no zone, so without this the
    /// server's local zone would silently shift every `currentPeriodEnd` and
    /// `cooldownUntil` the gateway compares against `now()`.
    pub async fn open(database_url: &str) -> Result<Self, sqlx::Error> {
        let opts: MySqlConnectOptions = database_url
            .parse::<MySqlConnectOptions>()?
            .timezone(Some("+00:00".to_string()))
            // Statement caching is on by default; keep it explicit because the
            // hot paths re-run the same handful of queries forever.
            .statement_cache_capacity(100)
            .log_statements(tracing::log::LevelFilter::Trace);

        let pool = MySqlPoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .min_connections(MIN_CONNECTIONS)
            .max_lifetime(Some(MAX_LIFETIME))
            .idle_timeout(Some(IDLE_TIMEOUT))
            .test_before_acquire(false)
            .connect_with(opts)
            .await?;

        // Fail fast at boot rather than on the first request.
        sqlx::query("SELECT 1").execute(&pool).await?;
        Ok(Self { pool })
    }

    /// Builds a store around an existing pool (tests).
    pub fn from_pool(pool: MySqlPool) -> Self {
        Self { pool }
    }

    /// Exposes the underlying pool.
    pub fn pool(&self) -> &MySqlPool {
        &self.pool
    }

    /// Closes the pool.
    pub async fn close(&self) {
        self.pool.close().await;
    }

    // --- catalog ------------------------------------------------------------

    /// Returns all `hosted_models` rows with their provider registry row attached.
    ///
    /// A JOIN (not a second lookup per model) keeps the periodic config refresh to
    /// a single round-trip regardless of catalog size -- the whole catalog is then
    /// served from memory, so no request ever pays for this.
    pub async fn load_models(&self) -> Result<Vec<HostedModel>, sqlx::Error> {
        let rows = sqlx::query(
            r#"SELECT
	m.code, m.label, m.provider_id, m.upstreamModelId,
	m.inputPricePer1MCents, m.outputPricePer1MCents, m.creditMultiplier,
	m.outputCreditMultiplier, m.cacheReadCreditMultiplier, m.cacheWriteCreditMultiplier,
	m.allowedPlanCodes, m.contextWindow,
	m.supportsReasoning, m.supportsImage, m.supportsTools, m.enabled,
	p.name, p.label, p.format, p.baseUrl, p.endpointPath, p.authScheme, p.enabled
FROM hosted_models m
JOIN providers p ON p.id = m.provider_id"#,
        )
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let provider_id: i64 = r.try_get::<i32, _>(2)? as i64;
            let context_window: Option<i32> = r.try_get(11)?;
            let allowed: Option<serde_json::Value> = r.try_get(10)?;
            let endpoint_path: Option<String> = r.try_get(20)?;

            out.push(HostedModel {
                code: r.try_get(0)?,
                label: r.try_get(1)?,
                provider_id,
                upstream_model_id: r.try_get(3)?,
                input_price_per_1m_cents: r.try_get::<i32, _>(4)? as i64,
                output_price_per_1m_cents: r.try_get::<i32, _>(5)? as i64,
                credit_multiplier: r.try_get(6)?,
                output_credit_multiplier: r.try_get(7)?,
                cache_read_credit_multiplier: r.try_get(8)?,
                cache_write_credit_multiplier: r.try_get(9)?,
                allowed_plan_codes: json_string_array(allowed.as_ref()),
                // Go keeps the pointer only for a positive value, so a stored 0
                // reads as "unset" rather than a zero-token window.
                context_window: context_window.filter(|v| *v > 0).map(|v| v as i64),
                supports_reasoning: r.try_get(12)?,
                supports_image: r.try_get(13)?,
                supports_tools: r.try_get(14)?,
                enabled: r.try_get(15)?,
                provider: Provider {
                    id: provider_id,
                    name: r.try_get(16)?,
                    label: r.try_get(17)?,
                    format: r.try_get(18)?,
                    base_url: r.try_get(19)?,
                    endpoint_path: endpoint_path.unwrap_or_default(),
                    auth_scheme: r.try_get(21)?,
                    enabled: r.try_get(22)?,
                },
            });
        }
        Ok(out)
    }

    /// Returns the whole `media_models` catalog in display order.
    ///
    /// A MISSING TABLE is not an error to the caller: the gateway must keep
    /// serving chat traffic on a database that predates this migration, so the
    /// caller treats a failure as "no media models configured" rather than
    /// failing its config refresh (which would take the whole gateway down).
    pub async fn load_media_models(&self) -> Result<Vec<MediaModel>, sqlx::Error> {
        let rows = sqlx::query(
            r#"SELECT
	code, label, mediaType, capabilities, backend, family,
	nvcfFunctionId, estimatedSeconds, defaultParams, allowedPlanCodes,
	isDefault, sortOrder, enabled
FROM media_models
ORDER BY mediaType, sortOrder, id"#,
        )
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let caps: Option<serde_json::Value> = r.try_get(3)?;
            let allowed: Option<serde_json::Value> = r.try_get(9)?;
            let defaults: Option<serde_json::Value> = r.try_get(8)?;
            let estimated: Option<i32> = r.try_get(7)?;
            let fn_id: Option<String> = r.try_get(6)?;

            out.push(MediaModel {
                code: r.try_get(0)?,
                label: r.try_get(1)?,
                media_type: r.try_get(2)?,
                capabilities: json_string_array(caps.as_ref()),
                backend: r.try_get(4)?,
                family: r.try_get(5)?,
                nvcf_function_id: fn_id.unwrap_or_default(),
                estimated_seconds: estimated.filter(|v| *v > 0).map(|v| v as i64),
                // Carried through verbatim; only kept when it is valid JSON so a
                // corrupt column can never make the client's response unparseable.
                default_params: defaults.filter(|v| !v.is_null()),
                allowed_plan_codes: json_string_array(allowed.as_ref()),
                is_default: r.try_get(10)?,
                sort_order: r.try_get::<i32, _>(11)? as i64,
                enabled: r.try_get(12)?,
            });
        }
        Ok(out)
    }

    /// Returns the full provider registry, including providers that currently
    /// have no models (the admin health view needs those too).
    pub async fn load_providers(&self) -> Result<Vec<Provider>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, name, label, format, baseUrl, endpointPath, authScheme, enabled \
             FROM providers ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let endpoint_path: Option<String> = r.try_get(5)?;
            out.push(Provider {
                id: r.try_get::<i32, _>(0)? as i64,
                name: r.try_get(1)?,
                label: r.try_get(2)?,
                format: r.try_get(3)?,
                base_url: r.try_get(4)?,
                endpoint_path: endpoint_path.unwrap_or_default(),
                auth_scheme: r.try_get(6)?,
                enabled: r.try_get(7)?,
            });
        }
        Ok(out)
    }

    /// Returns every provider API key, in the order the gateway should try them.
    ///
    /// One query for all providers keeps the periodic config refresh to a fixed
    /// number of round-trips regardless of how many providers exist.
    pub async fn load_provider_keys(&self) -> Result<Vec<ProviderKey>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, provider_id, label, encryptedKey, maskedKey, priority, enabled, status, cooldownUntil \
             FROM provider_api_keys \
             ORDER BY provider_id, priority, id",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let cooldown: Option<NaiveDateTime> = r.try_get(8)?;
            out.push(ProviderKey {
                id: r.try_get::<i32, _>(0)? as i64,
                provider_id: r.try_get::<i32, _>(1)? as i64,
                label: r.try_get(2)?,
                encrypted_key: r.try_get(3)?,
                masked_key: r.try_get(4)?,
                priority: r.try_get::<i32, _>(5)? as i64,
                enabled: r.try_get(6)?,
                status: r.try_get(7)?,
                cooldown_until: cooldown.map(|t| t.and_utc()),
            });
        }
        Ok(out)
    }

    /// Returns the singleton `app_settings` row (id=1), or Go's defaults when the
    /// row is absent.
    pub async fn load_settings(&self) -> Result<AppSettings, sqlx::Error> {
        let row = sqlx::query(
            "SELECT baselineCreditsPer1M,maxConcurrentStreams,maxTokensPerRequest,\
             maxRequestsPer5h,creditsPerDollar,minTopupCents FROM app_settings WHERE id=1",
        )
        .fetch_optional(&self.pool)
        .await?;

        let Some(r) = row else {
            // Go returns only these two fields on ErrNoRows; the rest stay zero.
            return Ok(AppSettings {
                baseline_credits_per_1m: 1000,
                max_concurrent_streams: 3,
                max_tokens_per_request: 0,
                max_requests_per_5h: 0,
                credits_per_dollar: 0,
                min_topup_cents: 0,
            });
        };
        Ok(AppSettings {
            baseline_credits_per_1m: r.try_get::<i32, _>(0)? as i64,
            max_concurrent_streams: r.try_get::<i32, _>(1)? as i64,
            max_tokens_per_request: r.try_get::<i32, _>(2)? as i64,
            max_requests_per_5h: r.try_get::<i32, _>(3)? as i64,
            credits_per_dollar: r.try_get::<i32, _>(4)? as i64,
            min_topup_cents: r.try_get::<i32, _>(5)? as i64,
        })
    }

    // --- per-user -----------------------------------------------------------

    /// Returns the user's status (`active`/`suspended`/`banned`), or an empty
    /// string when the user does not exist.
    pub async fn user_status(&self, user_id: i64) -> Result<String, sqlx::Error> {
        let row = sqlx::query("SELECT status FROM users WHERE id=?")
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(r) => r.try_get(0),
            None => Ok(String::new()),
        }
    }

    /// Loads a single plan by its code.
    pub async fn plan_by_code(&self, code: &str) -> Result<Option<Plan>, sqlx::Error> {
        let row = sqlx::query("SELECT id,code,name,priceCents,limits FROM plans WHERE code=?")
            .bind(code)
            .fetch_optional(&self.pool)
            .await?;
        let Some(r) = row else { return Ok(None) };
        let limits: Option<serde_json::Value> = r.try_get(4)?;
        let lim = parse_limits(limits.as_ref());
        Ok(Some(Plan {
            id: r.try_get::<i32, _>(0)? as i64,
            code: r.try_get(1)?,
            name: r.try_get(2)?,
            price_cents: r.try_get::<i32, _>(3)? as i64,
            credits_per_period: lim.credits_per_period,
            top_up_enabled: lim.top_up_enabled,
            max_daily_turns: lim.max_daily_turns,
        }))
    }

    /// Returns the user's active, non-expired plan plus the period end, falling
    /// back to the free plan (period end `None`) when there is no active
    /// subscription or it has expired.
    pub async fn active_plan(
        &self,
        user_id: i64,
        now: DateTime<Utc>,
    ) -> Result<(Option<Plan>, Option<DateTime<Utc>>), sqlx::Error> {
        let row = sqlx::query(
            "SELECT p.id,p.code,p.name,p.priceCents,p.limits,s.currentPeriodEnd \
             FROM subscriptions s JOIN plans p ON p.id=s.plan_id \
             WHERE s.user_id=? AND s.status='active' ORDER BY s.startedAt DESC LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(r) = row else {
            let free = self.plan_by_code("free").await?;
            return Ok((free, None));
        };

        let period_end: Option<NaiveDateTime> = r.try_get(5)?;
        let period_end = period_end.map(|t| t.and_utc());

        // Period expiry: a paid period that has lapsed reverts to free.
        if period_end.is_some_and(|pe| pe < now) {
            let free = self.plan_by_code("free").await?;
            return Ok((free, None));
        }

        let limits: Option<serde_json::Value> = r.try_get(4)?;
        let lim = parse_limits(limits.as_ref());
        Ok((
            Some(Plan {
                id: r.try_get::<i32, _>(0)? as i64,
                code: r.try_get(1)?,
                name: r.try_get(2)?,
                price_cents: r.try_get::<i32, _>(3)? as i64,
                credits_per_period: lim.credits_per_period,
                top_up_enabled: lim.top_up_enabled,
                max_daily_turns: lim.max_daily_turns,
            }),
            period_end,
        ))
    }

    /// Returns remaining pay-as-you-go credits: granted (paid topups) minus
    /// consumed (ledger rows with `source='topup'`). Never negative.
    ///
    /// `SUM()` is DECIMAL in MySQL, so both aggregates are CAST to SIGNED --
    /// Go's `sql.NullInt64` performs that conversion implicitly, sqlx does not.
    pub async fn topup_balance(&self, user_id: i64) -> Result<i64, sqlx::Error> {
        let granted: i64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(credits),0) AS SIGNED) FROM credit_topups \
             WHERE user_id=? AND status='paid'",
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        let consumed: i64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(credits),0) AS SIGNED) FROM credit_ledger \
             WHERE user_id=? AND source='topup'",
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        Ok((granted - consumed).max(0))
    }

    // --- writes -------------------------------------------------------------

    /// Persists what the gateway observed about a key (health, cooldown, last
    /// use).
    ///
    /// Called from the bounded write queue, never on the request path -- a
    /// health write must not add latency to a completion.
    pub async fn update_provider_key_state(
        &self,
        key_id: i64,
        status: &str,
        cooldown_until: Option<DateTime<Utc>>,
        last_error: &str,
        used_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE provider_api_keys \
                SET status = ?, cooldownUntil = ?, lastError = ?, lastUsedAt = ?, updatedAt = NOW(3) \
              WHERE id = ?",
        )
        .bind(status)
        .bind(cooldown_until.map(|t| t.naive_utc()))
        // Go passes an untyped nil for an empty message, which MySQL stores as NULL.
        .bind(if last_error.is_empty() {
            None
        } else {
            Some(last_error)
        })
        .bind(used_at.naive_utc())
        .bind(key_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Records a tracking row for a BYO-key request routed through the gateway
    /// proxy and bumps the user's `lastActiveAt`.
    ///
    /// Mirrors the backend's `/usage` endpoint but is written server-side so it
    /// cannot be skipped by the client. No credits are charged on this path.
    /// `model` may be empty (stored as NULL).
    pub async fn insert_usage_event(
        &self,
        user_id: i64,
        provider: &str,
        model: &str,
        source: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO usage_events (user_id, provider, model, source) VALUES (?,?,?,?)")
            .bind(user_id)
            .bind(provider)
            .bind(if model.is_empty() { None } else { Some(model) })
            .bind(source)
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE users SET lastActiveAt=NOW(3) WHERE id=?")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Writes a durable credit-consumption row (`source` = `"plan"`|`"topup"`).
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_ledger(
        &self,
        user_id: i64,
        model_code: &str,
        in_tok: i64,
        out_tok: i64,
        credits_consumed: i64,
        real_cost_cents: i64,
        source: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO credit_ledger \
             (user_id, modelCode, inTokens, outTokens, credits, realCostCents, source, createdAt) \
             VALUES (?,?,?,?,?,?,?,NOW())",
        )
        .bind(user_id)
        .bind(model_code)
        .bind(in_tok)
        .bind(out_tok)
        .bind(credits_consumed)
        .bind(real_cost_cents)
        .bind(source)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // --- teams --------------------------------------------------------------

    /// Loads a team member's billing state.
    ///
    /// Returns `None` when the user holds no seat in that org -- a stale org claim
    /// then falls back to individual billing rather than failing the request.
    ///
    /// One round trip: LEFT JOINs keep a team that has not paid yet resolvable (it
    /// comes back with `has_plan = false`) instead of looking like a missing
    /// membership.
    pub async fn org_member_state(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<Option<OrgMemberState>, sqlx::Error> {
        let row = sqlx::query(
            r#"SELECT
	o.status, m.status, m.role, m.bucket_quota, m.bucket_credits,
	s.status, s.currentPeriodEnd,
	p.id, p.code, p.name, p.priceCents, p.limits,
	cp.total_credits, cp.used_credits, cp.extra_credits
FROM organization_members m
JOIN organizations o ON o.id = m.organization_id
LEFT JOIN organization_subscriptions s ON s.organization_id = m.organization_id
LEFT JOIN plans p ON p.id = s.plan_id
LEFT JOIN credit_pools cp ON cp.organization_id = m.organization_id
WHERE m.organization_id = ? AND m.user_id = ?"#,
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(r) = row else { return Ok(None) };

        let sub_status: Option<String> = r.try_get(5)?;
        let period_end: Option<NaiveDateTime> = r.try_get(6)?;
        let plan_id: Option<i32> = r.try_get(7)?;
        let plan_code: Option<String> = r.try_get(8)?;
        let plan_name: Option<String> = r.try_get(9)?;
        let plan_price: Option<i32> = r.try_get(10)?;
        let plan_limits: Option<serde_json::Value> = r.try_get(11)?;
        let pool_total: Option<i32> = r.try_get(12)?;
        let pool_used: Option<i32> = r.try_get(13)?;
        let pool_extra: Option<i32> = r.try_get(14)?;

        let mut st = OrgMemberState {
            org_id,
            org_status: r.try_get(0)?,
            member_status: r.try_get(1)?,
            member_role: r.try_get(2)?,
            sub_status: sub_status.unwrap_or_default(),
            period_end: period_end.map(|t| t.and_utc()),
            bucket_quota: r.try_get::<i32, _>(3)? as i64,
            bucket_credits: r.try_get::<i32, _>(4)? as i64,
            pool_total: pool_total.unwrap_or(0) as i64,
            pool_used: pool_used.unwrap_or(0) as i64,
            pool_extra: pool_extra.unwrap_or(0) as i64,
            ..Default::default()
        };

        if let (Some(id), Some(code)) = (plan_id, plan_code) {
            let lim = parse_limits(plan_limits.as_ref());
            st.has_plan = true;
            st.plan = Plan {
                id: id as i64,
                code,
                name: plan_name.unwrap_or_default(),
                price_cents: plan_price.unwrap_or(0) as i64,
                credits_per_period: lim.credits_per_period,
                top_up_enabled: lim.top_up_enabled,
                max_daily_turns: lim.max_daily_turns,
            };
        }
        Ok(Some(st))
    }

    /// Persists one settled team charge: the member's bucket goes down (floored at
    /// 0 -- an overflow was served by the pool, not by a negative bucket) and the
    /// pool's used counter goes up.
    ///
    /// Both in ONE transaction, because a bucket debit without the matching pool
    /// debit would let the team exceed its cap.
    pub async fn debit_org_member(
        &self,
        org_id: i64,
        user_id: i64,
        credits_consumed: i64,
    ) -> Result<(), sqlx::Error> {
        if credits_consumed <= 0 {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE organization_members \
                SET bucket_credits = GREATEST(0, bucket_credits - ?), updatedAt = NOW(3) \
              WHERE organization_id = ? AND user_id = ?",
        )
        .bind(credits_consumed)
        .bind(org_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE credit_pools \
                SET used_credits = used_credits + ?, updatedAt = NOW(3) \
              WHERE organization_id = ?",
        )
        .bind(credits_consumed)
        .bind(org_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }

    /// Writes a team consumption row: attributed to the ORG and to the MEMBER who
    /// spent it.
    ///
    /// `user_id` is still written (equal to `member_user_id`) so the member's
    /// personal credit history keeps working with no query change, and
    /// `organization_id` is what makes the team's own reporting possible.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_org_ledger(
        &self,
        org_id: i64,
        member_user_id: i64,
        model_code: &str,
        in_tok: i64,
        out_tok: i64,
        credits_consumed: i64,
        real_cost_cents: i64,
        source: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO credit_ledger \
               (user_id, organization_id, member_user_id, modelCode, inTokens, outTokens, \
                credits, realCostCents, source, createdAt) \
             VALUES (?,?,?,?,?,?,?,?,?,NOW())",
        )
        .bind(member_user_id)
        .bind(org_id)
        .bind(member_user_id)
        .bind(model_code)
        .bind(in_tok)
        .bind(out_tok)
        .bind(credits_consumed)
        .bind(real_cost_cents)
        .bind(source)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Decodes a JSON array of strings, tolerating null/absent/non-array values the
/// way Go's `json.Unmarshal` into a `[]string` does (leaving it empty).
fn json_string_array(raw: Option<&serde_json::Value>) -> Vec<String> {
    raw.and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_limits_reads_the_gateway_fields() {
        let raw = json!({
            "creditsPerPeriod": 500,
            "maxDailyTurns": 40,
            "topUpEnabled": true,
            "somethingElse": "ignored"
        });
        let lim = parse_limits(Some(&raw));
        assert_eq!(lim.credits_per_period, Some(500));
        assert_eq!(lim.max_daily_turns, Some(40));
        assert!(lim.top_up_enabled);
    }

    #[test]
    fn parse_limits_tolerates_missing_and_invalid_blobs() {
        assert_eq!(parse_limits(None), PlanLimits::default());
        assert_eq!(
            parse_limits(Some(&serde_json::Value::Null)),
            PlanLimits::default()
        );
        assert_eq!(
            parse_limits(Some(&json!("not an object"))),
            PlanLimits::default()
        );
        // Absent caps mean unlimited, not zero.
        let lim = parse_limits(Some(&json!({"topUpEnabled": false})));
        assert_eq!(lim.credits_per_period, None);
        assert_eq!(lim.max_daily_turns, None);
    }

    #[test]
    fn parse_limits_truncates_floats_like_go() {
        // Go decodes into *float64 then converts with int64(...), which truncates.
        let lim = parse_limits(Some(&json!({"creditsPerPeriod": 500.9})));
        assert_eq!(lim.credits_per_period, Some(500));
    }

    #[test]
    fn json_string_array_tolerates_junk() {
        assert_eq!(json_string_array(None), Vec::<String>::new());
        assert_eq!(
            json_string_array(Some(&json!(["pro", "max"]))),
            vec!["pro".to_string(), "max".to_string()]
        );
        // Non-string entries are skipped rather than failing the whole row.
        assert_eq!(
            json_string_array(Some(&json!(["pro", 7, null]))),
            vec!["pro".to_string()]
        );
        assert_eq!(json_string_array(Some(&json!({}))), Vec::<String>::new());
    }

    #[test]
    fn app_settings_defaults_match_go_no_row_case() {
        let d = AppSettings::default();
        assert_eq!(d.baseline_credits_per_1m, 1000);
        assert_eq!(d.max_concurrent_streams, 3);
        assert_eq!(d.max_tokens_per_request, 0);
        assert_eq!(d.credits_per_dollar, 0);
    }

    #[test]
    fn pool_remaining_never_goes_negative() {
        let st = OrgMemberState {
            pool_total: 100,
            pool_used: 250,
            ..Default::default()
        };
        assert_eq!(st.pool_remaining(), 0);
        let st = OrgMemberState {
            pool_total: 100,
            pool_used: 40,
            ..Default::default()
        };
        assert_eq!(st.pool_remaining(), 60);
    }

    /// The reason strings are a contract with the HTTP layer.
    #[test]
    fn usable_reason_strings() {
        let now = Utc::now();
        let base = OrgMemberState {
            org_status: "active".into(),
            member_status: "active".into(),
            sub_status: "active".into(),
            has_plan: true,
            ..Default::default()
        };

        assert_eq!(base.usable(now), (true, String::new()));

        let suspended = OrgMemberState {
            org_status: "suspended".into(),
            ..base.clone()
        };
        assert_eq!(suspended.usable(now).1, "team_suspended");

        let removed = OrgMemberState {
            member_status: "removed".into(),
            ..base.clone()
        };
        assert_eq!(removed.usable(now).1, "membership_removed");

        let no_plan = OrgMemberState {
            has_plan: false,
            ..base.clone()
        };
        assert_eq!(no_plan.usable(now).1, "team_no_plan");

        let no_sub = OrgMemberState {
            sub_status: String::new(),
            ..base.clone()
        };
        assert_eq!(no_sub.usable(now).1, "team_no_plan");

        let past_due = OrgMemberState {
            sub_status: "past_due".into(),
            ..base.clone()
        };
        assert_eq!(past_due.usable(now).1, "team_past_due");

        let canceled = OrgMemberState {
            sub_status: "canceled".into(),
            ..base.clone()
        };
        assert_eq!(canceled.usable(now).1, "team_canceled");

        let lapsed = OrgMemberState {
            period_end: Some(now - chrono::Duration::hours(1)),
            ..base.clone()
        };
        assert_eq!(lapsed.usable(now).1, "team_period_ended");

        // A future period end is fine.
        let future = OrgMemberState {
            period_end: Some(now + chrono::Duration::hours(1)),
            ..base
        };
        assert!(future.usable(now).0);
    }

    #[test]
    fn missing_table_error_is_recognised() {
        // The message shape MySQL returns for error 1146.
        let err = sqlx::Error::Protocol(
            "error returned from database: 1146 (42S02): Table 'rayu.providers' doesn't exist"
                .into(),
        );
        assert!(is_missing_table_err(&err));
        let other = sqlx::Error::Protocol("connection reset".into());
        assert!(!is_missing_table_err(&other));
    }
}
