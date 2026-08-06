//! `ANY /v1/proxy` -- the transparent, authenticated reverse proxy for BYO-key
//! providers.
//!
//! Port of `handleProxy` from the Go gateway's `internal/server/server.go`.
//!
//! Identity comes from `X-Rayu-Token`, NOT `Authorization`, because the latter carries
//! the USER'S OWN upstream provider credential which must be forwarded untouched. No
//! credits are charged (the user pays their own provider); only the daily-turn cap and
//! a best-effort usage event apply.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::response::Response;
use http::{HeaderMap, Method, StatusCode};
use rayu_core::eventqueue::Item;
use rayu_core::jwt;

use crate::hosted::{daily_turn_cap, new_req_id};
use crate::proxy::{
    forwardable_headers, header_or, model_from_upstream_url, proxy_error, usage_event_source,
    LIMIT_HEADER, MODEL_FIDELITY_HEADER, PROXIED_HEADER,
};
use crate::state::{AppState, MAX_REQUEST_BYTES};

pub async fn handle_proxy(
    State(st): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // --- identity -----------------------------------------------------------
    let tok = header_or(&headers, "x-rayu-token", "");
    if tok.is_empty() {
        return proxy_error(StatusCode::UNAUTHORIZED, "missing X-Rayu-Token");
    }
    let claims = match jwt::verify_access_token(&tok, &st.cfg.jwt_secret) {
        Ok(c) => c,
        Err(_) => return proxy_error(StatusCode::UNAUTHORIZED, "invalid X-Rayu-Token"),
    };

    let upstream_url = header_or(&headers, "x-rayu-upstream-url", "");
    if upstream_url.is_empty() {
        return proxy_error(StatusCode::BAD_REQUEST, "missing X-Rayu-Upstream-URL");
    }
    if let Err(e) = crate::proxy::validate_upstream_url(
        &upstream_url,
        st.cfg.allow_insecure_provider_base_url,
    ) {
        return proxy_error(StatusCode::FORBIDDEN, &e.to_string());
    }

    // Request-identity headers, read early: the LOGICAL request id keys the idempotent
    // daily-turn accounting, so the CLI's retries of ONE logical request do not each
    // burn a separate daily turn.
    let req_id = {
        let raw = header_or(&headers, "x-rayu-request-id", "");
        if raw.is_empty() {
            new_req_id()
        } else {
            raw
        }
    };
    let logical_id = header_or(&headers, "x-rayu-logical-request-id", &req_id);

    // --- daily turn cap: BEST-EFFORT on the BYO-key path --------------------
    // Enforced only when entitlements and the limiter are both available. On deny the
    // answer is a plain 429 that is deliberately NOT tagged with X-Rayu-Proxy-Error, so
    // the CLI surfaces "daily limit reached" instead of failing safe to a direct
    // provider call (which would bypass the cap). Any infra hiccup FAILS OPEN -- a
    // BYO-key user is never blocked by gateway issues.
    let mut reserved_turn = false;
    if let Some(lim) = st.lim.as_ref() {
        if let Ok(ent) = st.ent.resolve(claims.user_id).await {
            match lim
                .reserve_turn_for(
                    claims.user_id,
                    daily_turn_cap(ent.plan.max_daily_turns),
                    &logical_id,
                )
                .await
            {
                // Limiter unavailable: fail open rather than block BYO-key traffic.
                Err(_) => {}
                Ok(tr) if !tr.ok => {
                    tracing::info!(
                        "proxy reject: user={} daily turn limit reached ({}/{})",
                        claims.user_id,
                        tr.used_today,
                        tr.limit
                    );
                    let mut resp = rayu_core::httpx::write_json(
                        StatusCode::TOO_MANY_REQUESTS,
                        &serde_json::json!({
                            "error": {
                                "message": "daily turn limit reached",
                                "type": "rate_limit_exceeded",
                            },
                            "reason": "daily_turn_limit",
                            "resetSeconds": tr.reset_seconds,
                        }),
                    );
                    if let Some((n, v)) = crate::proxy::retry_after(tr.reset_seconds) {
                        resp.headers_mut().insert(n, v);
                    }
                    // An intentional gateway limit, NOT a proxy error: the CLI must
                    // show it rather than bypassing the cap with a direct call.
                    resp.headers_mut()
                        .insert(LIMIT_HEADER, http::HeaderValue::from_static("daily_turn_limit"));
                    return resp;
                }
                Ok(_) => reserved_turn = true,
            }
        }
    }

    if body.len() > MAX_REQUEST_BYTES {
        if reserved_turn {
            release_turn_for_bg(&st, claims.user_id, &logical_id);
        }
        tracing::info!(
            "proxy: body read too large user={} bytes={}",
            claims.user_id,
            body.len()
        );
        return proxy_error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large");
    }

    let provider = header_or(&headers, "x-rayu-provider", "unknown");
    let source = header_or(&headers, "x-rayu-query-source", "unknown");
    let intended = header_or(&headers, "x-rayu-intended-model", "");

    // The model ACTUALLY going upstream: Bedrock hides it in the URL path, other
    // providers put it in the JSON body; fall back to the CLI-declared resolved model
    // header. This is what makes gateway logs show the real model instead of an empty
    // body `model` for Bedrock.
    let mut actual = model_from_upstream_url(&upstream_url);
    if actual.is_empty() {
        actual = crate::proxy::best_effort_model(&body);
    }
    if actual.is_empty() {
        actual = header_or(&headers, "x-rayu-resolved-model", "");
    }

    // MODEL FIDELITY: a definite cross-family mismatch is always logged; when
    // RAYU_ENFORCE_MODEL_FIDELITY is set it is refused HERE, before any upstream call
    // or turn burn, so the bad request never reaches the provider.
    if crate::proxy::family_mismatch(&intended, &actual) {
        tracing::warn!(
            "proxy: MODEL FIDELITY MISMATCH user={} reqid={req_id} logical={logical_id} \
             source={source} intended={intended:?} actual={actual:?} upstream={upstream_url}",
            claims.user_id
        );
        if st.cfg.enforce_model_fidelity {
            if reserved_turn {
                release_turn_for_bg(&st, claims.user_id, &logical_id);
            }
            let mut resp = proxy_error(
                StatusCode::CONFLICT,
                "model fidelity mismatch: intended and routed model families differ",
            );
            resp.headers_mut()
                .insert(MODEL_FIDELITY_HEADER, http::HeaderValue::from_static("mismatch"));
            return resp;
        }
    }

    // --- forward ------------------------------------------------------------
    let fwd = forwardable_headers(&headers);
    let sent = st
        .upstream
        .forward(&method, &upstream_url, fwd, body.to_vec())
        .await;

    let resp = match sent {
        Err(e) => {
            // Upstream unreachable / gateway-side failure before any bytes were sent.
            // The CLI will fail safe to a direct call, so do not burn a turn.
            if reserved_turn {
                release_turn_for_bg(&st, claims.user_id, &logical_id);
            }
            tracing::warn!(
                "proxy: upstream unreachable user={} reqid={req_id} source={source} \
                 provider={provider} intended={intended:?} actual={actual:?} \
                 upstream={upstream_url}: {e}",
                claims.user_id
            );
            return if e.is_circuit_open() {
                let mut r = proxy_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream temporarily unavailable",
                );
                r.headers_mut()
                    .insert(http::header::RETRY_AFTER, http::HeaderValue::from_static("5"));
                r
            } else {
                proxy_error(StatusCode::BAD_GATEWAY, "upstream unreachable")
            };
        }
        Ok(r) => r,
    };

    let status = resp.status();
    if !status.is_success() {
        // The gateway is a transparent pass-through here, so a non-200 (the upstream's
        // own 503/429) is expected sometimes -- but it MUST show up in gateway logs, or
        // every "why did I get a 503 from the gateway" report requires cross-referencing
        // the provider's own dashboard to answer.
        tracing::warn!(
            "proxy: upstream non-200 user={} reqid={req_id} source={source} \
             provider={provider} intended={intended:?} actual={actual:?} \
             upstream={upstream_url} status={}",
            claims.user_id,
            status.as_u16()
        );
        if reserved_turn {
            // The upstream rejected the request (e.g. Bedrock 400/429). No successful
            // turn happened and the CLI will retry, so refund the reservation rather
            // than multiplying the daily-turn count across retries.
            release_turn_for_bg(&st, claims.user_id, &logical_id);
            reserved_turn = false;
        }
    }

    // Best-effort tracking through the bounded write queue. It never affects the
    // proxied response: enqueue is non-blocking and the write happens on a shared
    // worker pool instead of one untracked task per request.
    if let Some(store) = st.store.clone() {
        let ev_source = usage_event_source(&source);
        let (user_id, provider_c, actual_c) =
            (claims.user_id, provider.clone(), actual.clone());
        st.wq.enqueue(Item::new("proxy_usage_event", move || {
            let store = store.clone();
            let (provider_c, actual_c) = (provider_c.clone(), actual_c.clone());
            async move {
                store
                    .insert_usage_event(user_id, &provider_c, &actual_c, ev_source)
                    .await
                    .map_err(Into::into)
            }
        }));
    }

    tracing::info!(
        "proxy: user={} reqid={req_id} source={source} provider={provider} \
         intended={intended:?} actual={actual:?} -> {upstream_url} (status={})",
        claims.user_id,
        status.as_u16()
    );

    // Relay the upstream response verbatim: every header (minus hop-by-hop) plus the
    // body as a stream, so a long SSE generation is never buffered.
    let mut out = Response::builder().status(status);
    {
        let h = out.headers_mut().expect("fresh builder");
        crate::proxy::copy_upstream_headers(resp.headers(), h);
        // The positive marker the CLI checks to know this really was proxied.
        h.insert(PROXIED_HEADER, http::HeaderValue::from_static("1"));
    }

    // A mid-stream break must be visible: the status is already committed, but logging
    // it distinctly is what explains a truncated stream on the client. The turn is NOT
    // refunded here -- unlike Go, which cannot know whether the break was the client
    // hanging up, this arm only sees the upstream body end early.
    let user_id = claims.user_id;
    let (rid, src, prov, act, up) = (
        req_id.clone(),
        source.clone(),
        provider.clone(),
        actual.clone(),
        upstream_url.clone(),
    );
    let body_stream = futures::TryStreamExt::map_err(resp.bytes_stream(), move |e| {
        tracing::warn!(
            "proxy: stream interrupted user={user_id} reqid={rid} source={src} \
             provider={prov} intended={act:?} upstream={up} wrote=true: {e}"
        );
        std::io::Error::other(e)
    });

    let _ = reserved_turn; // consumed above; kept for the refund decisions
    out.body(Body::from_stream(body_stream))
        .unwrap_or_else(|_| proxy_error(StatusCode::BAD_GATEWAY, "upstream unreachable"))
}

/// Refunds one daily turn AND clears the logical-request hold out-of-band, so a
/// subsequent retry of the same logical request can reserve again.
fn release_turn_for_bg(st: &Arc<AppState>, user_id: i64, logical_id: &str) {
    let Some(lim) = st.lim.clone() else { return };
    let logical = logical_id.to_string();
    tokio::spawn(async move {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            lim.release_turn_for(user_id, &logical),
        )
        .await;
    });
}
