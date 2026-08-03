//! The free metadata endpoints: token counting, whoami, entitlements, and the
//! retired chat-completions ingress.
//!
//! Ports `handleCountTokens` (`internal/server/counttokens.go`) plus `handleWhoami`,
//! `handleEntitlements` and `handleRetiredChatCompletions` from
//! `internal/server/server.go`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use axum::Extension;
use http::{HeaderMap, StatusCode};
use rayu_core::httpx;
use rayu_core::jwt::Claims;
use serde_json::json;

use crate::state::{entitlement_error_response, status_or_unknown, AppState};
use crate::tokencount;

/// `POST /anthropic/v1/messages/count_tokens`
///
/// # Why this exists
///
/// The Anthropic SDK exposes `messages.countTokens()`, and the CLI uses it to draw
/// `/context` and to decide when to compact. Before this endpoint existed the gateway
/// answered 404, and the client then "counted" by sending a REAL `max_tokens=1`
/// completion per context section -- around twenty billed requests per `/context`,
/// which also tripped the per-user concurrency limiter and made the command fail
/// outright.
///
/// So: counting is METADATA, and metadata must be free.
///
/// * no credit reserve and no ledger row (nothing is consumed upstream);
/// * no daily-turn burn (a user must not lose a turn to a UI refresh);
/// * no concurrency slot (that budget exists to protect upstreams, and this endpoint
///   never touches one);
/// * no upstream request at all, so it cannot fail because a provider lacks the
///   endpoint -- most hosted providers do not have one.
///
/// The count is an ESTIMATE (see [`crate::tokencount`]). The response is deliberately
/// the exact Anthropic shape -- `{"input_tokens": N}` -- because the SDK parses it;
/// the estimate is advertised out-of-band in a response header so an operator can
/// tell where the number came from.
pub async fn handle_count_tokens(
    State(st): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (req_id, source, _) = hosted_identity(&headers);

    // Entitlement still applies: this is account-scoped information about a hosted
    // model, so a suspended account or an unavailable model gets the same answer here
    // as on the completion path. It is a cache read, not a Redis/DB round trip.
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
    if body.len() > crate::state::MAX_REQUEST_BYTES {
        return httpx::write_error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large");
    }

    let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return httpx::write_error(StatusCode::BAD_REQUEST, "invalid JSON body");
    };
    let model = parsed
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();

    // A model the plan cannot use is refused, mirroring the completion path -- but the
    // count itself is model-independent, so this is purely an access check.
    if !ent.allowed_models.iter().any(|m| m.code == model) {
        tracing::info!(
            "count_tokens reject: user={} reqid={req_id} source={source} model={model:?} \
             not allowed for plan={}",
            claims.user_id,
            ent.plan.code
        );
        return httpx::write_error(
            StatusCode::FORBIDDEN,
            &format!("model not available on your plan: {model}"),
        );
    }

    let Some(tokens) = tokencount::estimate_body(&body) else {
        return httpx::write_error(StatusCode::BAD_REQUEST, "invalid Messages request body");
    };

    let mut resp = httpx::write_json(StatusCode::OK, &json!({"input_tokens": tokens}));
    // Tell operators (and anyone debugging a context readout) that this number is
    // computed here rather than by the upstream tokenizer.
    resp.headers_mut().insert(
        "x-rayu-token-count",
        http::HeaderValue::from_static("estimate"),
    );
    resp
}

/// Reads the correlation headers every hosted request may carry.
///
/// Returns `(request id, query source, intended model)`. All three are optional: a
/// missing header is an empty string, never an error, because they exist for
/// observability and must never fail a request.
pub fn hosted_identity(headers: &HeaderMap) -> (String, String, String) {
    let get = |name: &str| -> String {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    (
        get("x-rayu-request-id"),
        get("x-rayu-query-source"),
        get("x-rayu-intended-model"),
    )
}

pub async fn handle_whoami(Extension(claims): Extension<Claims>) -> Response {
    httpx::write_json(
        StatusCode::OK,
        &json!({"userId": claims.user_id, "role": claims.role}),
    )
}

pub async fn handle_entitlements(
    State(st): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Response {
    let ent = match st.ent.resolve(claims.user_id).await {
        Ok(e) => e,
        Err(e) => return entitlement_error_response(&e),
    };
    httpx::write_json(
        StatusCode::OK,
        &json!({
            "userId": ent.user_id,
            "status": ent.status,
            "plan": ent.plan,
            "allowedModels": ent.allowed_models,
            "topupBalance": ent.topup_balance,
        }),
    )
}

/// The message a retired client gets. Actionable on purpose: the user can fix it.
pub const RETIRED_CHAT_COMPLETIONS_MESSAGE: &str = "This endpoint has been retired. \
Update rayu-cli (npm i -g @rayu-dev/rayu-cli) — hosted models are now served on \
/anthropic/v1/messages.";

/// Retired ingress, kept REGISTERED rather than 404ing.
///
/// CLI builds already published may still POST here: they get an actionable 410 plus
/// a log line that tells operators old clients are still in the field.
pub async fn handle_retired_chat_completions(
    Extension(claims): Extension<Claims>,
    headers: HeaderMap,
) -> Response {
    let ua = headers
        .get(http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    tracing::warn!(
        "retired endpoint: user={} still calling /v1/chat/completions (ua={ua:?})",
        claims.user_id
    );
    httpx::write_error(StatusCode::GONE, RETIRED_CHAT_COMPLETIONS_MESSAGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_identity_reads_and_trims_the_correlation_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-rayu-request-id", "  req_1 ".parse().unwrap());
        h.insert("x-rayu-query-source", "chat".parse().unwrap());
        h.insert(
            "x-rayu-intended-model",
            "deepseek-v4-flash".parse().unwrap(),
        );
        let (req_id, source, intended) = hosted_identity(&h);
        assert_eq!(req_id, "req_1", "whitespace must be trimmed");
        assert_eq!(source, "chat");
        assert_eq!(intended, "deepseek-v4-flash");
    }

    #[test]
    fn missing_correlation_headers_are_empty_not_an_error() {
        let (req_id, source, intended) = hosted_identity(&HeaderMap::new());
        assert!(req_id.is_empty() && source.is_empty() && intended.is_empty());
    }

    /// The message is a contract with the CLI, which shows it verbatim.
    #[test]
    fn the_retired_message_names_the_upgrade_and_the_new_path() {
        assert!(RETIRED_CHAT_COMPLETIONS_MESSAGE.contains("npm i -g @rayu-dev/rayu-cli"));
        assert!(RETIRED_CHAT_COMPLETIONS_MESSAGE.contains("/anthropic/v1/messages"));
    }
}
