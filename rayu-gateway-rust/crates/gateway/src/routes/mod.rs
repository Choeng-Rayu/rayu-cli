//! HTTP routes.
//!
//! Port of the Go gateway's `internal/server`. `/healthz` is public; everything under
//! `/v1` requires a valid Rayu access token.

pub mod anthropic;
pub mod credits;
pub mod health;
pub mod meta;
pub mod models;
pub mod proxy;

use std::sync::Arc;

use axum::routing::{any, get, post};
use axum::Router;

use crate::cors::CorsConfig;
use crate::state::AppState;

/// Builds the gateway HTTP handler.
///
/// The layer order below mirrors chi's registration order in Go: RealIP, Recoverer,
/// CORS, then the request log. Axum applies layers bottom-up, so they are listed in
/// reverse.
pub fn router(state: Arc<AppState>) -> Router {
    let cors_cfg = Arc::new(CorsConfig::new(&state.cfg.cors_origins));
    let secret = state.cfg.jwt_secret.clone();

    // Everything in this group requires a valid access token.
    let authed = Router::new()
        .route("/v1/models", get(models::handle_models))
        // Only the heavy STREAMING completions are load-shed (the valve lives inside
        // the handler); the light metadata endpoints stay unlimited.
        .route(
            "/anthropic/v1/messages",
            post(anthropic::handle_anthropic_messages),
        )
        // Token counting is metadata: free, no upstream call, no concurrency slot.
        // Without it the SDK's countTokens() 404s and the client falls back to sending
        // real billed completions to measure its own context.
        .route(
            "/anthropic/v1/messages/count_tokens",
            post(meta::handle_count_tokens),
        )
        // Retired ingress. Kept registered (rather than 404ing) because CLI builds
        // already published may still POST here: they get an actionable 410 plus a log
        // line that tells operators old clients are still in the field.
        .route(
            "/v1/chat/completions",
            post(meta::handle_retired_chat_completions),
        )
        .route("/v1/credits", get(credits::handle_credits))
        // Top-up price quote, served from the live config snapshot so the CLI can
        // price a purchase WITHOUT a backend round trip. Quotes only -- granting
        // credits stays in the backend so there is one write path.
        .route("/v1/credits/topup/quote", get(credits::handle_topup_quote))
        .route("/v1/_whoami", get(meta::handle_whoami))
        .route("/v1/_entitlements", get(meta::handle_entitlements))
        .layer(axum::middleware::from_fn(move |req, next| {
            let secret = secret.clone();
            async move { rayu_core::jwt::middleware(secret, req, next).await }
        }));

    Router::new()
        .route("/healthz", get(health::healthz))
        .merge(authed)
        // The transparent tracking proxy for BYO-key providers. Identity comes from the
        // X-Rayu-Token header (NOT Authorization, which carries the user's upstream
        // provider key to be forwarded), so it lives OUTSIDE the Bearer-auth group.
        .route("/v1/proxy", any(proxy::handle_proxy))
        .layer(axum::middleware::from_fn(crate::middleware::log_requests))
        .layer(axum::middleware::from_fn(move |req, next| {
            let cfg = cors_cfg.clone();
            async move { crate::cors::cors(cfg, req, next).await }
        }))
        // A panic in a handler must not take down the process (and with it every
        // in-flight stream). Mirrors chi's middleware.Recoverer.
        .layer(tower_http::catch_panic::CatchPanicLayer::new())
        .layer(axum::middleware::from_fn(crate::middleware::real_ip))
        .with_state(state)
}
