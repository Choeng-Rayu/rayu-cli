//! JSON response helpers shared across handlers.
//!
//! Port of the Go gateway's `internal/httpx/httpx.go`. Every envelope here is a
//! contract with the CLI, which matches on `error.type`, `error.rayu_code`, and
//! the top-level `type` discriminator -- so the shapes are reproduced exactly.

use axum::body::Body;
use axum::response::Response;
use http::header::CONTENT_TYPE;
use http::StatusCode;
use serde_json::json;

/// The stable error `type` the CLI matches to render a clean, customer-facing
/// "AI provider temporarily unavailable" message for rayu-hosted models --
/// INSTEAD of leaking the upstream provider's raw error body.
pub const PROVIDER_UNAVAILABLE_TYPE: &str = "provider_unavailable";

/// An upstream-agnostic, customer-safe fallback message for the hosted path.
///
/// The CLI replaces it with its own localized guidance, but this is what any
/// other client -- or a log -- sees: never the upstream provider's raw body.
pub const PROVIDER_UNAVAILABLE_MESSAGE: &str = "The AI provider for this model is temporarily unavailable. Try another (smaller) model or try again later.";

/// The request contains image content but the selected model's `supportsImage`
/// flag is false.
pub const CODE_NO_IMAGE_SUPPORT: &str = "model_no_image_support";
/// The request asks for extended thinking but the selected model's
/// `supportsReasoning` flag is false.
pub const CODE_NO_THINKING_SUPPORT: &str = "model_no_thinking_support";

/// Maps an HTTP status onto the error `type` the CLI expects.
///
/// Port of Go's `httpx.errType`.
pub fn err_type(status: StatusCode) -> &'static str {
    match status {
        StatusCode::UNAUTHORIZED => "authentication_error",
        StatusCode::FORBIDDEN => "permission_error",
        StatusCode::TOO_MANY_REQUESTS => "rate_limit_exceeded",
        StatusCode::BAD_REQUEST => "invalid_request_error",
        _ => "api_error",
    }
}

/// Writes `value` as a JSON response with the given status.
///
/// Go's `json.NewEncoder(w).Encode` appends a trailing newline; reproduced so
/// byte-for-byte body comparisons against the Go gateway succeed.
pub fn write_json(status: StatusCode, value: &serde_json::Value) -> Response {
    let mut body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    body.push(b'\n');
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("static response builder cannot fail")
}

/// Writes an OpenAI-compatible error envelope so the CLI's OpenAI adapter
/// surfaces a sensible message.
pub fn write_error(status: StatusCode, msg: &str) -> Response {
    write_json(
        status,
        &json!({"error": {"message": msg, "type": err_type(status)}}),
    )
}

/// Writes a clean, upstream-agnostic error for the rayu-hosted path so a
/// customer never sees the upstream provider's raw body. A non-positive status
/// defaults to 502.
pub fn write_provider_unavailable(status: StatusCode) -> Response {
    let status = if status.as_u16() == 0 {
        StatusCode::BAD_GATEWAY
    } else {
        status
    };
    write_json(
        status,
        &json!({"error": {
            "message": PROVIDER_UNAVAILABLE_MESSAGE,
            "type": PROVIDER_UNAVAILABLE_TYPE,
        }}),
    )
}

/// Writes a NATIVE Anthropic-format error envelope so the CLI's Anthropic client
/// surfaces `msg` verbatim.
///
/// Used to relay a client-fixable upstream request error (e.g. a 400 "this model
/// does not support image input") with its REAL status, instead of the sanitized
/// `provider_unavailable` 502 -- which the SDK would retry and Cloudflare would
/// render as a generic bad gateway.
pub fn write_anthropic_error(status: StatusCode, msg: &str) -> Response {
    write_json(
        status,
        &json!({
            "type": "error",
            "error": {"type": err_type(status), "message": msg},
        }),
    )
}

/// Writes an Anthropic-format 400 carrying a stable `rayu_code`, for a request
/// the selected model cannot serve (image input or extended thinking).
///
/// 400 is deliberate: this is a client-fixable, PERMANENT condition -- retrying
/// the same request can never succeed, but changing model (or dropping the
/// attachment) will. It is raised BEFORE any credit is charged.
pub fn write_capability_error(code: &str, msg: &str) -> Response {
    write_json(
        StatusCode::BAD_REQUEST,
        &json!({
            "type": "error",
            "error": {
                "type": err_type(StatusCode::BAD_REQUEST),
                "message": msg,
                "rayu_code": code,
            },
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn body_string(resp: Response) -> String {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[test]
    fn err_type_matches_go_mapping() {
        assert_eq!(err_type(StatusCode::UNAUTHORIZED), "authentication_error");
        assert_eq!(err_type(StatusCode::FORBIDDEN), "permission_error");
        assert_eq!(
            err_type(StatusCode::TOO_MANY_REQUESTS),
            "rate_limit_exceeded"
        );
        assert_eq!(err_type(StatusCode::BAD_REQUEST), "invalid_request_error");
        assert_eq!(err_type(StatusCode::BAD_GATEWAY), "api_error");
        assert_eq!(err_type(StatusCode::OK), "api_error");
        assert_eq!(err_type(StatusCode::SERVICE_UNAVAILABLE), "api_error");
    }

    #[tokio::test]
    async fn write_error_shape_and_trailing_newline() {
        let resp = write_error(StatusCode::FORBIDDEN, "account is suspended");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(
            body_string(resp).await,
            "{\"error\":{\"message\":\"account is suspended\",\"type\":\"permission_error\"}}\n"
        );
    }

    #[tokio::test]
    async fn provider_unavailable_shape() {
        let resp = write_provider_unavailable(StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = body_string(resp).await;
        assert!(body.contains("\"type\":\"provider_unavailable\""), "{body}");
        assert!(body.contains(PROVIDER_UNAVAILABLE_MESSAGE), "{body}");
    }

    #[tokio::test]
    async fn anthropic_error_shape() {
        let resp = write_anthropic_error(StatusCode::BAD_REQUEST, "image input unsupported");
        assert_eq!(
            body_string(resp).await,
            "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\
             \"message\":\"image input unsupported\"}}\n"
        );
    }

    #[tokio::test]
    async fn capability_error_carries_rayu_code() {
        let resp = write_capability_error(CODE_NO_IMAGE_SUPPORT, "cannot read images");
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_string(resp).await;
        assert!(
            body.contains("\"rayu_code\":\"model_no_image_support\""),
            "{body}"
        );
        assert!(body.contains("\"type\":\"error\""), "{body}");
    }
}
