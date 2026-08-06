//! The shared hosted-request preamble: entitlement, model lookup, provider route,
//! capability gate, provider key, daily-turn cap, and the credit reserve -- plus the
//! settle path that reconciles credits to actual usage and records the ledger.
//!
//! Port of `hostedReserve` / `reserveHosted` / `setCreditHeaders` / `actualBillable`
//! and friends from the Go gateway's `internal/server/server.go`.
//!
//! Ordering here is a billing contract, not a style choice: every cheap refusal
//! (entitlement, model, provider config, adapter, max_tokens, capabilities, keys)
//! happens BEFORE a turn or a credit is reserved, so a misconfiguration can never
//! cost a user anything.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::response::Response;
use http::{HeaderMap, StatusCode};
use rayu_core::eventqueue::Item;
use rayu_core::httpx;
use rayu_core::jwt::Claims;
use rayu_core::store::{AppSettings, HostedModel, OrgMemberState, Plan};
use serde_json::Value;

use crate::adapters::{self, Adapter};
use crate::capabilities::{request_has_image, request_wants_thinking};
use crate::credits::{self, ModelRates};
use crate::limiter::{self, ReserveParams, UNLIMITED};
use crate::providercfg::Route;
use crate::reservedenial::write_reserve_denial;
use crate::state::{entitlement_error_response, status_or_unknown, AppState};
use crate::upstream::{ApiKey, KeyFailure, Usage};

/// The estimate fallback when `max_tokens` is unset.
pub const DEFAULT_MAX_TOKENS: i64 = 2048;

/// Mints a gateway-assigned correlation id, used when the client did NOT send
/// `X-Rayu-Request-Id` (an older CLI build).
///
/// The `gw_` prefix makes it obvious the id came from the gateway (so a missing client
/// id is visible), while still giving every request a single id that ties its
/// start/done/response lines together in the gateway log.
pub fn new_req_id() -> String {
    let mut b = [0u8; 12];
    rand::Rng::fill(&mut rand::thread_rng(), &mut b[..]);
    format!("gw_{}", hex::encode(b))
}

/// Pulls the CLI correlation/attribution headers off a hosted request.
///
/// `source` is the KEY field for diagnosing "why did model X get called" -- it names
/// the CLI feature (repl_main_thread, agent:*, tool summary, compact, webfetch, quota
/// probe, ...) that issued the request. When the client is an older build that does
/// not send these, `req_id` is gateway-assigned and `source` is `"unknown"` (which
/// itself signals "old CLI, please update").
pub fn hosted_identity(headers: &HeaderMap) -> (String, String, String) {
    let (raw_id, raw_source, intended) = crate::routes::meta::hosted_identity(headers);
    let req_id = if raw_id.is_empty() {
        new_req_id()
    } else {
        raw_id
    };
    let source = if raw_source.is_empty() {
        "unknown".to_string()
    } else {
        raw_source
    };
    (req_id, source, intended)
}

/// Reconciles the pre-flight hold to actual usage exactly once, then records the
/// durable ledger row.
///
/// This is Go's `settle` closure. It is an `Arc`-shared struct rather than a closure
/// because the streaming path settles from a DETACHED pump task after the handler has
/// already returned -- which is precisely what makes billing survive a client hang-up.
pub struct Settler {
    st: Arc<AppState>,
    user_id: i64,
    /// `Some(org_id)` for a TEAM charge: settlement then moves the org's counters and
    /// writes an org-scoped ledger row instead of the personal ones.
    org_id: Option<i64>,
    req_id: String,
    source: String,
    credit_source: String,
    est_billable: i64,
    tokens_per_credit: i64,
    rates: ModelRates,
    hm: HostedModel,
    settled: AtomicBool,
}

impl Settler {
    /// Settles the request and returns the actual billable-token charge.
    ///
    /// Idempotent: a second call is a no-op returning the same arithmetic, because a
    /// double settle would refund or charge twice.
    pub async fn settle(&self, usage: Option<&Usage>) -> i64 {
        let actual = actual_billable(usage, &self.rates);
        if self.settled.swap(true, Ordering::SeqCst) {
            return actual;
        }
        if let Some(lim) = self.st.lim.as_ref() {
            // A team charge moves the org's bucket + pool counters, not the member's
            // personal period counter.
            let outcome = match self.org_id {
                Some(org_id) => {
                    lim.settle_org(org_id, self.user_id, self.est_billable, actual)
                        .await
                }
                None => {
                    lim.settle(self.user_id, &self.credit_source, self.est_billable, actual)
                        .await
                }
            };
            if let Err(e) = outcome {
                // A failed settle leaves the pre-flight hold in place, which
                // over-charges until the period resets. It must be visible.
                tracing::error!(
                    "settle failed: user={} reqid={} model={} est={} actual={}: {e}",
                    self.user_id,
                    self.req_id,
                    self.hm.code,
                    self.est_billable,
                    actual
                );
            }
        }
        // Drop the cached team state so the next request sees this spend (the durable
        // write below is what it will re-read).
        if let (Some(org_id), Some(orgs)) = (self.org_id, self.st.orgs.as_ref()) {
            orgs.invalidate(org_id, self.user_id);
        }
        self.st.ent.invalidate(self.user_id);

        match usage {
            Some(u) => {
                tracing::info!(
                    "hosted done: user={} reqid={} source={} model={} billable={actual} \
                     (~{:.4} credits, est {}) via={} tokens(total={} prompt={} completion={} \
                     reasoning={} cacheHit={} cacheMiss={})",
                    self.user_id,
                    self.req_id,
                    self.source,
                    self.hm.code,
                    actual as f64 / self.tokens_per_credit as f64,
                    self.est_billable,
                    self.credit_source,
                    u.total_tokens,
                    u.prompt_tokens,
                    u.completion_tokens,
                    u.completion_tokens_details.reasoning_tokens,
                    u.prompt_cache_hit_tokens,
                    u.prompt_cache_miss_tokens,
                );
                self.record_ledger(
                    u,
                    credits::credits_from_billable(actual, self.tokens_per_credit),
                );
            }
            None => {
                tracing::info!(
                    "hosted done: user={} reqid={} source={} model={} billable={actual} \
                     (est {}) via={} (no usage reported)",
                    self.user_id,
                    self.req_id,
                    self.source,
                    self.hm.code,
                    self.est_billable,
                    self.credit_source,
                );
            }
        }
        actual
    }

    /// Settles from a synchronous context (the stream pump's `on_done`).
    ///
    /// The settle itself is async (Redis + the ledger enqueue), so it is spawned; the
    /// pump must not be blocked, and the response has already been fully written.
    pub fn settle_detached(self: Arc<Self>, usage: Option<Usage>) {
        tokio::spawn(async move {
            self.settle(usage.as_ref()).await;
        });
    }

    /// Writes the durable consumption row through the bounded write queue, so a
    /// database stall can never sit on the request path.
    fn record_ledger(&self, u: &Usage, credits_consumed: i64) {
        let Some(store) = self.st.store.clone() else {
            return;
        };
        let real_cost = real_cost_cents_for(&self.hm, u, &self.rates);
        let user_id = self.user_id;
        let code = self.hm.code.clone();
        let source = self.credit_source.clone();
        let (prompt, completion) = (u.prompt_tokens, u.completion_tokens);

        // A TEAM charge persists the durable bucket + pool debit AND an org-scoped
        // ledger row naming the member who spent it.
        if let Some(org_id) = self.org_id {
            self.st.wq.enqueue(Item::new("record_team_usage", move || {
                let store = store.clone();
                let code = code.clone();
                let source = source.clone();
                async move {
                    // Ledger FIRST: it is the audit trail, and a lost debit is
                    // recoverable from it, while a debit with no ledger row is not
                    // explainable.
                    store
                        .insert_org_ledger(
                            org_id,
                            user_id,
                            &code,
                            prompt,
                            completion,
                            credits_consumed,
                            real_cost,
                            &source,
                        )
                        .await?;
                    store
                        .debit_org_member(org_id, user_id, credits_consumed)
                        .await
                        .map_err(Into::into)
                }
            }));
            return;
        }

        self.st.wq.enqueue(Item::new("record_ledger", move || {
            let store = store.clone();
            let code = code.clone();
            let source = source.clone();
            async move {
                store
                    .insert_ledger(
                        user_id,
                        &code,
                        prompt,
                        completion,
                        credits_consumed,
                        real_cost,
                        &source,
                    )
                    .await
                    .map_err(Into::into)
            }
        }));
    }
}

/// Everything the shared preamble produced for a hosted request.
pub struct HostedReserve {
    pub user_id: i64,
    /// `X-Rayu-Request-Id` (edge/gateway correlation).
    pub req_id: String,
    /// `X-Rayu-Query-Source` (which CLI feature issued this).
    pub source: String,
    /// `X-Rayu-Intended-Model` (what the CLI meant to send).
    pub intended: String,
    pub req: Value,
    pub hm: HostedModel,
    /// The resolved provider route (URL, auth, keys).
    pub route: Route,
    /// The wire-format adapter for that provider.
    pub adapter: &'static dyn Adapter,
    /// The provider keys usable right now, in try order. Each carries its id so a
    /// failure can be attributed to that key.
    pub api_keys: Vec<ApiKey>,
    /// The pre-flight billable-token reservation.
    pub est_billable: i64,
    /// Billable tokens used this period (from the limiter).
    pub used_period: i64,
    /// The billable-token allowance, or [`UNLIMITED`].
    pub cap_period: i64,
    pub topup_bal: i64,
    /// Billable tokens per credit (for display and headers).
    pub tokens_per_credit: i64,
    pub settler: Arc<Settler>,
}

/// Runs the shared hosted-request preamble.
///
/// `Ok` means the request may proceed; `Err` carries the response to return, already
/// logged. This is the Rust shape of Go's `(hr, ok)` plus a pre-written error.
pub async fn reserve_hosted(
    st: &Arc<AppState>,
    claims: &Claims,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<HostedReserve, Response> {
    let (req_id, source, intended) = hosted_identity(headers);

    let ent = match st.ent.resolve(claims.user_id).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                "hosted reject: user={} reqid={req_id} source={source} \
                 reason=entitlement_error: {e}",
                claims.user_id
            );
            return Err(entitlement_error_response(&e));
        }
    };
    if !ent.active() {
        let status = status_or_unknown(&ent.status);
        tracing::info!(
            "hosted reject: user={} reqid={req_id} source={source} reason=account_{status}",
            claims.user_id
        );
        return Err(httpx::write_error(
            StatusCode::FORBIDDEN,
            &format!("account is {status}"),
        ));
    }

    // --- Team context -------------------------------------------------------
    // An `orgId` claim means this request should be billed to a TEAM: the org's plan
    // decides which models are allowed and how many credits exist, and the charge is
    // split between the member's per-seat bucket and the shared pool.
    //
    // EVERY failure mode here FALLS BACK to individual billing rather than rejecting:
    // a claim can be up to a token-lifetime stale (member removed, team suspended,
    // plan lapsed), and in all of those cases the person really is an individual user
    // again -- so their own subscription is the correct answer, not an error. The
    // reason is logged so an operator can see it happening.
    let mut plan: Plan = ent.plan.clone();
    let mut period_end = ent.period_end;
    let mut allowed_models = ent.allowed_models.clone();
    let mut org: Option<OrgMemberState> = None;

    if claims.org_id > 0 {
        if let Some(orgs) = st.orgs.as_ref() {
            match orgs.resolve(claims.org_id, claims.user_id).await {
                Err(e) => tracing::warn!(
                    "team: user={} org={} reqid={req_id} team lookup failed,                      billing individually: {e}",
                    claims.user_id,
                    claims.org_id
                ),
                Ok(None) => tracing::info!(
                    "team: user={} org={} reqid={req_id} no seat found (stale claim),                      billing individually",
                    claims.user_id,
                    claims.org_id
                ),
                Ok(Some(state)) => {
                    let (ok, reason) = state.usable(chrono::Utc::now());
                    if ok {
                        plan = state.plan.clone();
                        period_end = state.period_end;
                        // Model access follows the TEAM's plan. Recomputed from the
                        // live catalog snapshot (the same helper the user cache uses),
                        // so a catalog change reaches team members too.
                        allowed_models =
                            crate::entitlements::allowed_models(&st.ent.models(), &plan.code);
                        org = Some(state);
                    } else {
                        tracing::info!(
                            "team: user={} org={} reqid={req_id} not billable ({reason}),                              billing individually",
                            claims.user_id,
                            claims.org_id
                        );
                    }
                }
            }
        }
    }

    if body.len() > crate::state::MAX_REQUEST_BYTES {
        tracing::info!(
            "hosted reject: user={} reqid={req_id} source={source} reason=body_too_large",
            claims.user_id
        );
        return Err(httpx::write_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body too large",
        ));
    }
    let Ok(req) = serde_json::from_slice::<Value>(body) else {
        tracing::info!(
            "hosted reject: user={} reqid={req_id} source={source} reason=invalid_json",
            claims.user_id
        );
        return Err(httpx::write_error(
            StatusCode::BAD_REQUEST,
            "invalid JSON body",
        ));
    };

    let model_code = req.get("model").and_then(|m| m.as_str()).unwrap_or("");
    let Some(hm) = allowed_models
        .iter()
        .find(|m| m.code == model_code)
        .cloned()
    else {
        tracing::info!(
            "reject: user={} reqid={req_id} source={source} model={model_code:?} \
             intended={intended:?} not allowed for plan={}; allowed=[{}]",
            claims.user_id,
            plan.code,
            allowed_model_codes(&allowed_models)
        );
        return Err(httpx::write_error(
            StatusCode::FORBIDDEN,
            &format!("model not available on your plan: {model_code}"),
        ));
    };

    // --- Provider registry resolution ---------------------------------------
    // The provider row decides the wire format, URL and auth scheme. Everything here
    // happens BEFORE the daily-turn count and the credit reserve, so a misconfigured
    // or disabled provider never charges a user or burns a turn. Errors are
    // deliberately vague to the CLI (they are operator problems, and the detail can
    // name internal hosts) but precise in the log.
    let unavailable = || {
        httpx::write_error(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("model temporarily unavailable: {}", hm.code),
        )
    };
    let Some(pr) = st.ent.route(hm.provider_id) else {
        tracing::error!(
            "reject: user={} reqid={req_id} source={source} model={model_code:?} \
             provider_id={} reason=provider_not_in_registry",
            claims.user_id,
            hm.provider_id
        );
        return Err(unavailable());
    };
    // A row that fails validation is REFUSED, never silently repaired: the gateway
    // would otherwise attach a provider key to a URL nobody configured (SSRF + key
    // exfiltration). Re-checked here (not just in the backend) so a row written
    // directly to the database is caught too.
    if let Some(err) = pr.err.as_ref() {
        tracing::error!(
            "reject: user={} reqid={req_id} source={source} model={model_code:?} \
             provider={:?} reason=provider_config_invalid: {err}",
            claims.user_id,
            pr.route.name
        );
        return Err(unavailable());
    }
    // Admin kill switch.
    if !pr.route.enabled {
        tracing::warn!(
            "reject: user={} reqid={req_id} source={source} model={model_code:?} \
             provider={:?} is disabled",
            claims.user_id,
            pr.route.name
        );
        return Err(unavailable());
    }
    // The provider's wire format must have an adapter in THIS build. Checked here,
    // before any turn or credit is reserved, because a format this gateway cannot
    // speak is an operator/deploy problem and must never cost the user anything.
    let adapter = match adapters::adapter_for(&pr.route.format) {
        Ok(a) => a,
        Err(e) => {
            tracing::error!(
                "reject: user={} reqid={req_id} source={source} model={model_code:?} \
                 provider={:?} reason=unsupported_format: {e} (this build serves: {:?})",
                claims.user_id,
                pr.route.name,
                adapters::formats()
            );
            return Err(unavailable());
        }
    };

    let settings = st.ent.settings();
    if settings.max_tokens_per_request > 0 {
        if let Some(mt) = req.get("max_tokens").and_then(|v| v.as_f64()) {
            if mt as i64 > settings.max_tokens_per_request {
                tracing::info!(
                    "reject: user={} reqid={req_id} source={source} model={model_code:?} \
                     reason=max_tokens_exceeded ({}>{})",
                    claims.user_id,
                    mt as i64,
                    settings.max_tokens_per_request
                );
                return Err(httpx::write_error(
                    StatusCode::BAD_REQUEST,
                    "max_tokens exceeds the per-request limit",
                ));
            }
        }
    }

    // --- Per-model capability gate ------------------------------------------
    // Refuse content the selected model cannot handle BEFORE reserving a turn or
    // credits, and say so with a stable machine code so the CLI can warn the user and
    // offer to switch models.
    if !hm.supports_image && request_has_image(&req) {
        tracing::info!(
            "reject: user={} reqid={req_id} source={source} model={model_code:?} \
             reason=no_image_support",
            claims.user_id
        );
        return Err(httpx::write_capability_error(
            httpx::CODE_NO_IMAGE_SUPPORT,
            &format!(
                "Model \"{}\" cannot read images. Switch to a model with image support, \
                 or remove the image from your message.",
                hm.code
            ),
        ));
    }
    if !hm.supports_reasoning && request_wants_thinking(&req) {
        tracing::info!(
            "reject: user={} reqid={req_id} source={source} model={model_code:?} \
             reason=no_thinking_support",
            claims.user_id
        );
        return Err(httpx::write_capability_error(
            httpx::CODE_NO_THINKING_SUPPORT,
            &format!(
                "Model \"{}\" does not support extended thinking. Switch to a \
                 reasoning-capable model, or disable thinking for this request.",
                hm.code
            ),
        ));
    }

    // Which keys may serve this request right now: disabled, invalid and still-cooling
    // keys are already excluded, in priority order. No DB read and no decryption
    // happens here -- the registry holds decrypted keys in memory.
    let keys = st.ent.keys();
    let picked = keys.pick(hm.provider_id);
    if picked.is_empty() {
        // Distinguish "never configured" from "all keys are temporarily unusable": the
        // first is an admin task, the second resolves itself.
        let total = keys.snapshot_for(hm.provider_id).len();
        if total == 0 {
            tracing::error!(
                "reject: user={} reqid={req_id} source={source} model={model_code:?} \
                 provider={:?} reason=no_api_key_configured",
                claims.user_id,
                pr.route.name
            );
            return Err(httpx::write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "provider key not configured",
            ));
        }
        tracing::warn!(
            "reject: user={} reqid={req_id} source={source} model={model_code:?} \
             provider={:?} reason=all_keys_unusable ({total} configured: rate-limited or invalid)",
            claims.user_id,
            pr.route.name
        );
        let mut resp = unavailable();
        resp.headers_mut().insert(
            http::header::RETRY_AFTER,
            http::HeaderValue::from_static("60"),
        );
        return Err(resp);
    }

    // Hand the adapter the secret to use plus the id to blame on failure.
    let api_keys: Vec<ApiKey> = picked
        .iter()
        .map(|k| ApiKey {
            id: k.id,
            secret: k.secret.clone(),
        })
        .collect();

    let Some(lim) = st.lim.as_ref() else {
        tracing::error!("hosted reject: user={} reason=no_limiter", claims.user_id);
        return Err(httpx::write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate limiter unavailable",
        ));
    };

    // --- Daily turn cap: a HARD limit on the hosted path --------------------
    // Counted per user per UTC day; None/0 cap = unlimited. Checked before the credit
    // reserve so a denial neither charges credits nor calls upstream.
    let turn_cap = daily_turn_cap(plan.max_daily_turns);
    let tr = match lim.reserve_turn(claims.user_id, turn_cap).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(
                "hosted reject: user={} reason=limiter_unavailable: {e}",
                claims.user_id
            );
            return Err(httpx::write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "rate limiter unavailable",
            ));
        }
    };
    if !tr.ok {
        tracing::info!(
            "reject: user={} reqid={req_id} source={source} model={:?} \
             daily turn limit reached ({}/{turn_cap})",
            claims.user_id,
            hm.code,
            tr.used_today
        );
        let mut resp = httpx::write_json(
            StatusCode::TOO_MANY_REQUESTS,
            &serde_json::json!({
                "error": {"message": "daily turn limit reached", "type": "rate_limit_exceeded"},
                "reason": "daily_turn_limit",
                "resetSeconds": tr.reset_seconds,
            }),
        );
        if tr.reset_seconds > 0 {
            if let Ok(v) = http::HeaderValue::from_str(&tr.reset_seconds.to_string()) {
                resp.headers_mut().insert(http::header::RETRY_AFTER, v);
            }
        }
        return Err(resp);
    }

    // --- Credit reserve (pre-flight) ----------------------------------------
    let tpc = credits::tokens_per_credit(settings.baseline_credits_per_1m);
    // `rates` prices each usage bucket (input/output/cache-read/cache-write)
    // independently for the ACTUAL charge, using the four charges the admin entered --
    // nothing is derived from the cost prices.
    let rates = credits::model_rates_for(
        hm.credit_multiplier,
        hm.output_credit_multiplier,
        hm.cache_read_credit_multiplier,
        hm.cache_write_credit_multiplier,
    );
    // Track usage + allowance in FINE-GRAINED billable tokens (not whole ceil'd
    // credits): a tiny turn then costs its true fraction instead of a full 1M-token
    // credit.
    let cap_billable = match plan.credits_per_period {
        Some(per_period) => per_period * tpc,
        None => UNLIMITED,
    };
    // Pre-flight hold: a rough billable estimate; settle reconciles to actual.
    let est_billable = credits::estimate_billable_tokens(
        credits::estimate_tokens(&req, DEFAULT_MAX_TOKENS),
        hm.credit_multiplier,
    );

    // --- TEAM reserve: member bucket first, shared pool as the hard cap ------
    if let Some(org) = org {
        return reserve_team(
            st,
            claims,
            TeamReserveInput {
                org,
                plan,
                period_end,
                settings,
                hm,
                rates,
                tpc,
                est_billable,
                req_id,
                source,
                intended,
                req,
                route: pr.route,
                adapter,
                api_keys,
            },
        )
        .await;
    }

    let top_up_available = plan.top_up_enabled && ent.topup_balance > 0;
    if top_up_available {
        let _ = lim.ensure_topup(claims.user_id, ent.topup_balance).await;
    }
    let rr = match lim
        .reserve(&ReserveParams {
            user_id: claims.user_id,
            est_credits: est_billable,
            cap_period: cap_billable,
            period_ttl_sec: limiter::period_ttl_seconds(period_end),
            period_id: limiter::period_id(period_end),
            max_concurrent: settings.max_concurrent_streams,
            max_req_5h: settings.max_requests_per_5h,
            top_up_enabled: top_up_available,
        })
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Refund the turn; the request did not proceed.
            release_turn_bg(st, claims.user_id);
            tracing::error!(
                "hosted reject: user={} reqid={req_id} source={source} model={:?} \
                 reason=limiter_unavailable: {e}",
                claims.user_id,
                hm.code
            );
            return Err(httpx::write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "rate limiter unavailable",
            ));
        }
    };
    if !rr.ok {
        // A credit denial must not also burn a daily turn.
        release_turn_bg(st, claims.user_id);
        tracing::info!(
            "reject: user={} reqid={req_id} source={source} model={:?} reason={} reset={}s",
            claims.user_id,
            hm.code,
            rr.reason,
            rr.reset_period
        );
        return Err(write_reserve_denial(&rr.reason, rr.reset_period, "", ""));
    }

    let settler = Arc::new(Settler {
        st: st.clone(),
        user_id: claims.user_id,
        org_id: None,
        req_id: req_id.clone(),
        source: source.clone(),
        credit_source: rr.source,
        est_billable,
        tokens_per_credit: tpc,
        rates,
        hm: hm.clone(),
        settled: AtomicBool::new(false),
    });

    Ok(HostedReserve {
        user_id: claims.user_id,
        req_id,
        source,
        intended,
        req,
        hm,
        route: pr.route,
        adapter,
        api_keys,
        est_billable,
        used_period: rr.used_period,
        cap_period: cap_billable,
        topup_bal: ent.topup_balance,
        tokens_per_credit: tpc,
        settler,
    })
}

/// Everything [`reserve_team`] needs from the shared preamble.
///
/// A struct rather than fifteen positional parameters because every field is already
/// resolved and none of them are optional -- the compiler, not a reader, should be the
/// one keeping the call site in order.
pub struct TeamReserveInput {
    pub org: OrgMemberState,
    pub plan: Plan,
    pub period_end: Option<chrono::DateTime<chrono::Utc>>,
    pub settings: AppSettings,
    pub hm: HostedModel,
    pub rates: ModelRates,
    pub tpc: i64,
    pub est_billable: i64,
    pub req_id: String,
    pub source: String,
    pub intended: String,
    pub req: Value,
    pub route: Route,
    pub adapter: &'static dyn Adapter,
    pub api_keys: Vec<ApiKey>,
}

/// The credit reserve for a TEAM member.
///
/// Two tiers move on every accepted request:
///
/// * the member's per-seat bucket (a SOFT quota -- exceeding it is allowed and just
///   changes the recorded source to `"pool"`), and
/// * the org's shared pool (the HARD cap -- the single number that limits total team
///   usage, which is what makes "unlimited members" safe).
///
/// Both are counted in billable tokens in Redis for atomicity, and both are SEEDED
/// from MySQL on a cold start so a gateway restart cannot re-gift a spent allowance.
/// Settlement reconciles Redis to actuals and writes the durable team debit plus an
/// org-scoped ledger row.
pub async fn reserve_team(
    st: &Arc<AppState>,
    claims: &Claims,
    in_: TeamReserveInput,
) -> Result<HostedReserve, Response> {
    let org = &in_.org;
    let period_ttl = limiter::period_ttl_seconds(in_.period_end);
    let Some(lim) = st.lim.as_ref() else {
        return Err(httpx::write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate limiter unavailable",
        ));
    };

    // The pool cap is the team's TOTAL allowance -- the plan's allowance PLUS any
    // credits the admin bought for this period. Seeding from MySQL (SET NX) makes the
    // durable number authoritative whenever Redis has no counter yet: after a restart,
    // a failover, or the first request of a new period.
    //
    // purchased_cap is how much of that cap was bought. It gates nothing; the limiter
    // subtracts it to know when a charge has crossed out of what the subscription paid
    // for and into what the admin bought.
    let mut pool_cap = UNLIMITED;
    let mut purchased_cap = 0i64;
    if in_.plan.credits_per_period.is_some() {
        pool_cap = (org.pool_total + org.pool_extra) * in_.tpc;
        purchased_cap = org.pool_extra * in_.tpc;
        let _ = lim
            .ensure_org_pool_used(org.org_id, org.pool_used * in_.tpc, period_ttl)
            .await;
    }

    // The bucket cap is the member's quota; used = quota - remaining, per MySQL.
    let bucket_cap = org.bucket_quota * in_.tpc;
    let used_bucket_from_db = ((org.bucket_quota - org.bucket_credits) * in_.tpc).max(0);
    let _ = lim
        .ensure_org_bucket_used(org.org_id, claims.user_id, used_bucket_from_db, period_ttl)
        .await;

    let rr = match lim
        .reserve_org(&limiter::OrgReserveParams {
            org_id: org.org_id,
            user_id: claims.user_id,
            est_billable: in_.est_billable,
            bucket_cap,
            pool_cap,
            purchased_cap,
            period_ttl_sec: period_ttl,
            period_id: limiter::period_id(in_.period_end),
            max_concurrent: in_.settings.max_concurrent_streams,
            max_req_5h: in_.settings.max_requests_per_5h,
        })
        .await
    {
        Ok(r) => r,
        Err(e) => {
            release_turn_bg(st, claims.user_id);
            tracing::error!(
                "hosted reject: user={} org={} reqid={} source={} model={:?} \
                 reason=limiter_unavailable: {e}",
                claims.user_id,
                org.org_id,
                in_.req_id,
                in_.source,
                in_.hm.code
            );
            return Err(httpx::write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "rate limiter unavailable",
            ));
        }
    };
    if !rr.ok {
        // A credit denial must not burn a daily turn.
        release_turn_bg(st, claims.user_id);
        let team_msg = if rr.reason == "pool_limit" {
            // Say whose limit it is and who can fix it -- a member cannot top up a team
            // pool, only the team admin can. Both routes out are named, because buying
            // credits is now the faster of the two.
            "your team's credit pool is exhausted — ask the team admin to buy more \
             credits, or to renew or upgrade the team plan"
        } else {
            ""
        };
        tracing::info!(
            "reject: user={} org={} reqid={} source={} model={:?} reason=team_{} \
             pool={}/{pool_cap} (purchased={purchased_cap}) reset={}s",
            claims.user_id,
            org.org_id,
            in_.req_id,
            in_.source,
            in_.hm.code,
            rr.reason,
            rr.used_pool,
            rr.reset_pool
        );
        return Err(write_reserve_denial(
            &rr.reason,
            rr.reset_pool,
            team_msg,
            "team",
        ));
    }

    // rr.source is "bucket", "pool" or "extra"; all three are team spending, and it is
    // recorded on the ledger so an admin can see who overflowed their quota and how
    // much of the charge came out of purchased credits.
    let settler = Arc::new(Settler {
        st: st.clone(),
        user_id: claims.user_id,
        org_id: Some(org.org_id),
        req_id: in_.req_id.clone(),
        source: in_.source.clone(),
        credit_source: rr.source,
        est_billable: in_.est_billable,
        tokens_per_credit: in_.tpc,
        rates: in_.rates,
        hm: in_.hm.clone(),
        settled: AtomicBool::new(false),
    });

    Ok(HostedReserve {
        user_id: claims.user_id,
        req_id: in_.req_id,
        source: in_.source,
        intended: in_.intended,
        req: in_.req,
        hm: in_.hm,
        route: in_.route,
        adapter: in_.adapter,
        api_keys: in_.api_keys,
        est_billable: in_.est_billable,
        // The credit headers report the TEAM's pool, because that is the allowance
        // actually limiting this request.
        used_period: rr.used_pool,
        cap_period: pool_cap,
        // Top-ups are personal; a team pool has none.
        topup_bal: 0,
        tokens_per_credit: in_.tpc,
        settler,
    })
}

/// Records what an upstream said about a specific API key, so rotation reflects
/// reality instead of retrying a credential that just failed.
///
/// * 429 / 402 -> cooldown. The key is skipped until the window passes; the provider's
///   `Retry-After` is honoured (capped, so a provider cannot remove a key from
///   rotation for an hour).
/// * 401 / 403 -> invalid. The key stays out until an admin replaces it: retrying a
///   rejected credential wastes latency and can trip abuse counters.
///
/// State is updated in memory immediately (so the NEXT request skips the key) and
/// persisted asynchronously, so a health write never sits on the request path.
pub fn record_key_failure(st: &Arc<AppState>, provider_id: i64, f: &KeyFailure) {
    if f.key_id == 0 {
        return;
    }
    let keys = st.ent.keys();
    if f.rate_limited() {
        keys.mark_rate_limited(provider_id, f.key_id, f.retry_after);
        tracing::warn!(
            "provider key #{} rate limited (HTTP {}) — cooling down, rotating to the next key",
            f.key_id,
            f.status
        );
        return;
    }
    keys.mark_invalid(provider_id, f.key_id, &format!("HTTP {}", f.status));
    tracing::warn!(
        "provider key #{} rejected by the upstream (HTTP {}) — taken out of rotation \
         until replaced",
        f.key_id,
        f.status
    );
}

/// Refunds one daily turn out-of-band (the response is already being written, so the
/// request may be finishing).
pub fn release_turn_bg(st: &Arc<AppState>, user_id: i64) {
    let Some(lim) = st.lim.clone() else { return };
    tokio::spawn(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), lim.release_turn(user_id))
            .await;
    });
}

/// Sets the credit headers the CLI renders in its status line.
pub fn set_credit_headers(
    resp: &mut Response,
    used_billable: i64,
    cap_billable: i64,
    tokens_per_credit: i64,
    topup: i64,
) {
    let tpc = if tokens_per_credit <= 0 {
        1
    } else {
        tokens_per_credit
    };
    let h = resp.headers_mut();
    if let Ok(v) = http::HeaderValue::from_str(&(used_billable / tpc).to_string()) {
        h.insert("x-rayu-credits-used", v);
    }
    if cap_billable < 0 {
        h.insert(
            "x-rayu-credits-remaining",
            http::HeaderValue::from_static("unlimited"),
        );
    } else {
        let rem = ((cap_billable - used_billable) / tpc).max(0);
        if let Ok(v) = http::HeaderValue::from_str(&rem.to_string()) {
            h.insert("x-rayu-credits-remaining", v);
        }
    }
    if let Ok(v) = http::HeaderValue::from_str(&topup.to_string()) {
        h.insert("x-rayu-topup-balance", v);
    }
}

/// The settled fine-grained billable-token count for a request's usage (0 for
/// missing/failed usage).
///
/// Fresh input goes to the cache-miss bucket and cache reads to the cache-hit bucket,
/// each priced by its own rate.
pub fn actual_billable(u: Option<&Usage>, rates: &ModelRates) -> i64 {
    let Some(u) = u else { return 0 };
    credits::billable_tokens(
        credits::Usage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            prompt_cache_hit_tokens: u.cache_read_tokens(),
            prompt_cache_miss_tokens: u.fresh_input_tokens(),
            // DeepSeek/DeepInfra do not report a cache-write count today.
            prompt_cache_write_tokens: 0,
        },
        *rates,
    )
}

/// RAYU's own cost for one request (not what the user is charged): fresh input tokens
/// at full price plus cache reads at the discounted fraction, plus completion tokens.
pub fn real_cost_cents_for(m: &HostedModel, u: &Usage, rates: &ModelRates) -> i64 {
    credits::real_cost_cents(
        m.input_price_per_1m_cents,
        m.output_price_per_1m_cents,
        u.fresh_input_tokens(),
        u.cache_read_tokens(),
        u.completion_tokens,
        *rates,
    )
}

/// The remaining credits for a cap, or `None` when unlimited.
pub fn remaining(cap: i64, used: i64) -> Option<i64> {
    if cap < 0 {
        return None;
    }
    Some((cap - used).max(0))
}

/// [`UNLIMITED`] when the plan sets no cap.
pub fn cap_or_unlimited(v: Option<i64>) -> i64 {
    v.unwrap_or(UNLIMITED)
}

/// The per-day turn cap for a plan: 0 (unlimited) when the limit is unset or
/// non-positive, else the configured value.
///
/// Treating 0/negative as unlimited fails OPEN, so an accidental 0 never locks every
/// user out.
pub fn daily_turn_cap(v: Option<i64>) -> i64 {
    match v {
        Some(n) if n > 0 => n,
        _ => 0,
    }
}

/// The model codes a plan allows, for the rejection log line.
pub fn allowed_model_codes(models: &[HostedModel]) -> String {
    models
        .iter()
        .map(|m| m.code.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// A best-effort model name from a raw body, for logging a request that never parsed.
pub fn best_effort_model(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_request_id_is_recognisable_and_unique() {
        let a = new_req_id();
        let b = new_req_id();
        assert!(a.starts_with("gw_"), "{a}");
        assert_eq!(a.len(), 3 + 24, "12 random bytes as hex");
        assert_ne!(a, b, "two requests must not share an id");
    }

    #[test]
    fn hosted_identity_fills_in_the_gaps_for_an_old_client() {
        // A client that sends nothing still gets a correlation id and a visible
        // "unknown" source, which is the signal that the CLI needs updating.
        let (req_id, source, intended) = hosted_identity(&HeaderMap::new());
        assert!(req_id.starts_with("gw_"));
        assert_eq!(source, "unknown");
        assert!(intended.is_empty());

        let mut h = HeaderMap::new();
        h.insert("x-rayu-request-id", "req_abc".parse().unwrap());
        h.insert("x-rayu-query-source", "repl_main_thread".parse().unwrap());
        let (req_id, source, _) = hosted_identity(&h);
        assert_eq!(req_id, "req_abc", "the client's id must be preserved");
        assert_eq!(source, "repl_main_thread");
    }

    #[test]
    fn daily_turn_cap_fails_open() {
        assert_eq!(daily_turn_cap(Some(50)), 50);
        assert_eq!(
            daily_turn_cap(Some(0)),
            0,
            "an accidental 0 must not lock everyone out"
        );
        assert_eq!(daily_turn_cap(Some(-1)), 0);
        assert_eq!(daily_turn_cap(None), 0);
    }

    #[test]
    fn cap_and_remaining_handle_unlimited() {
        assert_eq!(cap_or_unlimited(None), UNLIMITED);
        assert_eq!(cap_or_unlimited(Some(500)), 500);
        assert_eq!(
            remaining(UNLIMITED, 100),
            None,
            "unlimited has no remainder"
        );
        assert_eq!(remaining(500, 100), Some(400));
        assert_eq!(
            remaining(500, 900),
            Some(0),
            "an overspend shows zero, never negative"
        );
    }

    #[test]
    fn actual_billable_is_zero_without_usage() {
        let rates = credits::model_rates_for(1.0, 0.0, 0.0, 0.0);
        assert_eq!(actual_billable(None, &rates), 0);
    }

    /// The cache split must be priced by bucket, so a cached prompt costs far less
    /// than a fresh one for the same token count.
    #[test]
    fn actual_billable_prices_the_cache_split() {
        let rates = credits::model_rates_for(1.0, 0.0, 0.0, 0.0);
        let fresh = Usage {
            prompt_tokens: 1000,
            completion_tokens: 0,
            total_tokens: 1000,
            prompt_cache_miss_tokens: 1000,
            ..Default::default()
        };
        let cached = Usage {
            prompt_tokens: 1000,
            completion_tokens: 0,
            total_tokens: 1000,
            prompt_cache_hit_tokens: 1000,
            prompt_cache_miss_tokens: 0,
            ..Default::default()
        };
        let fresh_cost = actual_billable(Some(&fresh), &rates);
        let cached_cost = actual_billable(Some(&cached), &rates);
        assert!(
            cached_cost < fresh_cost,
            "cache reads must be cheaper: {cached_cost} vs {fresh_cost}"
        );
    }

    #[tokio::test]
    async fn credit_headers_report_usage_and_an_unlimited_cap() {
        let mut resp = httpx::write_json(StatusCode::OK, &serde_json::json!({}));
        set_credit_headers(&mut resp, 250_000, 1_000_000, 1_000, 42);
        let h = resp.headers();
        assert_eq!(h.get("x-rayu-credits-used").unwrap(), "250");
        assert_eq!(h.get("x-rayu-credits-remaining").unwrap(), "750");
        assert_eq!(h.get("x-rayu-topup-balance").unwrap(), "42");

        let mut resp = httpx::write_json(StatusCode::OK, &serde_json::json!({}));
        set_credit_headers(&mut resp, 5_000, UNLIMITED, 1_000, 0);
        assert_eq!(
            resp.headers().get("x-rayu-credits-remaining").unwrap(),
            "unlimited",
            "the CLI renders this string literally"
        );
    }

    /// An overspend must not render as a negative remainder, and a zero
    /// tokens-per-credit must not divide by zero.
    #[tokio::test]
    async fn credit_headers_are_defensive() {
        let mut resp = httpx::write_json(StatusCode::OK, &serde_json::json!({}));
        set_credit_headers(&mut resp, 2_000_000, 1_000_000, 1_000, 0);
        assert_eq!(resp.headers().get("x-rayu-credits-remaining").unwrap(), "0");

        let mut resp = httpx::write_json(StatusCode::OK, &serde_json::json!({}));
        set_credit_headers(&mut resp, 500, 1_000, 0, 0);
        assert_eq!(
            resp.headers().get("x-rayu-credits-used").unwrap(),
            "500",
            "tokens_per_credit 0 must not panic; it falls back to 1"
        );
    }

    #[test]
    fn allowed_model_codes_lists_the_plan() {
        assert_eq!(allowed_model_codes(&[]), "");
    }

    #[test]
    fn best_effort_model_survives_junk() {
        assert_eq!(
            best_effort_model(br#"{"model":"deepseek-v4"}"#),
            "deepseek-v4"
        );
        assert_eq!(best_effort_model(b"not json"), "");
        assert_eq!(best_effort_model(br#"{"model":123}"#), "");
    }
}
