//! `POST /anthropic/v1/messages` -- THE rayu-hosted completion endpoint.
//!
//! Port of `handleAnthropicMessages` from the Go gateway's
//! `internal/server/server.go`.
//!
//! The CLI always speaks Anthropic Messages here; the provider's own wire format is
//! resolved from the registry and served by the matching adapter in
//! [`crate::adapters`] -- either the byte-verbatim Anthropic passthrough or a
//! translating adapter. Usage is metered in the same normalized buckets whichever
//! format was used, so billing is format-independent.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use http::{HeaderMap, StatusCode};
use rayu_core::httpx;
use rayu_core::jwt::Claims;

use crate::adapters::AdapterRequest;
use crate::hosted::{record_key_failure, reserve_hosted, set_credit_headers};
use crate::sse::StreamStart;
use crate::state::{at_capacity_response, AppState};
use crate::upstream;

pub async fn handle_anthropic_messages(
    State(st): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // The load-shedding valve wraps ONLY this endpoint: streaming holds a full
    // connection chain open for the whole generation, while the light metadata routes
    // are cheap and stay unlimited.
    let Some(_slot) = st.inflight.try_acquire() else {
        st.note_shed();
        return at_capacity_response(st.inflight.max(), "/anthropic/v1/messages");
    };

    let mut hr = match reserve_hosted(&st, &claims, &headers, &body).await {
        Ok(hr) => hr,
        Err(resp) => return resp,
    };

    let stream = hr
        .req
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    tracing::info!(
        "anthropic: user={} reqid={} source={} model={} provider={} format={} \
         intended={:?} stream={stream} reserved={}",
        hr.user_id,
        hr.req_id,
        hr.source,
        hr.hm.code,
        hr.route.name,
        hr.route.format,
        hr.intended,
        hr.est_billable
    );

    // Model fidelity: the upstream always receives the PROVIDER's model id.
    if let Some(obj) = hr.req.as_object_mut() {
        obj.insert(
            "model".into(),
            serde_json::Value::String(hr.hm.upstream_model_id.clone()),
        );
    }

    // Multi-key failover: the keys arrive in priority order, already filtered to the
    // ones usable right now. The adapter walks them on a rate-limit/quota/auth status
    // and reports each failure so the key's health is recorded -- a 429 puts that key
    // on cooldown, a 401/403 takes it out of rotation entirely.
    let provider_id = hr.hm.provider_id;
    let on_failure_state = st.clone();
    let areq = AdapterRequest {
        route: hr.route.clone(),
        keys: hr.api_keys.clone(),
        on_key_failure: Some(Arc::new(move |f: upstream::KeyFailure| {
            record_key_failure(&on_failure_state, provider_id, &f);
        })),
        upstream_model_id: hr.hm.upstream_model_id.clone(),
        anthropic: hr.req.clone(),
        stream,
        keepalive_seconds: st.cfg.sse_keepalive_seconds,
    };

    if stream {
        let settler = hr.settler.clone();
        let (user_id, req_id, source, code, format) = (
            hr.user_id,
            hr.req_id.clone(),
            hr.source.clone(),
            hr.hm.code.clone(),
            hr.route.format.clone(),
        );
        // The pump runs DETACHED, so settlement happens in `on_done` rather than after
        // the handler returns. That is what makes billing survive a client hang-up:
        // whatever the upstream delivered is still charged.
        let on_done = Box::new(move |usage, err: Option<String>| {
            match err {
                None => {}
                Some(e) => {
                    tracing::warn!(
                        "anthropic: upstream error user={user_id} reqid={req_id} \
                         source={source} model={code} format={format}: {e}"
                    );
                }
            }
            settler.settle_detached(usage);
        });

        return match hr.adapter.stream(&st.upstream, areq, on_done).await {
            StreamStart::Streaming(mut resp) => {
                set_credit_headers(
                    &mut resp,
                    hr.used_period,
                    hr.cap_period,
                    hr.tokens_per_credit,
                    hr.topup_bal,
                );
                resp
            }
            // The upstream answered an error STATUS: the adapter already chose the
            // relay body, and `on_done` never runs, so settle here.
            StreamStart::Failed {
                response,
                error,
                usage,
            } => {
                tracing::warn!(
                    "anthropic: upstream error user={} reqid={} source={} model={} \
                     format={} wrote=true: {error}",
                    hr.user_id,
                    hr.req_id,
                    hr.source,
                    hr.hm.code,
                    hr.route.format
                );
                hr.settler.settle(usage.as_ref()).await;
                response
            }
            // Never reached the upstream: nothing was consumed, so settle with no
            // usage (which releases the pre-flight hold) and answer 502/503.
            StreamStart::Unreachable(e) => {
                tracing::warn!(
                    "anthropic: upstream unreachable user={} reqid={} source={} model={}: {e}",
                    hr.user_id,
                    hr.req_id,
                    hr.source,
                    hr.hm.code
                );
                hr.settler.settle(None).await;
                crate::adapters::anthropic::write_upstream_error(&e)
            }
        };
    }

    // --- non-streaming -------------------------------------------------------
    let out = hr.adapter.complete(&st.upstream, areq).await;
    if out.status == 0 {
        // The upstream was never reached.
        hr.settler.settle(None).await;
        tracing::warn!(
            "anthropic: upstream unreachable user={} reqid={} source={} model={}: {}",
            hr.user_id,
            hr.req_id,
            hr.source,
            hr.hm.code,
            out.error.unwrap_or_default()
        );
        return httpx::write_provider_unavailable(StatusCode::BAD_GATEWAY);
    }
    if out.status != 200 {
        tracing::warn!(
            "anthropic: upstream non-200 user={} reqid={} source={} model={} status={}",
            hr.user_id,
            hr.req_id,
            hr.source,
            hr.hm.code,
            out.status
        );
    }

    let actual = hr.settler.settle(out.usage.as_ref()).await;
    // The used figure reported back is the reserve adjusted to the real charge, so the
    // CLI's status line reflects this turn rather than the estimate.
    let used_now = hr.used_period - hr.est_billable + actual;

    if out.status != 200 {
        // Relay a client-fixable request error (400/413/422 -- e.g. "this model does
        // not support image input") with its real status and message so the CLI shows
        // the cause and does NOT retry; keep the sanitized 502 for provider-side or
        // transient failures.
        let mut resp = if upstream::is_upstream_request_error(out.status) {
            let msg = upstream::upstream_error_message(&out.body);
            let msg = if msg.is_empty() {
                "The request was rejected by the model provider.".to_string()
            } else {
                msg
            };
            let code =
                StatusCode::from_u16(out.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            httpx::write_anthropic_error(code, &msg)
        } else {
            httpx::write_provider_unavailable(StatusCode::BAD_GATEWAY)
        };
        set_credit_headers(
            &mut resp,
            used_now,
            hr.cap_period,
            hr.tokens_per_credit,
            hr.topup_bal,
        );
        return resp;
    }

    let mut resp = (
        StatusCode::OK,
        [(http::header::CONTENT_TYPE, "application/json")],
        out.body,
    )
        .into_response();
    set_credit_headers(
        &mut resp,
        used_now,
        hr.cap_period,
        hr.tokens_per_credit,
        hr.topup_bal,
    );
    resp
}
