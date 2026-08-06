//! `GET /healthz` -- the public liveness probe.

use axum::response::Response;
use http::StatusCode;
use serde_json::json;

/// Answers `{"status":"ok"}`.
///
/// Public and unauthenticated, exactly as in Go: the container healthcheck and
/// Caddy both poll it, and neither holds a JWT.
pub async fn healthz() -> Response {
    rayu_core::httpx::write_json(StatusCode::OK, &json!({"status": "ok"}))
}
