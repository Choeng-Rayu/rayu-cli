//! Upstream HTTP: the shared client, the transient-failure retry, multi-key
//! failover, and the usage/error normalization every adapter shares.
//!
//! Port of the Go gateway's `internal/proxy/proxy.go` and `anthropic.go`.

use std::sync::Arc;
use std::time::Duration;

use axum::response::Response;
use http::StatusCode;
use rayu_core::httpx;

use crate::circuitbreaker;

/// Bounds how long the gateway waits for an upstream to send RESPONSE HEADERS
/// before failing the request.
///
/// This is the important one for reliability: it bounds the time from finishing
/// the request to receiving the upstream's headers, WITHOUT limiting how long the
/// (SSE) body then streams. So when an upstream is overloaded and stalls before
/// answering, the gateway fails FAST and returns a clean `provider_unavailable`
/// 502 -- instead of hanging until Cloudflare gives up and substitutes its own
/// "origin_bad_gateway" page, which the customer would then see raw.
///
/// 30s is deliberate: a multi-key provider can fail over across N keys, and each
/// key's request gets its own header timeout, so the WORST case for a full hang is
/// N x 30s. With 3 keys that is 90s -- still under Cloudflare's ~100s origin
/// timeout, so the gateway wins the race and returns the clean 502 first. (The
/// circuit breaker then trips and later requests fail fast, so the slow path is
/// only the first hit of an outage.)
pub const UPSTREAM_RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(30);

/// Retries smooth over sub-second capacity blips so one flaky upstream reply
/// doesn't fail an entire agent turn. A sustained outage still surfaces to the
/// caller (and from there to the CLI's own, more patient backoff).
const MAX_UPSTREAM_RETRIES: u32 = 2;
const RETRY_BASE_DELAY: Duration = Duration::from_millis(250);
const RETRY_MAX_DELAY: Duration = Duration::from_secs(2);

/// The cap applied to an upstream error body before it reaches a log or a client.
const ERR_SNIPPET_MAX: usize = 300;

/// Breaks `completion_tokens` down further.
///
/// `reasoning_tokens` is a SUBSET of `completion_tokens`, not additional to it --
/// providers that report it are showing how much of the completion was
/// chain-of-thought. It exists for observability (so "why did this cost so much"
/// can distinguish a huge-context call from a long-reasoning call); it does not
/// change billing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct CompletionTokensDetails {
    #[serde(default, rename = "reasoning_tokens")]
    pub reasoning_tokens: i64,
}

/// The OpenAI-style prompt-token breakdown.
///
/// `cached_tokens` is how OpenAI (and some DeepSeek-compatible proxies) report the
/// cached prefix -- the alternative to DeepSeek's native
/// `prompt_cache_hit_tokens`. Capturing both conventions is what keeps billing
/// aligned with the provider regardless of which shape a given upstream uses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PromptTokensDetails {
    #[serde(default, rename = "cached_tokens")]
    pub cached_tokens: i64,
}

/// The token accounting a provider returns.
///
/// `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` are DeepSeek's
/// context-cache breakdown of `prompt_tokens`: a cache hit is billed by the
/// provider at a small fraction of a miss because it reuses a previously-processed
/// prefix. They are 0 for providers that don't report caching, and hit+miss ==
/// prompt when they do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Usage {
    #[serde(default, rename = "prompt_tokens")]
    pub prompt_tokens: i64,
    #[serde(default, rename = "completion_tokens")]
    pub completion_tokens: i64,
    #[serde(default, rename = "total_tokens")]
    pub total_tokens: i64,
    #[serde(default, rename = "prompt_cache_hit_tokens")]
    pub prompt_cache_hit_tokens: i64,
    #[serde(default, rename = "prompt_cache_miss_tokens")]
    pub prompt_cache_miss_tokens: i64,
    #[serde(default, rename = "prompt_tokens_details")]
    pub prompt_tokens_details: PromptTokensDetails,
    #[serde(default, rename = "completion_tokens_details")]
    pub completion_tokens_details: CompletionTokensDetails,
}

impl Usage {
    /// The cached (cache-hit) prompt-token count, normalized across the two
    /// provider conventions: DeepSeek's explicit `prompt_cache_hit_tokens` and
    /// OpenAI's `prompt_tokens_details.cached_tokens`.
    ///
    /// 0 when the provider reports no caching. Priced at the cheap cache-read rate.
    pub fn cache_read_tokens(&self) -> i64 {
        if self.prompt_cache_hit_tokens > 0 {
            return self.prompt_cache_hit_tokens;
        }
        if self.prompt_tokens_details.cached_tokens > 0 {
            return self.prompt_tokens_details.cached_tokens;
        }
        0
    }

    /// The uncached (cache-miss) prompt-token count -- the tokens the provider
    /// actually re-processed and charges full price for.
    ///
    /// Prefers the provider's explicit `prompt_cache_miss_tokens`, else derives it
    /// as `prompt_tokens - cache_read` so fresh + cached ALWAYS reconciles to the
    /// provider's authoritative `prompt_tokens` (never billing more or fewer input
    /// tokens than reported). Falls back to the full prompt when no cache is
    /// reported at all -- correct, since the provider gave no discount.
    pub fn fresh_input_tokens(&self) -> i64 {
        if self.prompt_cache_miss_tokens > 0 {
            return self.prompt_cache_miss_tokens;
        }
        let read = self.cache_read_tokens();
        let fresh = self.prompt_tokens - read;
        if fresh > 0 {
            return fresh;
        }
        if read > 0 {
            return 0;
        }
        self.prompt_tokens
    }

    /// Converts to the billing buckets [`crate::credits`] prices.
    pub fn to_credit_usage(self) -> crate::credits::Usage {
        crate::credits::Usage {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            total_tokens: self.total_tokens,
            prompt_cache_hit_tokens: self.cache_read_tokens(),
            prompt_cache_miss_tokens: self.fresh_input_tokens(),
            // DeepSeek/DeepInfra don't report a cache-write count today.
            prompt_cache_write_tokens: 0,
        }
    }
}

/// Extracts a usage object from one OpenAI-style SSE `data:` line, or `None` when
/// the line carries no usage.
///
/// Keeping ONE parser next to the [`Usage`] type it fills is what guarantees both
/// cache conventions stay handled identically for billing, whichever format the
/// request came in as.
pub fn parse_openai_usage_line(line: &[u8]) -> Option<Usage> {
    let s = trim_ascii(line);
    let payload = s.strip_prefix(b"data:")?;
    let payload = trim_ascii(payload);
    if payload.is_empty() || payload == b"[DONE]" {
        return None;
    }
    #[derive(serde::Deserialize)]
    struct Chunk {
        usage: Option<Usage>,
    }
    let chunk: Chunk = serde_json::from_slice(payload).ok()?;
    // A usage object with no total is a placeholder, not a report.
    chunk.usage.filter(|u| u.total_tokens > 0)
}

/// One credential to try, carrying its database id so a failure can be attributed
/// to the KEY that caused it.
///
/// Without the id, a provider's keys are an anonymous blob and "key 2 is rate
/// limited" is unknowable.
#[derive(Debug, Clone, Default)]
pub struct ApiKey {
    pub id: i64,
    pub secret: zeroize::Zeroizing<String>,
}

/// Why a specific key could not serve a request, so the caller can put it on
/// cooldown (429) or take it out of rotation (401/403).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyFailure {
    pub key_id: i64,
    pub status: u16,
    /// The provider's requested wait, when it sent one.
    pub retry_after: Duration,
}

impl KeyFailure {
    /// Whether this failure means "try again later" rather than "this credential is
    /// wrong".
    pub fn rate_limited(&self) -> bool {
        self.status == 429 || self.status == 402
    }
}

/// Called for every key that failed with a rotatable status.
pub type OnKeyFailure = Arc<dyn Fn(KeyFailure) + Send + Sync>;

/// Whether an upstream status is worth an automatic same-request retry.
///
/// 429 is deliberately EXCLUDED: it usually reflects a real per-key/account rate
/// limit that a couple of sub-second retries won't clear, and the response's
/// `Retry-After` is forwarded to the client, which has its own longer backoff loop.
pub fn is_retryable_status(code: u16) -> bool {
    // 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout -- exactly the
    // set Go lists, expressed as a range to satisfy clippy.
    matches!(code, 502..=504)
}

/// Whether an upstream status means "try the next API key": rate limit (429), quota
/// exhausted (402), or auth/permission (401/403) -- the per-key failure classes
/// multi-key rotation is meant to route around.
pub fn is_rotatable_status(code: u16) -> bool {
    matches!(code, 429 | 402 | 401 | 403)
}

/// Whether an upstream 4xx means the REQUEST itself was bad (client-fixable and
/// PERMANENT) rather than a provider-side or transient failure.
///
/// These are relayed with their real status and message so the CLI shows the actual
/// cause (e.g. "this model does not support image input") and does NOT retry a
/// request that can never succeed.
///
/// Auth/quota (401/403/429) and 5xx are deliberately excluded: those are
/// provider-side, may leak provider internals, and/or are legitimately retryable,
/// so they keep the sanitized `provider_unavailable` mapping.
pub fn is_upstream_request_error(status: u16) -> bool {
    matches!(status, 400 | 413 | 422)
}

/// Best-effort extracts a human-readable message from an upstream error body.
///
/// Anthropic and OpenAI both use `{"error":{"message":...}}`; some providers use a
/// top-level `{"message":...}`. Capped for safe relay. Only ever called for a
/// request-content 4xx (see [`is_upstream_request_error`]), whose message describes
/// the REQUEST -- safe to surface -- never provider secrets.
pub fn upstream_error_message(body: &[u8]) -> String {
    #[derive(serde::Deserialize, Default)]
    struct Inner {
        #[serde(default)]
        message: String,
    }
    #[derive(serde::Deserialize, Default)]
    struct Envelope {
        #[serde(default)]
        error: Inner,
        #[serde(default)]
        message: String,
    }
    let Ok(e) = serde_json::from_slice::<Envelope>(body) else {
        return String::new();
    };
    let nested = e.error.message.trim();
    if !nested.is_empty() {
        return cap_err_msg(nested);
    }
    let top = e.message.trim();
    if !top.is_empty() {
        return cap_err_msg(top);
    }
    String::new()
}

fn cap_err_msg(s: &str) -> String {
    if s.len() > ERR_SNIPPET_MAX {
        format!("{}…", &s[..floor_char_boundary(s, ERR_SNIPPET_MAX)])
    } else {
        s.to_string()
    }
}

/// A capped, log-safe rendering of an upstream error body.
pub fn err_snippet(body: &[u8]) -> String {
    let s = String::from_utf8_lossy(trim_ascii(body));
    if s.len() > ERR_SNIPPET_MAX {
        format!("{}…", &s[..floor_char_boundary(&s, ERR_SNIPPET_MAX)])
    } else {
        s.to_string()
    }
}

/// Largest index <= `max` that lands on a char boundary, so slicing a multi-byte
/// body cannot panic. Go slices bytes freely; Rust must not.
fn floor_char_boundary(s: &str, max: usize) -> usize {
    let mut i = max.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn trim_ascii(b: &[u8]) -> &[u8] {
    let start = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(0);
    let end = b
        .iter()
        .rposition(|c| !c.is_ascii_whitespace())
        .map(|i| i + 1)
        .unwrap_or(start);
    &b[start..end]
}

/// The Anthropic-facing relay policy for pre-stream failures.
///
/// A client-fixable request error (400/413/422) keeps its real status and message
/// so the CLI shows the cause and does not retry; anything else becomes the
/// sanitized `provider_unavailable` 502, so a provider's raw body (which may name
/// the provider or carry upgrade URLs) never reaches a customer.
///
/// Every translating adapter must route pre-stream failures through this, so the
/// error contract does not vary by wire format.
pub fn relay_upstream_error(status: u16, body: &[u8]) -> Response {
    if is_upstream_request_error(status) {
        let mut msg = upstream_error_message(body);
        if msg.is_empty() {
            msg = "The request was rejected by the model provider.".into();
        }
        let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
        return httpx::write_anthropic_error(code, &msg);
    }
    httpx::write_provider_unavailable(StatusCode::BAD_GATEWAY)
}

/// Reads an integer-seconds `Retry-After` header, if present.
pub fn retry_after_from(headers: &http::HeaderMap) -> Duration {
    headers
        .get(http::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(Duration::ZERO)
}

/// The backoff before the next attempt.
///
/// Honours an integer-seconds `Retry-After` when present, capped at
/// [`RETRY_MAX_DELAY`] so a large provider-suggested wait doesn't stall the gateway
/// request itself -- the CLI's own retry loop is the right place for longer waits.
fn retry_delay(attempt: u32, headers: &http::HeaderMap) -> Duration {
    let suggested = retry_after_from(headers);
    if !suggested.is_zero() {
        return suggested.min(RETRY_MAX_DELAY);
    }
    let d = RETRY_BASE_DELAY
        .checked_mul(1u32 << attempt.min(16))
        .unwrap_or(RETRY_MAX_DELAY);
    d.min(RETRY_MAX_DELAY)
}

/// Why an upstream call failed before any bytes reached the client.
#[derive(Debug, thiserror::Error)]
pub enum UpstreamError {
    /// The breaker for that host is already open from recent consecutive failures,
    /// so the gateway did not even dial.
    #[error("{ERR_OPEN}", ERR_OPEN = circuitbreaker::ERR_OPEN)]
    CircuitOpen,
    /// A dial/TLS/timeout failure -- no response at all.
    #[error("{0}")]
    Transport(String),
    /// The request could not be built (a bad URL from an admin row).
    #[error("{0}")]
    Build(String),
}

impl UpstreamError {
    /// Whether this is the circuit-open case, which the routes answer as
    /// 503 + `Retry-After: 5` rather than 502.
    pub fn is_circuit_open(&self) -> bool {
        matches!(self, UpstreamError::CircuitOpen)
    }
}

/// The shared upstream client plus its per-host circuit breakers.
///
/// One instance per process: the connection pool and the breaker state are both
/// process-wide concerns (an upstream host being down is not per-request).
pub struct Upstream {
    client: reqwest::Client,
    pub breakers: circuitbreaker::Registry,
}

impl std::fmt::Debug for Upstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Upstream")
    }
}

impl Default for Upstream {
    fn default() -> Self {
        Self::new()
    }
}

impl Upstream {
    /// Builds the shared client.
    ///
    /// No overall timeout: long streams rely on the request being dropped for
    /// cancellation, and only the dial/idle/header phases are bounded.
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(20)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(10))
            .tcp_nodelay(true)
            // Bounds the connect phase; the header phase is bounded separately in
            // `send_once` so it does not also cap the streaming body.
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("the upstream client has no fallible configuration");
        Self {
            client,
            breakers: circuitbreaker::Registry::default(),
        }
    }

    /// The underlying client, for the few callers that need it directly (the
    /// non-stream error probe).
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// Sends one attempt, bounding ONLY the wait for response headers.
    ///
    /// This is the Rust equivalent of Go's `Transport.ResponseHeaderTimeout`, which
    /// reqwest does not expose: `Client::timeout` would cap the whole response
    /// INCLUDING the streaming body, which would truncate every long SSE stream. A
    /// timeout around the `send()` future alone bounds exactly the first-byte wait
    /// and leaves the body unbounded.
    async fn send_once(&self, req: reqwest::Request) -> Result<reqwest::Response, UpstreamError> {
        match tokio::time::timeout(UPSTREAM_RESPONSE_HEADER_TIMEOUT, self.client.execute(req)).await
        {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(e)) => Err(UpstreamError::Transport(e.to_string())),
            Err(_) => Err(UpstreamError::Transport(format!(
                "upstream did not send response headers within {:?}",
                UPSTREAM_RESPONSE_HEADER_TIMEOUT
            ))),
        }
    }

    /// Sends the request built by `build`, retrying up to [`MAX_UPSTREAM_RETRIES`]
    /// times when the upstream responds with a transient status.
    ///
    /// `build` is called fresh for every attempt, because a request body can only be
    /// consumed once.
    ///
    /// A transport-level error is returned immediately WITHOUT retrying: callers
    /// treat that as "upstream unreachable", which is the cue to fail the request
    /// rather than keep the client waiting on a dead upstream.
    ///
    /// Before dialing, checks the breaker for the target host. A transport error, or
    /// exhausting all retries against a still-retryable status, reports a breaker
    /// failure; a response that didn't need every retry reports success -- a clean
    /// 4xx is the upstream working correctly and rejecting the request, not the
    /// upstream being down.
    pub async fn do_with_retry<F>(&self, build: F) -> Result<reqwest::Response, UpstreamError>
    where
        F: Fn() -> Result<reqwest::Request, UpstreamError>,
    {
        // Built once up front purely to learn the target host for the breaker check;
        // `build` is cheap (no I/O) and is called again per attempt below.
        let probe = build()?;
        let host = probe
            .url()
            .host_str()
            .map(|h| match probe.url().port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            })
            .unwrap_or_default();
        drop(probe);

        if !self.breakers.allow(&host) {
            return Err(UpstreamError::CircuitOpen);
        }

        let mut attempt: u32 = 0;
        loop {
            let req = build()?;
            let resp = match self.send_once(req).await {
                Ok(r) => r,
                Err(e) => {
                    self.breakers.failure(&host);
                    return Err(e);
                }
            };

            let status = resp.status().as_u16();
            if attempt >= MAX_UPSTREAM_RETRIES || !is_retryable_status(status) {
                if attempt >= MAX_UPSTREAM_RETRIES && is_retryable_status(status) {
                    // Retries exhausted and the upstream is STILL answering
                    // 502/503/504 -- that's the breaker's signal, distinct from a
                    // single blip the retry already absorbed.
                    self.breakers.failure(&host);
                } else {
                    self.breakers.success(&host);
                }
                return Ok(resp);
            }

            let delay = retry_delay(attempt, resp.headers());
            // Drain and drop the response so the connection returns to the pool.
            drop(resp.bytes().await);
            tokio::time::sleep(delay).await;
            attempt += 1;
        }
    }
    /// Forwards one request verbatim for the BYO-key proxy path.
    ///
    /// Unlike [`Upstream::send_with_failover`] there is no key rotation: the caller's
    /// OWN provider credential is already in `headers`, and the gateway holds no key to
    /// substitute. Retry and the circuit breaker still apply, because a stalled provider
    /// must fail fast rather than hold the client connection open.
    pub async fn forward(
        &self,
        method: &http::Method,
        url: &str,
        headers: http::HeaderMap,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, UpstreamError> {
        self.do_with_retry(|| {
            let mut req = self.client.request(method.clone(), url);
            for (name, value) in headers.iter() {
                req = req.header(name.clone(), value.clone());
            }
            req.body(body.clone())
                .build()
                .map_err(|e| UpstreamError::Build(e.to_string()))
        })
        .await
    }


    /// Sends an upstream request, trying each API key IN ORDER and failing over to
    /// the next when a key returns a rotatable status.
    ///
    /// This is the single place adapters get the gateway's upstream resilience from:
    /// per-host circuit breaker, transient-status retry, and multi-key rotation.
    /// Every wire format therefore behaves identically under provider failure, and
    /// a new adapter cannot accidentally opt out.
    ///
    /// `on_failure` is called for EVERY key that failed with a rotatable status --
    /// including the last one -- so per-key health reflects reality even when no key
    /// succeeded.
    ///
    /// Failover happens BEFORE anything is written to the client, so it is
    /// invisible: the returned response is either a success or the last key's error.
    pub async fn send_with_failover<F>(
        &self,
        keys: &[ApiKey],
        build: F,
        on_failure: Option<&OnKeyFailure>,
    ) -> Result<(reqwest::Response, ApiKey), UpstreamError>
    where
        F: Fn(&str) -> Result<reqwest::Request, UpstreamError>,
    {
        // An empty key list still gets one attempt with an empty secret, so a
        // keyless provider produces the upstream's own 401 rather than a silent
        // gateway error.
        let fallback = [ApiKey::default()];
        let keys: &[ApiKey] = if keys.is_empty() { &fallback } else { keys };

        let mut last_err: Option<UpstreamError> = None;
        let last = keys.len() - 1;

        for (i, key) in keys.iter().enumerate() {
            let attempt = self.do_with_retry(|| build(key.secret.as_str())).await;
            match attempt {
                Err(e) => {
                    let is_last = i == last;
                    last_err = Some(e);
                    if is_last {
                        return Err(last_err.expect("just assigned"));
                    }
                    continue; // transport error -- try the next key
                }
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if is_rotatable_status(status) {
                        if let Some(cb) = on_failure {
                            cb(KeyFailure {
                                key_id: key.id,
                                status,
                                retry_after: retry_after_from(resp.headers()),
                            });
                        }
                        if i < last {
                            // Another key remains: drain this response and fail over.
                            drop(resp.bytes().await);
                            continue;
                        }
                    }
                    return Ok((resp, key.clone()));
                }
            }
        }

        Err(last_err.unwrap_or_else(|| UpstreamError::Transport("no api keys configured".into())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_and_rotatable_status_sets() {
        // Retry only the transient 5xx family; NEVER 429.
        for code in [502, 503, 504] {
            assert!(is_retryable_status(code), "{code} should be retryable");
        }
        for code in [200, 400, 401, 402, 403, 404, 413, 422, 429, 500, 501] {
            assert!(!is_retryable_status(code), "{code} must NOT be retryable");
        }

        // Rotate on the per-key failure classes.
        for code in [429, 402, 401, 403] {
            assert!(is_rotatable_status(code), "{code} should rotate keys");
        }
        for code in [200, 400, 404, 413, 422, 500, 502, 503] {
            assert!(!is_rotatable_status(code), "{code} must NOT rotate keys");
        }

        // Only client-fixable request errors are relayed verbatim.
        for code in [400, 413, 422] {
            assert!(is_upstream_request_error(code), "{code}");
        }
        for code in [401, 403, 404, 429, 500, 502, 503] {
            assert!(!is_upstream_request_error(code), "{code}");
        }
    }

    /// Port of Go's `TestParseOpenAIUsageLine`.
    #[test]
    fn parse_openai_usage_line_table() {
        let cases: &[(&str, &str, bool, i64, i64)] = &[
            (
                "deepseek convention",
                r#"data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}"#,
                true,
                100,
                80,
            ),
            (
                "openai convention",
                r#"data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":60}}}"#,
                true,
                100,
                60,
            ),
            (
                "no cache reported",
                r#"data: {"usage":{"prompt_tokens":7,"completion_tokens":1,"total_tokens":8}}"#,
                true,
                7,
                0,
            ),
            (
                "content delta only",
                r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
                false,
                0,
                0,
            ),
            ("done sentinel", "data: [DONE]", false, 0, 0),
            ("not a data line", "event: message", false, 0, 0),
            ("malformed json", "data: {", false, 0, 0),
            (
                "zero total usage",
                r#"data: {"usage":{"prompt_tokens":0,"total_tokens":0}}"#,
                false,
                0,
                0,
            ),
        ];
        for (name, line, want_some, prompt, cached) in cases {
            let got = parse_openai_usage_line(line.as_bytes());
            assert_eq!(got.is_some(), *want_some, "{name}");
            if let Some(u) = got {
                assert_eq!(u.prompt_tokens, *prompt, "{name} prompt");
                assert_eq!(u.cache_read_tokens(), *cached, "{name} cacheRead");
            }
        }
    }

    /// Port of Go's `TestUsageCacheSplit`. The reconciliation invariant is what
    /// keeps the cost ledger honest.
    #[test]
    fn usage_cache_split() {
        struct Case {
            name: &'static str,
            u: Usage,
            want_read: i64,
            want_fresh: i64,
            reconciles_to: Option<i64>,
        }
        let cases = [
            Case {
                name: "DeepSeek native hit/miss",
                u: Usage {
                    prompt_tokens: 2000,
                    prompt_cache_hit_tokens: 1536,
                    prompt_cache_miss_tokens: 464,
                    ..Default::default()
                },
                want_read: 1536,
                want_fresh: 464,
                reconciles_to: Some(2000),
            },
            Case {
                name: "OpenAI-style cached_tokens",
                u: Usage {
                    prompt_tokens: 2000,
                    prompt_tokens_details: PromptTokensDetails {
                        cached_tokens: 1500,
                    },
                    ..Default::default()
                },
                want_read: 1500,
                want_fresh: 500,
                reconciles_to: Some(2000),
            },
            Case {
                name: "no cache reported -> full prompt is fresh",
                u: Usage {
                    prompt_tokens: 800,
                    ..Default::default()
                },
                want_read: 0,
                want_fresh: 800,
                reconciles_to: None,
            },
            Case {
                name: "all cached (hit present, miss absent) -> fresh 0",
                u: Usage {
                    prompt_tokens: 1000,
                    prompt_cache_hit_tokens: 1000,
                    ..Default::default()
                },
                want_read: 1000,
                want_fresh: 0,
                reconciles_to: None,
            },
            Case {
                name: "native fields win over details",
                u: Usage {
                    prompt_tokens: 3000,
                    prompt_cache_hit_tokens: 2000,
                    prompt_cache_miss_tokens: 1000,
                    prompt_tokens_details: PromptTokensDetails { cached_tokens: 999 },
                    ..Default::default()
                },
                want_read: 2000,
                want_fresh: 1000,
                reconciles_to: None,
            },
        ];
        for c in cases {
            assert_eq!(c.u.cache_read_tokens(), c.want_read, "{} read", c.name);
            assert_eq!(c.u.fresh_input_tokens(), c.want_fresh, "{} fresh", c.name);
            if let Some(total) = c.reconciles_to {
                assert_eq!(
                    c.u.fresh_input_tokens() + c.u.cache_read_tokens(),
                    total,
                    "{}: fresh+read must equal prompt_tokens",
                    c.name
                );
            }
        }
    }

    #[test]
    fn usage_json_parses_both_cache_conventions() {
        let ds: Usage = serde_json::from_str(
            r#"{"prompt_tokens":2000,"completion_tokens":100,"total_tokens":2100,
                "prompt_cache_hit_tokens":1536,"prompt_cache_miss_tokens":464}"#,
        )
        .expect("deepseek shape");
        assert_eq!(ds.cache_read_tokens(), 1536);
        assert_eq!(ds.fresh_input_tokens(), 464);

        let oa: Usage = serde_json::from_str(
            r#"{"prompt_tokens":2000,"completion_tokens":50,
                "prompt_tokens_details":{"cached_tokens":1500}}"#,
        )
        .expect("openai shape");
        assert_eq!(oa.cache_read_tokens(), 1500);
        assert_eq!(oa.fresh_input_tokens(), 500);

        // Unknown fields must not break decoding -- providers add them freely.
        let extra: Usage = serde_json::from_str(
            r#"{"prompt_tokens":10,"total_tokens":10,"something_new":{"a":1}}"#,
        )
        .expect("unknown fields tolerated");
        assert_eq!(extra.prompt_tokens, 10);
    }

    #[test]
    fn upstream_error_message_prefers_nested_then_top_level() {
        assert_eq!(
            upstream_error_message(br#"{"error":{"message":"bad image"}}"#),
            "bad image"
        );
        assert_eq!(
            upstream_error_message(br#"{"message":"top level"}"#),
            "top level"
        );
        // Nested wins.
        assert_eq!(
            upstream_error_message(br#"{"error":{"message":"nested"},"message":"top"}"#),
            "nested"
        );
        // Nothing usable.
        assert_eq!(upstream_error_message(br#"{"error":{}}"#), "");
        assert_eq!(upstream_error_message(b"not json"), "");
        assert_eq!(upstream_error_message(b""), "");
        // Whitespace-only is treated as absent.
        assert_eq!(upstream_error_message(br#"{"message":"   "}"#), "");
    }

    #[test]
    fn error_text_is_capped_at_300_chars() {
        let long = "x".repeat(400);
        let body = format!(r#"{{"message":"{long}"}}"#);
        let msg = upstream_error_message(body.as_bytes());
        assert_eq!(msg.chars().count(), 301, "300 chars plus the ellipsis");
        assert!(msg.ends_with('…'));

        let snippet = err_snippet(long.as_bytes());
        assert_eq!(snippet.chars().count(), 301);
        assert!(snippet.ends_with('…'));

        // A short body is returned untouched, trimmed.
        assert_eq!(err_snippet(b"  brief  "), "brief");
    }

    /// Slicing a multi-byte body at a fixed BYTE offset would panic in Rust where Go
    /// merely produces mojibake. The cap must land on a char boundary.
    #[test]
    fn capping_a_multibyte_body_does_not_panic() {
        let long = "日".repeat(400); // 3 bytes each
        let snippet = err_snippet(long.as_bytes());
        assert!(snippet.ends_with('…'));
        assert!(snippet.len() <= ERR_SNIPPET_MAX + 4);

        let body = format!(r#"{{"message":"{long}"}}"#);
        let msg = upstream_error_message(body.as_bytes());
        assert!(msg.ends_with('…'));
    }

    #[test]
    fn retry_after_parsing() {
        let mut h = http::HeaderMap::new();
        assert_eq!(retry_after_from(&h), Duration::ZERO);
        h.insert(http::header::RETRY_AFTER, "5".parse().unwrap());
        assert_eq!(retry_after_from(&h), Duration::from_secs(5));
        // Non-integer (HTTP-date) forms are ignored, matching Go's Atoi.
        h.insert(
            http::header::RETRY_AFTER,
            "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after_from(&h), Duration::ZERO);
        // Zero and negative are ignored.
        h.insert(http::header::RETRY_AFTER, "0".parse().unwrap());
        assert_eq!(retry_after_from(&h), Duration::ZERO);
    }

    #[test]
    fn retry_delay_backoff_and_cap() {
        let empty = http::HeaderMap::new();
        assert_eq!(retry_delay(0, &empty), Duration::from_millis(250));
        assert_eq!(retry_delay(1, &empty), Duration::from_millis(500));
        assert_eq!(retry_delay(2, &empty), Duration::from_secs(1));
        // Capped at 2s however many attempts.
        assert_eq!(retry_delay(10, &empty), RETRY_MAX_DELAY);

        // An integer Retry-After wins...
        let mut h = http::HeaderMap::new();
        h.insert(http::header::RETRY_AFTER, "1".parse().unwrap());
        assert_eq!(retry_delay(0, &h), Duration::from_secs(1));
        // ...but is still capped, so a provider cannot stall the gateway request.
        h.insert(http::header::RETRY_AFTER, "3600".parse().unwrap());
        assert_eq!(retry_delay(0, &h), RETRY_MAX_DELAY);
    }

    #[test]
    fn key_failure_classification() {
        for status in [429, 402] {
            assert!(
                KeyFailure {
                    key_id: 1,
                    status,
                    retry_after: Duration::ZERO
                }
                .rate_limited(),
                "{status} is a cooldown, not a bad credential"
            );
        }
        for status in [401, 403] {
            assert!(
                !KeyFailure {
                    key_id: 1,
                    status,
                    retry_after: Duration::ZERO
                }
                .rate_limited(),
                "{status} means the credential is wrong"
            );
        }
    }

    #[test]
    fn to_credit_usage_maps_the_normalized_buckets() {
        let u = Usage {
            prompt_tokens: 2000,
            completion_tokens: 300,
            total_tokens: 2300,
            prompt_cache_hit_tokens: 1500,
            prompt_cache_miss_tokens: 500,
            ..Default::default()
        };
        let c = u.to_credit_usage();
        assert_eq!(c.prompt_cache_hit_tokens, 1500);
        assert_eq!(c.prompt_cache_miss_tokens, 500);
        assert_eq!(c.completion_tokens, 300);
        assert_eq!(
            c.prompt_cache_write_tokens, 0,
            "no provider reports cache writes today"
        );
    }
}
