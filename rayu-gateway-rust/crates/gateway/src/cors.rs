//! The browser CORS contract.
//!
//! Port of the Go gateway's `server.corsMiddleware`.
//!
//! The gateway was built for the CLI, which is not a browser and never
//! preflights. Rayu Studio is a browser client, so these lists are load-bearing:
//! a header missing from `Access-Control-Allow-Headers` makes the browser fail
//! the whole request at preflight, and a header missing from
//! `Access-Control-Expose-Headers` is silently unreadable from JS even though it
//! arrives on the wire.

use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use http::header::{HeaderName, HeaderValue, VARY};
use http::StatusCode;

/// The `Access-Control-Allow-Headers` value sent to browser clients.
///
/// * `Authorization` -- hosted path: the Rayu access JWT. BYO path: the user's
///   OWN upstream provider key (see the proxy handler).
/// * `X-Rayu-Token` -- BYO path identity, because `Authorization` is occupied.
/// * `X-Rayu-Upstream-URL` -- BYO path target (SSRF-validated).
/// * `X-Rayu-Request-Id` / `X-Rayu-Logical-Request-Id` -- correlation plus
///   idempotent daily-turn accounting, so a client's retries of ONE logical
///   request don't each burn a turn.
/// * `X-Rayu-Query-Source` / `X-Rayu-Intended-Model` -- attribution/diagnostics.
/// * `anthropic-version` / `anthropic-beta` -- the hosted endpoint speaks
///   Anthropic Messages, and the Anthropic SDKs set these on every request.
///
/// Anything not listed here is rejected by the browser at preflight, which
/// presents as the whole feature failing rather than one header being dropped.
pub const CORS_ALLOW_HEADERS: &str = "Authorization, Content-Type, \
     X-Rayu-Token, X-Rayu-Upstream-URL, X-Rayu-Request-Id, X-Rayu-Logical-Request-Id, \
     X-Rayu-Query-Source, X-Rayu-Intended-Model, \
     anthropic-version, anthropic-beta";

/// Response headers cross-origin JS is allowed to READ.
///
/// Without this, `fetch()` silently hides them: a browser client could stream a
/// completion but never show the credit balance it just spent, or detect that the
/// model it asked for was substituted. Keep in sync with `set_credit_headers` and
/// the proxy/token-count handlers.
pub const CORS_EXPOSE_HEADERS: &str =
    "x-rayu-credits-used, x-rayu-credits-remaining, x-rayu-topup-balance, \
     x-rayu-limit, x-rayu-model-fidelity, x-rayu-proxied, x-rayu-proxy-error, \
     x-rayu-token-count, x-rayu-request-id";

/// `/v1/proxy` accepts any method, so a BYO-key client may need verbs beyond the
/// hosted endpoints' GET/POST.
pub const CORS_ALLOW_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/// How long a browser may cache the preflight result.
pub const CORS_MAX_AGE: &str = "600";

/// The allow-list, resolved once at boot.
#[derive(Debug, Clone)]
pub struct CorsConfig {
    allow_all: bool,
    allowed: Vec<String>,
}

impl CorsConfig {
    pub fn new(origins: &[String]) -> Self {
        Self {
            allow_all: origins.iter().any(|o| o == "*"),
            allowed: origins.to_vec(),
        }
    }

    /// Whether `origin` may read cross-origin responses.
    fn allows(&self, origin: &str) -> bool {
        self.allow_all || self.allowed.iter().any(|o| o == origin)
    }
}

/// Allows the configured browser origins to call the JWT-protected API.
///
/// Auth is via Bearer token, not cookies, so a wildcard origin is safe here.
///
/// Preflight is answered HERE, before the auth layer runs: browsers never send
/// `Authorization` on an `OPTIONS`, so letting it reach the auth middleware would
/// 401 every preflight.
pub async fn cors(cfg: Arc<CorsConfig>, req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let is_preflight = req.method() == http::Method::OPTIONS;

    // Short-circuit the preflight without touching the inner service.
    let mut response = if is_preflight {
        Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(axum::body::Body::empty())
            .expect("static response")
    } else {
        next.run(req).await
    };

    if !origin.is_empty() && cfg.allows(&origin) {
        let headers = response.headers_mut();
        let pairs: [(HeaderName, &str); 5] = [
            (
                HeaderName::from_static("access-control-allow-origin"),
                origin.as_str(),
            ),
            (
                HeaderName::from_static("access-control-allow-methods"),
                CORS_ALLOW_METHODS,
            ),
            (
                HeaderName::from_static("access-control-allow-headers"),
                CORS_ALLOW_HEADERS,
            ),
            (
                HeaderName::from_static("access-control-expose-headers"),
                CORS_EXPOSE_HEADERS,
            ),
            (
                HeaderName::from_static("access-control-max-age"),
                CORS_MAX_AGE,
            ),
        ];
        for (name, value) in pairs {
            if let Ok(v) = HeaderValue::from_str(value) {
                headers.insert(name, v);
            }
        }
        headers.insert(VARY, HeaderValue::from_static("Origin"));
    }

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tower::ServiceExt;

    /// Parses a comma-separated header value into a lowercase set, mirroring how
    /// a browser compares the allow-list (case-insensitively).
    fn split_header_list(v: &str) -> HashSet<String> {
        v.split(',')
            .map(|p| p.trim().to_ascii_lowercase())
            .filter(|p| !p.is_empty())
            .collect()
    }

    fn app(origins: &[&str]) -> axum::Router {
        let cfg = Arc::new(CorsConfig::new(
            &origins.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        ));
        axum::Router::new()
            .route("/v1/models", get(|| async { "ok" }).post(|| async { "ok" }))
            .route("/anthropic/v1/messages", post(|| async { "ok" }))
            .layer(axum::middleware::from_fn(move |req, next| {
                let cfg = cfg.clone();
                async move { cors(cfg, req, next).await }
            }))
    }

    async fn send(
        app: axum::Router,
        method: http::Method,
        uri: &str,
        origin: Option<&str>,
    ) -> Response {
        let mut builder = axum::http::Request::builder().method(method).uri(uri);
        if let Some(o) = origin {
            builder = builder.header("Origin", o);
        }
        app.oneshot(builder.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn allows_studio_request_headers() {
        let resp = send(
            app(&["https://rayucode.com"]),
            http::Method::OPTIONS,
            "/anthropic/v1/messages",
            Some("https://rayucode.com"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let got = split_header_list(
            resp.headers()
                .get("access-control-allow-headers")
                .unwrap()
                .to_str()
                .unwrap(),
        );
        for h in [
            "authorization",
            "content-type",
            "x-rayu-token",
            "x-rayu-upstream-url",
            "x-rayu-request-id",
            "x-rayu-logical-request-id",
            "x-rayu-query-source",
            "x-rayu-intended-model",
            "anthropic-version",
            "anthropic-beta",
        ] {
            assert!(
                got.contains(h),
                "Access-Control-Allow-Headers missing {h:?} (browser would fail preflight)"
            );
        }
    }

    #[tokio::test]
    async fn exposes_credit_headers() {
        let resp = send(
            app(&["https://rayucode.com"]),
            http::Method::POST,
            "/anthropic/v1/messages",
            Some("https://rayucode.com"),
        )
        .await;
        let got = split_header_list(
            resp.headers()
                .get("access-control-expose-headers")
                .unwrap()
                .to_str()
                .unwrap(),
        );
        for h in [
            "x-rayu-credits-used",
            "x-rayu-credits-remaining",
            "x-rayu-topup-balance",
            "x-rayu-model-fidelity",
            "x-rayu-proxy-error",
            "x-rayu-token-count",
            "x-rayu-limit",
            "x-rayu-proxied",
            "x-rayu-request-id",
        ] {
            assert!(
                got.contains(h),
                "Access-Control-Expose-Headers missing {h:?} (unreadable from JS)"
            );
        }
    }

    /// A browser never attaches `Authorization` to an `OPTIONS`. If the preflight
    /// reached the authenticated group it would 401 and the request would never be
    /// made, so the middleware must answer `OPTIONS` itself.
    #[tokio::test]
    async fn preflight_short_circuits_before_the_handler() {
        static CALLED: AtomicBool = AtomicBool::new(false);
        CALLED.store(false, Ordering::SeqCst);

        let cfg = Arc::new(CorsConfig::new(&["https://rayucode.com".to_string()]));
        let app = axum::Router::new()
            .route(
                "/anthropic/v1/messages",
                post(|| async {
                    CALLED.store(true, Ordering::SeqCst);
                    "ok"
                }),
            )
            .layer(axum::middleware::from_fn(move |req, next| {
                let cfg = cfg.clone();
                async move { cors(cfg, req, next).await }
            }));

        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .method(http::Method::OPTIONS)
                    .uri("/anthropic/v1/messages")
                    .header("Origin", "https://rayucode.com")
                    .header("Access-Control-Request-Method", "POST")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert!(
            !CALLED.load(Ordering::SeqCst),
            "preflight reached the next handler; it must short-circuit before auth"
        );
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn disallowed_origin_gets_no_headers() {
        let resp = send(
            app(&["https://rayucode.com"]),
            http::Method::POST,
            "/v1/models",
            Some("https://evil.example"),
        )
        .await;
        assert!(resp.headers().get("access-control-allow-origin").is_none());
        assert!(resp
            .headers()
            .get("access-control-expose-headers")
            .is_none());
    }

    #[tokio::test]
    async fn wildcard_echoes_the_origin() {
        let resp = send(
            app(&["*"]),
            http::Method::POST,
            "/v1/models",
            Some("https://anything.example"),
        )
        .await;
        assert_eq!(
            resp.headers().get("access-control-allow-origin").unwrap(),
            "https://anything.example"
        );
        assert_eq!(resp.headers().get(VARY).unwrap(), "Origin");
    }

    /// The CLI sends no `Origin`. It must pass through with no CORS headers.
    #[tokio::test]
    async fn no_origin_is_untouched() {
        let resp = send(
            app(&["https://rayucode.com"]),
            http::Method::POST,
            "/v1/models",
            None,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().get("access-control-allow-origin").is_none());
    }

    #[tokio::test]
    async fn max_age_is_ten_minutes() {
        let resp = send(
            app(&["*"]),
            http::Method::OPTIONS,
            "/v1/models",
            Some("https://x.example"),
        )
        .await;
        assert_eq!(resp.headers().get("access-control-max-age").unwrap(), "600");
        assert_eq!(
            resp.headers()
                .get("access-control-allow-methods")
                .unwrap()
                .to_str()
                .unwrap(),
            "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        );
    }
}
