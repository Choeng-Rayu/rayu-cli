//! `GET /v1/credits` and `GET /v1/credits/topup/quote`.
//!
//! Port of `handleCredits` / `handleTopupQuote` from the Go gateway's
//! `internal/server/server.go`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Response;
use axum::Extension;
use http::StatusCode;
use rayu_core::httpx;
use rayu_core::jwt::Claims;
use serde_json::{json, Value};

use crate::credits;
use crate::state::{entitlement_error_response, iso_time, status_or_unknown, AppState};
use crate::topup;

/// Rounds a credit figure to 2 decimal places for display.
///
/// The coarse whole-credit ceiling is gone from billing, so the displayed number is
/// fractional -- but it must not be a long float tail in a CLI table.
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Returns the caller's live per-period credit usage, remaining allowance (credits
/// and token equivalents), top-up balance, and reset time.
pub async fn handle_credits(
    State(st): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Response {
    let ent = match st.ent.resolve(claims.user_id).await {
        Ok(e) => e,
        Err(e) => return entitlement_error_response(&e),
    };

    // A team member's allowance is the TEAM's, so report that instead of their personal
    // plan -- otherwise the CLI would show a Free-plan zero while the member is happily
    // spending team credits. Falls through to the individual view whenever the team is
    // not billable, for the same reason the reserve path does.
    if claims.org_id > 0 {
        if let Some(orgs) = st.orgs.as_ref() {
            if let Ok(Some(org)) = orgs.resolve(claims.org_id, claims.user_id).await {
                if org.usable(chrono::Utc::now()).0 {
                    return write_team_credits(&st, &claims, &org).await;
                }
            }
        }
    }

    let Some(lim) = st.lim.as_ref() else {
        return httpx::write_error(StatusCode::INTERNAL_SERVER_ERROR, "status lookup failed");
    };
    let status = match lim.status(claims.user_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                "credits: status lookup failed for user={}: {e}",
                claims.user_id
            );
            return httpx::write_error(StatusCode::INTERNAL_SERVER_ERROR, "status lookup failed");
        }
    };

    // Redis is authoritative when it has a counter; otherwise fall back to the
    // durable balance from MySQL.
    let topup_balance = if status.topup_balance < 0 {
        ent.topup_balance
    } else {
        status.topup_balance
    };

    let settings = st.ent.settings();
    let tokens_per_credit = credits::tokens_per_credit(settings.baseline_credits_per_1m);
    let used_billable = status.used_period;
    let used_credits = round2(used_billable as f64 / tokens_per_credit as f64);

    let mut remaining_credits: Value = Value::Null;
    let (mut allowance_tokens, mut used_tokens, mut remaining_tokens) =
        (Value::Null, Value::Null, Value::Null);
    if let Some(per_period) = ent.plan.credits_per_period {
        remaining_credits = json!((per_period as f64 - used_credits).max(0.0));
        let at = per_period * tokens_per_credit;
        allowance_tokens = json!(at);
        used_tokens = json!(used_billable);
        remaining_tokens = json!((at - used_billable).max(0));
    }

    let (turns_used, turns_reset) = lim.turns_today(claims.user_id).await.unwrap_or((0, -1));
    let turns_remaining = match ent.plan.max_daily_turns {
        Some(cap) if cap > 0 => json!((cap - turns_used).max(0)),
        _ => Value::Null,
    };

    httpx::write_json(
        StatusCode::OK,
        &json!({
            "plan": ent.plan.code,
            "planName": ent.plan.name,
            "priceCents": ent.plan.price_cents,
            "creditsPerPeriod": ent.plan.credits_per_period,
            "usedCredits": used_credits,
            "remainingCredits": remaining_credits,
            "tokensPerCredit": tokens_per_credit,
            "allowanceTokens": allowance_tokens,
            "usedTokens": used_tokens,
            "remainingTokens": remaining_tokens,
            "resetSeconds": status.reset_period,
            "periodEnd": iso_time(ent.period_end),
            "topupBalance": topup_balance,
            "topUpEnabled": ent.plan.top_up_enabled,
            // Top-up pricing, so a client can quote "$1 = N credits" and enforce the
            // minimum purchase locally instead of guessing or hardcoding a rate.
            "creditsPerDollar": settings.credits_per_dollar,
            "minTopupCents": settings.min_topup_cents,
            // Per-day turn cap. turnsRemaining is null when unlimited.
            "maxDailyTurns": ent.plan.max_daily_turns,
            "turnsUsedToday": turns_used,
            "turnsRemaining": turns_remaining,
            "turnsResetSeconds": turns_reset,
        }),
    )
}

/// Prices a pay-as-you-go top-up from the admin's LIVE `app_settings` rate:
/// `GET /v1/credits/topup/quote?credits=N`.
///
/// Why the gateway and not only the backend: the `app_settings` schema states the
/// gateway reads `creditsPerDollar`/`minTopupCents` "so the CLI can quote a price
/// without calling the backend". The CLI already holds a gateway connection for AI
/// calls, so quoting here saves it a second round trip to a second service.
///
/// Staleness contract: the rate comes from the same in-memory config snapshot that
/// serves entitlements, refreshed from MySQL every `RAYU_CONFIG_REFRESH` (default
/// 30s) -- so an admin rate change is quoted here within that window (and immediately
/// after `POST /v1/_reload`). The BACKEND is authoritative on price: it re-reads
/// `app_settings` with no cache when creating the payment, so if a rate change lands
/// between quote and create the user is charged the backend's number. Clients should
/// re-quote rather than cache.
///
/// This endpoint NEVER grants credits -- granting is the backend's `activatePaid`
/// alone, so there is exactly one write path.
pub async fn handle_topup_quote(
    State(st): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let ent = match st.ent.resolve(claims.user_id).await {
        Ok(e) => e,
        Err(e) => return entitlement_error_response(&e),
    };
    if !ent.active() {
        return httpx::write_error(
            StatusCode::FORBIDDEN,
            &format!("account is {}", status_or_unknown(&ent.status)),
        );
    }

    // An absent/blank/unparseable credits param means "no amount chosen yet" -> quote
    // the cheapest payable purchase rather than rejecting the request, so the client
    // can render the screen before the user has typed anything.
    let wanted = q
        .get("credits")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    let settings = st.ent.settings();
    let quote = topup::quote_topup(
        settings.credits_per_dollar,
        settings.min_topup_cents,
        wanted,
    );

    httpx::write_json(
        StatusCode::OK,
        &json!({
            "enabled": quote.enabled,
            "credits": quote.credits,
            "amountCents": quote.amount_cents,
            "currency": quote.currency,
            "minCredits": quote.min_credits,
            "maxCredits": quote.max_credits,
            "rateCreditsPerDollar": quote.rate_credits_per_dollar,
            "minTopupCents": quote.min_topup_cents,
            "meetsMinimum": quote.meets_minimum,
            // Whether the caller's PLAN allows spending top-up credits at all. A user
            // can hold a balance on a plan that does not draw from it, so the client
            // needs both facts to decide what to show.
            "topUpEnabled": ent.plan.top_up_enabled,
        }),
    )
}

/// Answers `GET /v1/credits` for a TEAM member: the allowance is the org's shared
/// pool, and the member's own bucket is reported alongside it so the CLI can show both
/// ("you have X of your quota left; the team has Y").
///
/// The live counters come from Redis (what has actually been spent this period) and
/// fall back to the durable MySQL numbers when Redis has no counter yet -- which is the
/// case after a restart or on the first request of a new period.
async fn write_team_credits(
    st: &Arc<AppState>,
    claims: &Claims,
    org: &rayu_core::store::OrgMemberState,
) -> Response {
    let settings = st.ent.settings();
    let tokens_per_credit = credits::tokens_per_credit(settings.baseline_credits_per_1m);

    let Some(lim) = st.lim.as_ref() else {
        return httpx::write_error(StatusCode::INTERNAL_SERVER_ERROR, "status lookup failed");
    };
    let status = match lim.org_status(org.org_id, claims.user_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                "credits: org status lookup failed for org={} user={}: {e}",
                org.org_id,
                claims.user_id
            );
            return httpx::write_error(StatusCode::INTERNAL_SERVER_ERROR, "status lookup failed");
        }
    };

    let mut used_pool_billable = status.used_pool;
    if used_pool_billable == 0 && org.pool_used > 0 {
        used_pool_billable = org.pool_used * tokens_per_credit;
    }
    let mut used_bucket_billable = status.used_bucket;
    if used_bucket_billable == 0 {
        let db_used = (org.bucket_quota - org.bucket_credits) * tokens_per_credit;
        if db_used > 0 {
            used_bucket_billable = db_used;
        }
    }
    let used_credits = round2(used_pool_billable as f64 / tokens_per_credit as f64);

    let mut remaining_credits: Value = Value::Null;
    let (mut allowance_tokens, mut used_tokens, mut remaining_tokens) =
        (Value::Null, Value::Null, Value::Null);
    if org.plan.credits_per_period.is_some() {
        remaining_credits = json!((org.pool_total as f64 - used_credits).max(0.0));
        let at = org.pool_total * tokens_per_credit;
        allowance_tokens = json!(at);
        used_tokens = json!(used_pool_billable);
        remaining_tokens = json!((at - used_pool_billable).max(0));
    }

    let (turns_used, turns_reset) = lim.turns_today(claims.user_id).await.unwrap_or((0, -1));
    let turns_remaining = match org.plan.max_daily_turns {
        Some(cap) if cap > 0 => json!((cap - turns_used).max(0)),
        _ => Value::Null,
    };

    let bucket_remaining = (org.bucket_quota as f64
        - round2(used_bucket_billable as f64 / tokens_per_credit as f64))
    .max(0.0);

    httpx::write_json(
        StatusCode::OK,
        &json!({
            "plan": org.plan.code,
            "planName": org.plan.name,
            "priceCents": org.plan.price_cents,
            "creditsPerPeriod": org.plan.credits_per_period,
            "usedCredits": used_credits,
            "remainingCredits": remaining_credits,
            "tokensPerCredit": tokens_per_credit,
            "allowanceTokens": allowance_tokens,
            "usedTokens": used_tokens,
            "remainingTokens": remaining_tokens,
            "resetSeconds": status.reset_pool,
            "periodEnd": iso_time(org.period_end),
            // A team pool has no personal top-up balance: top-ups are bought by a user
            // for themselves, and spending them would bypass the team's cap.
            "topupBalance": 0,
            "topUpEnabled": false,
            "creditsPerDollar": settings.credits_per_dollar,
            "minTopupCents": settings.min_topup_cents,
            "maxDailyTurns": org.plan.max_daily_turns,
            "turnsUsedToday": turns_used,
            "turnsRemaining": turns_remaining,
            "turnsResetSeconds": turns_reset,
            // `scope: "team"` is the flag a client checks before trusting the fields
            // above to be a shared allowance rather than a personal one.
            "scope": "team",
            "team": {
                "organizationId": org.org_id,
                "role": org.member_role,
                "poolCredits": org.pool_total,
                "poolUsedCredits": used_credits,
                "bucketQuota": org.bucket_quota,
                "bucketRemaining": bucket_remaining,
                // What the admin BOUGHT and what is left of it -- the two numbers that
                // decide whether to buy more.
                "purchasedCredits": org.pool_extra,
                "purchasedRemaining": org.purchased_remaining(),
            },
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credits_are_rounded_to_two_places_for_display() {
        assert_eq!(round2(1.0 / 3.0), 0.33);
        assert_eq!(round2(0.005), 0.01, "half rounds away from zero, like Go");
        assert_eq!(round2(12.0), 12.0);
        assert_eq!(round2(0.0), 0.0);
    }

    /// A user who overspent (settlement can exceed the reserve) must see zero
    /// remaining, never a negative allowance.
    #[test]
    fn remaining_never_goes_negative() {
        let per_period = 100.0f64;
        let used = 137.5f64;
        assert_eq!((per_period - used).max(0.0), 0.0);
        // The same clamp applies to the token view.
        let (allowance, used_tokens) = (1_000i64, 4_000i64);
        assert_eq!((allowance - used_tokens).max(0), 0);
    }
}
