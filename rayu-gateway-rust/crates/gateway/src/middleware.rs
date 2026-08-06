//! Cross-cutting HTTP middleware: client-IP recovery and request logging.
//!
//! Port of the Go gateway's `middleware.RealIP` (chi) and `server.logRequests`.

use std::net::IpAddr;
use std::time::Instant;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use bytes::Buf as _;

/// The client IP recovered from the proxy headers, attached as a request
/// extension. `None` means neither header was present or parseable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealIp(pub Option<IpAddr>);

/// Recovers the client IP from `X-Forwarded-For` / `X-Real-IP`.
///
/// Port of chi's `middleware.RealIP`: `X-Real-IP` wins, otherwise the FIRST
/// entry of `X-Forwarded-For` (the original client; later entries are the proxy
/// chain). Behind Caddy exactly one hop is added, so the first entry is the
/// caller.
pub async fn real_ip(mut req: Request, next: Next) -> Response {
    let ip = req
        .headers()
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            req.headers()
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .and_then(|s| s.parse::<IpAddr>().ok());

    req.extensions_mut().insert(RealIp(ip));
    next.run(req).await
}

/// Logs one line per request: method, path, status, duration, bytes.
///
/// Port of `server.logRequests`. The health probe is skipped so a 10s container
/// healthcheck does not bury the real traffic. Streaming requests log when the
/// stream COMPLETES, so the duration reflects total stream time -- which means
/// the log line is emitted from a wrapper around the response body, not when the
/// handler returns.
pub async fn log_requests(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if path == "/healthz" {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let start = Instant::now();

    let response = next.run(req).await;
    let status = response.status().as_u16();

    // Count the body as it drains so the byte total matches Go's
    // WrapResponseWriter, and so the line lands when the stream ends.
    let (parts, body) = response.into_parts();
    let counted = CountingBody::new(body, move |bytes| {
        tracing::info!(
            "{} {} -> {} ({}, {}B)",
            method,
            path,
            status,
            format_duration(start.elapsed()),
            bytes
        );
    });
    Response::from_parts(parts, axum::body::Body::new(counted))
}

/// Renders a duration the way Go's `time.Duration.Round(time.Millisecond)`
/// prints it: `1.234s`, `567ms`, or `0s`.
fn format_duration(d: std::time::Duration) -> String {
    let millis = d.as_millis();
    if millis >= 1000 {
        let secs = millis / 1000;
        let rem = millis % 1000;
        if rem == 0 {
            return format!("{secs}s");
        }
        // Go prints 1.2s (not 1.200s): trailing zeros of the fraction go away.
        let frac = format!("{rem:03}");
        format!("{secs}.{}s", frac.trim_end_matches('0'))
    } else if millis > 0 {
        format!("{millis}ms")
    } else {
        "0s".to_string()
    }
}

pin_project_lite::pin_project! {
    /// Wraps a body, counting the bytes that flow through it and logging the
    /// request line when the body is dropped.
    ///
    /// Logging from `Drop` rather than from the end of `poll_frame` is
    /// deliberate, for two reasons:
    ///
    ///  * an empty body reports `is_end_stream()` and hyper may never poll it at
    ///    all, so a poll-driven hook silently loses every bodiless response
    ///    (404s, 204s);
    ///  * a client that disconnects mid-stream drops the body without a final
    ///    frame, and that request still has to appear in the log -- which is
    ///    exactly what Go's deferred log line does.
    struct CountingBody<B, F: FnOnce(u64)> {
        #[pin]
        inner: B,
        count: u64,
        on_end: Option<F>,
    }

    impl<B, F: FnOnce(u64)> PinnedDrop for CountingBody<B, F> {
        fn drop(this: Pin<&mut Self>) {
            let this = this.project();
            if let Some(f) = this.on_end.take() {
                f(*this.count);
            }
        }
    }
}

impl<B, F: FnOnce(u64)> CountingBody<B, F> {
    fn new(inner: B, on_end: F) -> Self {
        Self {
            inner,
            count: 0,
            on_end: Some(on_end),
        }
    }
}

impl<B, F> http_body::Body for CountingBody<B, F>
where
    B: http_body::Body,
    F: FnOnce(u64),
{
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        use std::task::Poll;
        let this = self.project();
        match this.inner.poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    *this.count += data.remaining() as u64;
                }
                Poll::Ready(Some(Ok(frame)))
            }
            other => other,
        }
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn duration_format_matches_go_rounding() {
        assert_eq!(format_duration(Duration::from_millis(0)), "0s");
        assert_eq!(format_duration(Duration::from_micros(400)), "0s");
        assert_eq!(format_duration(Duration::from_millis(7)), "7ms");
        assert_eq!(format_duration(Duration::from_millis(567)), "567ms");
        assert_eq!(format_duration(Duration::from_millis(1000)), "1s");
        assert_eq!(format_duration(Duration::from_millis(1234)), "1.234s");
        assert_eq!(format_duration(Duration::from_millis(1200)), "1.2s");
    }

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buf {
        type Writer = Buf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// Drives one request through the logging middleware and returns the captured
    /// log output. The response body is fully drained and dropped, because the log
    /// line is emitted when the body is dropped.
    async fn capture_log(uri: &str, route: &str) -> String {
        use axum::routing::get;
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        let buf = Buf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_target(false)
            .finish();

        let guard = tracing::subscriber::set_default(subscriber);
        let app: axum::Router = axum::Router::new()
            .route(route, get(|| async { "hello" }))
            .layer(axum::middleware::from_fn(log_requests));

        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(uri)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Draining and dropping the body is what triggers the log line.
        let _ = resp.into_body().collect().await.unwrap();
        drop(guard);

        let bytes = buf.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn logs_one_line_per_request_with_status_and_bytes() {
        let out = capture_log("/v1/models", "/v1/models").await;
        assert!(
            out.contains("GET /v1/models -> 200"),
            "missing request line in {out:?}"
        );
        assert!(out.contains("5B"), "byte count wrong in {out:?}");
    }

    /// A bodiless response (404) still has to be logged. An earlier
    /// implementation hooked the end of `poll_frame`, which hyper never reaches
    /// for an empty body -- so every 404 vanished from the log.
    #[tokio::test]
    async fn logs_responses_that_have_no_body() {
        let out = capture_log("/nope", "/v1/models").await;
        assert!(
            out.contains("GET /nope -> 404"),
            "bodiless response was not logged: {out:?}"
        );
    }

    #[tokio::test]
    async fn skips_the_health_probe() {
        let out = capture_log("/healthz", "/healthz").await;
        assert!(out.is_empty(), "health probe should not log: {out:?}");
    }
}
