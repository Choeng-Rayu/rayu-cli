//! Renders a limiter denial so the message, `Retry-After` and reason header MATCH
//! THE ACTUAL REASON.
//!
//! Port of the Go gateway's `internal/server/reservedenial.go`.
//!
//! # Why this exists
//!
//! Every denial used to be written as `"credit limit reached: <reason>"` with
//! `Retry-After` set to seconds-until-billing-period-reset. The limiter's reasons are
//! `concurrency` | `requests` | `period_limit` (plus `bucket_limit` / `pool_limit`
//! for teams), so a user who simply had more requests in flight than
//! `maxConcurrentStreams` (default 3 -- one CLI turn fans out to subagents, side
//! queries and quota checks) received a BILLING error telling them their credits were
//! exhausted and would renew "in about 26 days", while their balance was half unused.
//!
//! That is the single most misleading response this service can produce: it sends a
//! paying customer to the pricing page to fix a problem that resolves itself in one
//! second.

use axum::response::Response;
use http::StatusCode;
use rayu_core::httpx;
use serde_json::json;

/// Names the machine-readable reserve-denial reason so a client can classify the 429
/// without parsing prose. Mirrors the existing `X-Rayu-Limit: daily_turn_limit`
/// contract.
pub const RAYU_LIMIT_HEADER: &str = "x-rayu-limit";

/// The `Retry-After` advertised for a denial that clears on its own within seconds --
/// a concurrency slot frees as soon as one of the user's in-flight requests finishes.
pub const TRANSIENT_RETRY_AFTER_SECONDS: i64 = 2;

/// The `Retry-After` for the requests-per-5h abuse cap.
///
/// The exact window TTL is not returned by the limiter, so advertise a conservative
/// minute: long enough not to hammer, short enough that a client which is merely
/// bursting recovers on its own.
pub const SHORT_WINDOW_RETRY_AFTER_SECONDS: i64 = 60;

/// Builds the 429 for a limiter denial.
///
/// `override_msg` replaces the default prose (the team path uses it); `scope` is
/// echoed so a client can tell a personal limit from a team one.
pub fn write_reserve_denial(
    reason: &str,
    reset_seconds: i64,
    override_msg: &str,
    scope: &str,
) -> Response {
    let mut msg = override_msg.to_string();
    let mut retry_after = reset_seconds;
    let mut transient = false;

    match reason {
        "concurrency" => {
            transient = true;
            retry_after = TRANSIENT_RETRY_AFTER_SECONDS;
            if msg.is_empty() {
                msg = "too many concurrent requests for this account — retry shortly. \
                       This is a concurrency limit, not your credit balance."
                    .to_string();
            }
        }
        "requests" => {
            transient = true;
            retry_after = SHORT_WINDOW_RETRY_AFTER_SECONDS;
            if msg.is_empty() {
                msg = "too many requests in a short window — retry shortly. \
                       This is a rate limit, not your credit balance."
                    .to_string();
            }
        }
        // period_limit / bucket_limit / pool_limit and any future reason: a real
        // balance state, so the period reset is the correct Retry-After.
        _ => {
            if msg.is_empty() {
                msg = format!("credit limit reached: {reason}");
            }
        }
    }

    let mut body = serde_json::Map::new();
    body.insert(
        "error".into(),
        json!({"message": msg, "type": "rate_limit_exceeded"}),
    );
    body.insert("reason".into(), json!(reason));
    body.insert("transient".into(), json!(transient));
    // resetSeconds keeps its original meaning (period reset) so existing clients that
    // render a renewal ETA are unaffected; it is omitted for a transient denial, where
    // a billing reset is not what the client should show.
    if !transient {
        body.insert("resetSeconds".into(), json!(reset_seconds));
    }
    if !scope.is_empty() {
        body.insert("scope".into(), json!(scope));
    }

    let mut resp = httpx::write_json(
        StatusCode::TOO_MANY_REQUESTS,
        &serde_json::Value::Object(body),
    );
    if retry_after > 0 {
        if let Ok(v) = http::HeaderValue::from_str(&retry_after.to_string()) {
            resp.headers_mut().insert(http::header::RETRY_AFTER, v);
        }
    }
    if !reason.is_empty() {
        if let Ok(v) = http::HeaderValue::from_str(reason) {
            resp.headers_mut().insert(RAYU_LIMIT_HEADER, v);
        }
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn body_of(resp: Response) -> serde_json::Value {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).expect("JSON body")
    }

    /// The regression this file exists for: a concurrency denial must NOT read as a
    /// billing problem, and must not tell the user to wait for a billing period.
    #[tokio::test]
    async fn a_concurrency_denial_is_transient_and_not_about_credits() {
        let resp = write_reserve_denial("concurrency", 2_246_400, "", "");
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            resp.headers().get(http::header::RETRY_AFTER).unwrap(),
            "2",
            "seconds, not the 26-day billing reset"
        );
        assert_eq!(
            resp.headers().get(RAYU_LIMIT_HEADER).unwrap(),
            "concurrency"
        );

        let body = body_of(resp).await;
        assert_eq!(body["transient"], true);
        assert!(
            body.get("resetSeconds").is_none(),
            "a billing reset must not be shown for a transient denial"
        );
        let msg = body["error"]["message"].as_str().unwrap();
        assert!(msg.contains("concurrency limit"), "{msg}");
        assert!(
            !msg.contains("credit limit reached"),
            "the misleading billing prose must be gone: {msg}"
        );
        assert_eq!(body["error"]["type"], "rate_limit_exceeded");
    }

    #[tokio::test]
    async fn a_short_window_denial_advertises_a_conservative_minute() {
        let resp = write_reserve_denial("requests", 999, "", "");
        assert_eq!(resp.headers().get(http::header::RETRY_AFTER).unwrap(), "60");
        let body = body_of(resp).await;
        assert_eq!(body["transient"], true);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("rate limit"));
    }

    /// A real balance state keeps the period reset, because that IS when it clears.
    #[tokio::test]
    async fn a_period_limit_keeps_the_billing_reset() {
        let resp = write_reserve_denial("period_limit", 3600, "", "");
        assert_eq!(
            resp.headers().get(http::header::RETRY_AFTER).unwrap(),
            "3600"
        );
        let body = body_of(resp).await;
        assert_eq!(body["transient"], false);
        assert_eq!(
            body["resetSeconds"], 3600,
            "clients render a renewal ETA from this"
        );
        assert_eq!(
            body["error"]["message"],
            "credit limit reached: period_limit"
        );
    }

    /// Team denials reuse the same renderer with a scope and their own prose.
    #[tokio::test]
    async fn a_team_denial_echoes_its_scope_and_message() {
        let resp = write_reserve_denial(
            "bucket_limit",
            1800,
            "your team seat is out of credits",
            "team",
        );
        let body = body_of(resp).await;
        assert_eq!(body["scope"], "team");
        assert_eq!(body["error"]["message"], "your team seat is out of credits");
        assert_eq!(body["reason"], "bucket_limit");
        assert_eq!(body["transient"], false);
    }

    /// A non-positive reset must not emit a `Retry-After: 0`, which some clients read
    /// as "retry immediately, forever".
    #[tokio::test]
    async fn a_non_positive_reset_omits_retry_after() {
        let resp = write_reserve_denial("period_limit", 0, "", "");
        assert!(resp.headers().get(http::header::RETRY_AFTER).is_none());
        let resp = write_reserve_denial("period_limit", -1, "", "");
        assert!(resp.headers().get(http::header::RETRY_AFTER).is_none());
    }

    /// An unknown future reason must still produce a coherent answer.
    #[tokio::test]
    async fn an_unknown_reason_falls_back_to_the_balance_shape() {
        let resp = write_reserve_denial("some_new_limit", 60, "", "");
        assert_eq!(
            resp.headers().get(RAYU_LIMIT_HEADER).unwrap(),
            "some_new_limit"
        );
        let body = body_of(resp).await;
        assert_eq!(body["transient"], false);
        assert_eq!(body["resetSeconds"], 60);
    }
}
