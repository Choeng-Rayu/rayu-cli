//! The `anthropic_messages` adapter: providers that already speak Anthropic
//! Messages (DeepSeek's `/anthropic` endpoint, LongCat, Ollama Cloud, first-party
//! Anthropic).
//!
//! Port of the Go gateway's `internal/translate/anthropic.go` plus the Anthropic
//! half of `internal/proxy/anthropic.go`.
//!
//! It deliberately does NOT translate: the request is forwarded as-is (apart from
//! dropping completed turns' thinking blocks -- see [`super::thinking`]) and the SSE
//! response is relayed BYTE-FOR-BYTE, with usage sniffed off the stream as it
//! passes. That keeps the most-used path at zero marshalling cost and guarantees the
//! client sees exactly what the provider sent -- no field can be dropped or
//! reshaped by a translation layer.

use axum::response::Response;
use http::StatusCode;
use serde_json::Value;

use super::{Adapter, AdapterRequest, CompleteOutcome};
use crate::providercfg;
use crate::sse::{EventSink, OnStreamDone, SseError, SseScanner, StreamStart};
use crate::upstream::{self, Upstream, UpstreamError, Usage};

/// The Anthropic `usage` object.
///
/// `input_tokens` is the FRESH (uncached) input; cache read/creation are separate --
/// the same convention the CLI already uses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
struct AnthropicUsageJson {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

impl AnthropicUsageJson {
    /// Maps the Anthropic buckets onto the internal billing struct so the
    /// cache-aware credit path prices them correctly: fresh input goes to the
    /// cache-miss bucket (full input rate), `cache_read` to the cache-hit bucket
    /// (discounted).
    ///
    /// `cache_creation` is folded into the MISS bucket: it bills at the input rate,
    /// which equals the default cache-write rate, and DeepSeek reports it as 0
    /// regardless.
    fn to_usage(self) -> Usage {
        let prompt =
            self.input_tokens + self.cache_read_input_tokens + self.cache_creation_input_tokens;
        Usage {
            prompt_tokens: prompt,
            completion_tokens: self.output_tokens,
            total_tokens: prompt + self.output_tokens,
            prompt_cache_hit_tokens: self.cache_read_input_tokens,
            prompt_cache_miss_tokens: self.input_tokens + self.cache_creation_input_tokens,
            ..Default::default()
        }
    }
}

/// Collects usage across the events of one Anthropic stream.
///
/// Anthropic splits it: `message_start` carries the input buckets, `message_delta`
/// carries the cumulative output.
///
/// Public because not every Anthropic stream arrives as SSE -- Bedrock delivers the
/// same events inside AWS event-stream frames, and billing must be identical for
/// both, which means one implementation.
#[derive(Debug, Default)]
pub struct AnthropicUsageAccumulator {
    acc: AnthropicUsageJson,
    /// Distinguishes "no usage reported" from "reported zero", which the caller
    /// needs in order to log "(no usage reported)" rather than billing zero.
    seen: bool,
}

impl AnthropicUsageAccumulator {
    /// Feeds one event body (the JSON that would follow `data:`).
    pub fn observe(&mut self, event_json: &[u8]) {
        let (u, has_in, has_out) = parse_anthropic_event_usage(event_json);
        if !has_in && !has_out {
            return;
        }
        self.seen = true;
        if has_in {
            self.acc.input_tokens = u.input_tokens;
            self.acc.cache_read_input_tokens = u.cache_read_input_tokens;
            self.acc.cache_creation_input_tokens = u.cache_creation_input_tokens;
        }
        if has_out {
            // Cumulative; the latest event wins.
            self.acc.output_tokens = u.output_tokens;
        }
    }

    /// The accumulated usage, or `None` when the stream reported none.
    pub fn usage(&self) -> Option<Usage> {
        if !self.seen {
            return None;
        }
        Some(self.acc.to_usage())
    }
}

/// Extracts usage from one Anthropic event body, reporting which fields it found.
fn parse_anthropic_event_usage(payload: &[u8]) -> (AnthropicUsageJson, bool, bool) {
    let none = (AnthropicUsageJson::default(), false, false);
    if payload.is_empty() || payload == b"[DONE]" {
        return none;
    }
    #[derive(serde::Deserialize)]
    struct Message {
        usage: Option<AnthropicUsageJson>,
    }
    #[derive(serde::Deserialize)]
    struct Event {
        #[serde(rename = "type")]
        ty: Option<String>,
        message: Option<Message>,
        usage: Option<AnthropicUsageJson>,
    }
    let Ok(ev) = serde_json::from_slice::<Event>(payload) else {
        return none;
    };
    match ev.ty.as_deref() {
        Some("message_start") => match ev.message.and_then(|m| m.usage) {
            // message_start carries the input buckets AND an initial output count.
            Some(u) => (u, true, true),
            None => none,
        },
        Some("message_delta") => match ev.usage {
            Some(u) => (u, false, true),
            None => none,
        },
        _ => none,
    }
}

/// Parses usage from a NON-streaming Anthropic response body.
pub fn usage_from_anthropic_body(body: &[u8]) -> Option<Usage> {
    #[derive(serde::Deserialize)]
    struct Body {
        usage: Option<AnthropicUsageJson>,
    }
    serde_json::from_slice::<Body>(body)
        .ok()?
        .usage
        .map(|u| u.to_usage())
}

/// Builds an upstream request authenticated per the provider's scheme.
///
/// `bearer == true` sends `Authorization: Bearer <key>` (LongCat); otherwise
/// `x-api-key: <key>` (Anthropic-standard / DeepSeek).
fn new_anthropic_req(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    bearer: bool,
    body: Vec<u8>,
    accept_sse: bool,
) -> Result<reqwest::Request, UpstreamError> {
    let mut req = client
        .post(url)
        .header(http::header::CONTENT_TYPE, "application/json")
        .header("anthropic-version", "2023-06-01");
    req = if bearer {
        req.header(http::header::AUTHORIZATION, format!("Bearer {api_key}"))
    } else {
        req.header("x-api-key", api_key)
    };
    if accept_sse {
        req = req.header(http::header::ACCEPT, "text/event-stream");
    }
    req.body(body)
        .build()
        .map_err(|e| UpstreamError::Build(e.to_string()))
}

/// Re-issues an errored request in NON-streaming mode to recover a real error body.
///
/// Some providers return a bodyless error on their streaming endpoint for conditions
/// their non-streaming endpoint reports properly (LongCat: out-of-credits gives an
/// empty HTTP 500 when streaming, but HTTP 402 plus a clear message non-streaming).
///
/// Best-effort: returns `None` on any failure so the caller keeps the original
/// response. Only invoked on a pre-flight streaming error (nothing written to the
/// client yet), so the extra request is safe.
async fn probe_non_stream_error(
    up: &Upstream,
    url: &str,
    api_key: &str,
    bearer: bool,
    stream_body: &[u8],
) -> Option<(Vec<u8>, u16)> {
    let mut m: Value = serde_json::from_slice(stream_body).ok()?;
    m["stream"] = Value::Bool(false);
    let nb = serde_json::to_vec(&m).ok()?;
    let req = new_anthropic_req(up.client(), url, api_key, bearer, nb, false).ok()?;
    let resp = up.client().execute(req).await.ok()?;
    let status = resp.status().as_u16();
    let body = resp.bytes().await.ok()?;
    if body.iter().all(|b| b.is_ascii_whitespace()) {
        return None;
    }
    Some((body.to_vec(), status))
}

/// Serves providers that already speak Anthropic Messages.
pub struct AnthropicPassthrough;

#[async_trait::async_trait]
impl Adapter for AnthropicPassthrough {
    fn format(&self) -> &'static str {
        providercfg::FORMAT_ANTHROPIC_MESSAGES
    }

    async fn stream(
        &self,
        up: &Upstream,
        req: AdapterRequest,
        on_done: OnStreamDone,
    ) -> StreamStart {
        // Drop completed turns' thinking blocks: their signatures belong to whatever
        // model answered then, which is not necessarily this one.
        let (anth, _) = super::thinking::strip_prior_turn_thinking(&req.anthropic);
        let body = match serde_json::to_vec(&anth) {
            Ok(b) => b,
            Err(e) => return StreamStart::Unreachable(UpstreamError::Build(e.to_string())),
        };
        let url = req.route.endpoint();
        let bearer = req.route.bearer();

        let sent = up
            .send_with_failover(
                &req.keys,
                |secret| new_anthropic_req(up.client(), &url, secret, bearer, body.clone(), true),
                req.on_key_failure.as_ref(),
            )
            .await;

        let (resp, used_key) = match sent {
            Ok(v) => v,
            Err(e) => return StreamStart::Unreachable(e),
        };

        let status = resp.status().as_u16();
        if status != 200 {
            let raw = resp.bytes().await.unwrap_or_default();
            let mut body_bytes = raw.to_vec();
            let mut status = status;
            // Best-effort: recover a real reason from a BODYLESS streaming error so
            // the SERVER LOG shows the true cause. The CLIENT is still sent a
            // sanitized, upstream-agnostic error below.
            if body_bytes.iter().all(|b| b.is_ascii_whitespace()) {
                if let Some((pb, ps)) =
                    probe_non_stream_error(up, &url, used_key.secret.as_str(), bearer, &body).await
                {
                    body_bytes = pb;
                    status = ps;
                }
            }
            let error = format!(
                "upstream status {status}: {}",
                upstream::err_snippet(&body_bytes)
            );
            return StreamStart::Failed {
                response: upstream::relay_upstream_error(status, &body_bytes),
                error,
                usage: None,
            };
        }

        // 200: relay the bytes verbatim while sniffing usage as they pass.
        let (mut sink, response) = EventSink::new_response(req.keepalive_seconds);
        let byte_stream = resp.bytes_stream();
        tokio::spawn(async move {
            let reader = tokio_util::io::StreamReader::new(futures::TryStreamExt::map_err(
                byte_stream,
                std::io::Error::other,
            ));
            let mut scanner = SseScanner::new(reader);
            let mut acc = AnthropicUsageAccumulator::default();
            let mut failure: Option<String> = None;

            while let Some(line) = scanner.next_line().await {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        failure = Some(e.to_string());
                        break;
                    }
                };
                // Sniff before writing, so usage survives a client disconnect on the
                // very next write.
                if let Some(payload) = super::anthropic::data_payload(&line) {
                    acc.observe(&payload);
                }
                if let Err(e) = sink.raw(bytes::Bytes::from(line)).await {
                    // The client hung up. Billing still settles for what arrived.
                    if !matches!(e, SseError::Disconnected) {
                        failure = Some(e.to_string());
                    }
                    break;
                }
            }
            on_done(acc.usage(), failure);
        });

        StreamStart::Streaming(response)
    }

    async fn complete(&self, up: &Upstream, req: AdapterRequest) -> CompleteOutcome {
        let (anth, _) = super::thinking::strip_prior_turn_thinking(&req.anthropic);
        let body = match serde_json::to_vec(&anth) {
            Ok(b) => b,
            Err(e) => return CompleteOutcome::unreachable(e.to_string()),
        };
        let url = req.route.endpoint();
        let bearer = req.route.bearer();

        let sent = up
            .send_with_failover(
                &req.keys,
                |secret| new_anthropic_req(up.client(), &url, secret, bearer, body.clone(), false),
                req.on_key_failure.as_ref(),
            )
            .await;
        let (resp, _) = match sent {
            Ok(v) => v,
            Err(e) => return CompleteOutcome::unreachable(e.to_string()),
        };

        let status = resp.status().as_u16();
        let raw = resp.bytes().await.unwrap_or_default().to_vec();
        let usage = if status == StatusCode::OK.as_u16() {
            usage_from_anthropic_body(&raw)
        } else {
            None
        };
        CompleteOutcome {
            usage,
            status,
            body: raw,
            error: None,
        }
    }
}

/// Extracts a `data:` payload from a raw relayed line, for usage sniffing.
pub(crate) fn data_payload(line: &[u8]) -> Option<Vec<u8>> {
    let trimmed = {
        let start = line
            .iter()
            .position(|c| !c.is_ascii_whitespace())
            .unwrap_or(0);
        let end = line
            .iter()
            .rposition(|c| !c.is_ascii_whitespace())
            .map(|i| i + 1)
            .unwrap_or(start);
        &line[start..end]
    };
    let rest = trimmed.strip_prefix(b"data:")?;
    let start = rest
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(0);
    let payload = &rest[start..];
    if payload.is_empty() {
        return None;
    }
    Some(payload.to_vec())
}

/// Shared by the callers that need to send an unreachable-upstream response.
///
/// A circuit-open means the gateway did not even dial, so it answers fast with 503
/// plus `Retry-After`; anything else keeps the 502 "we tried and it didn't answer"
/// semantics. Never leaks the upstream body.
pub fn write_upstream_error(err: &UpstreamError) -> Response {
    if err.is_circuit_open() {
        let mut resp =
            rayu_core::httpx::write_provider_unavailable(StatusCode::SERVICE_UNAVAILABLE);
        resp.headers_mut().insert(
            http::header::RETRY_AFTER,
            http::HeaderValue::from_static("5"),
        );
        return resp;
    }
    rayu_core::httpx::write_provider_unavailable(StatusCode::BAD_GATEWAY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_accumulator_splits_message_start_and_delta() {
        let mut acc = AnthropicUsageAccumulator::default();
        assert!(acc.usage().is_none(), "nothing observed yet");

        // message_start carries the input buckets and an initial output count.
        acc.observe(
            br#"{"type":"message_start","message":{"usage":{"input_tokens":100,
                "output_tokens":1,"cache_read_input_tokens":900,
                "cache_creation_input_tokens":0}}}"#,
        );
        let u = acc.usage().expect("usage after message_start");
        assert_eq!(u.prompt_tokens, 1000, "input + cacheRead + cacheCreation");
        assert_eq!(u.prompt_cache_hit_tokens, 900);
        assert_eq!(u.prompt_cache_miss_tokens, 100);
        assert_eq!(u.completion_tokens, 1);

        // message_delta carries the CUMULATIVE output; the latest wins.
        acc.observe(br#"{"type":"message_delta","usage":{"output_tokens":40}}"#);
        acc.observe(br#"{"type":"message_delta","usage":{"output_tokens":250}}"#);
        let u = acc.usage().expect("usage");
        assert_eq!(u.completion_tokens, 250, "cumulative, latest wins");
        // The input buckets are untouched by a delta.
        assert_eq!(u.prompt_cache_hit_tokens, 900);
        assert_eq!(u.total_tokens, 1000 + 250);
    }

    /// `seen` must distinguish "no usage reported" from "reported zero", because the
    /// caller logs those differently and must not bill a zero it invented.
    #[test]
    fn accumulator_distinguishes_absent_usage_from_zero() {
        let mut none = AnthropicUsageAccumulator::default();
        none.observe(br#"{"type":"content_block_delta","delta":{"text":"hi"}}"#);
        none.observe(b"[DONE]");
        none.observe(b"not json");
        none.observe(b"");
        assert!(none.usage().is_none(), "no usage event was seen");

        let mut zero = AnthropicUsageAccumulator::default();
        zero.observe(
            br#"{"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}"#,
        );
        let u = zero.usage().expect("a reported zero IS usage");
        assert_eq!(u.prompt_tokens, 0);
        assert_eq!(u.total_tokens, 0);
    }

    #[test]
    fn cache_creation_folds_into_the_miss_bucket() {
        let mut acc = AnthropicUsageAccumulator::default();
        acc.observe(
            br#"{"type":"message_start","message":{"usage":{"input_tokens":500,
                "output_tokens":0,"cache_read_input_tokens":100,
                "cache_creation_input_tokens":400}}}"#,
        );
        let u = acc.usage().unwrap();
        assert_eq!(u.prompt_tokens, 1000);
        assert_eq!(u.prompt_cache_hit_tokens, 100);
        assert_eq!(
            u.prompt_cache_miss_tokens, 900,
            "cache_creation bills at the input rate, so it joins the miss bucket"
        );
    }

    #[test]
    fn non_streaming_usage_is_parsed_from_the_body() {
        let u = usage_from_anthropic_body(
            br#"{"id":"msg_1","type":"message","usage":{"input_tokens":10,
                "output_tokens":20,"cache_read_input_tokens":5}}"#,
        )
        .expect("usage");
        assert_eq!(u.prompt_tokens, 15);
        assert_eq!(u.completion_tokens, 20);
        assert_eq!(u.cache_read_tokens(), 5);
        assert_eq!(u.fresh_input_tokens(), 10);

        assert!(usage_from_anthropic_body(br#"{"id":"msg_1"}"#).is_none());
        assert!(usage_from_anthropic_body(b"not json").is_none());
    }

    #[test]
    fn data_payload_extraction() {
        assert_eq!(
            data_payload(b"data: {\"a\":1}\n").as_deref(),
            Some(&b"{\"a\":1}"[..])
        );
        assert_eq!(
            data_payload(b"data:{\"a\":1}\r\n").as_deref(),
            Some(&b"{\"a\":1}"[..])
        );
        assert!(data_payload(b"event: message_start\n").is_none());
        assert!(data_payload(b"\n").is_none());
        assert!(data_payload(b"data: \n").is_none());
    }

    #[test]
    fn anthropic_request_headers() {
        let client = reqwest::Client::new();
        // x-api-key is the Anthropic-standard scheme.
        let req = new_anthropic_req(
            &client,
            "https://api.deepseek.com/anthropic/v1/messages",
            "sk-1",
            false,
            b"{}".to_vec(),
            true,
        )
        .expect("build");
        assert_eq!(req.headers().get("x-api-key").unwrap(), "sk-1");
        assert_eq!(
            req.headers().get("anthropic-version").unwrap(),
            "2023-06-01"
        );
        assert_eq!(
            req.headers().get(http::header::ACCEPT).unwrap(),
            "text/event-stream"
        );
        assert!(req.headers().get(http::header::AUTHORIZATION).is_none());

        // bearer is what LongCat wants.
        let req = new_anthropic_req(
            &client,
            "https://api.longcat.chat/anthropic/v1/messages",
            "sk-2",
            true,
            b"{}".to_vec(),
            false,
        )
        .expect("build");
        assert_eq!(
            req.headers().get(http::header::AUTHORIZATION).unwrap(),
            "Bearer sk-2"
        );
        assert!(req.headers().get("x-api-key").is_none());
        assert!(
            req.headers().get(http::header::ACCEPT).is_none(),
            "Accept: text/event-stream is set only for streaming"
        );
    }

    #[test]
    fn upstream_error_responses_distinguish_circuit_open() {
        let open = write_upstream_error(&UpstreamError::CircuitOpen);
        assert_eq!(open.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(open.headers().get(http::header::RETRY_AFTER).unwrap(), "5");

        let dead = write_upstream_error(&UpstreamError::Transport("dial failed".into()));
        assert_eq!(dead.status(), StatusCode::BAD_GATEWAY);
        assert!(dead.headers().get(http::header::RETRY_AFTER).is_none());
    }
}
