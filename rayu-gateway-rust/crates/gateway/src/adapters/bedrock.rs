//! Serves AWS Bedrock's Anthropic surface
//! (`bedrock-runtime.<region>.amazonaws.com`).
//!
//! Port of the Go gateway's `internal/translate/bedrock.go`.
//!
//! # Why this is a separate format from `anthropic_messages`
//!
//! Bedrock speaks Anthropic Messages, but not at an Anthropic-shaped ENDPOINT.
//! Three differences make it undeliverable by the passthrough adapter, each
//! verified against the live API:
//!
//! * The model id is in the URL, not the body:
//!   `POST /model/{modelId}/invoke` (streaming: `/invoke-with-response-stream`).
//! * The body must carry `anthropic_version` ("anthropic_version: Field required")
//!   and must NOT carry `model` or `stream` ("Extra inputs are not permitted").
//!   Everything else -- system, tools, tool_choice, thinking, temperature, top_p,
//!   stop_sequences, metadata -- is accepted unchanged.
//! * Streaming responses are `application/vnd.amazon.eventstream` frames, not SSE,
//!   so the events must be unwrapped and re-emitted (see
//!   [`super::eventstream`]).
//!
//! Auth is a Bedrock API key as `Authorization: Bearer` (auth scheme `bearer`).
//!
//! Everything else is shared with every other adapter: the same key rotation and
//! failover through [`Upstream::send_with_failover`], and usage parsed into the
//! same buckets so billing is identical to a direct Anthropic provider.

use http::StatusCode;
use serde_json::{json, Value};

use super::anthropic::{usage_from_anthropic_body, AnthropicUsageAccumulator};
use super::eventstream::{bedrock_chunk_event, EventStreamReader};
use super::thinking::strip_prior_turn_thinking;
use super::{Adapter, AdapterRequest, CompleteOutcome};
use crate::providercfg::{self, Route};
use crate::sse::{format_sse_event, EventSink, OnStreamDone, StreamStart};
use crate::upstream::{self, Upstream, Usage};
use rayu_core::httpx;

/// Caps a non-streaming response read, so a misbehaving upstream cannot make the
/// gateway allocate without bound.
const MAX_UPSTREAM_BODY: usize = 8 << 20; // 8 MiB

/// The only value Bedrock accepts for `anthropic_version` on the Anthropic surface
/// (an Anthropic-style date, e.g. `"2023-06-01"`, is rejected with "Invalid API
/// version").
pub const BEDROCK_API_VERSION: &str = "bedrock-2023-05-31";

const BEDROCK_INVOKE_SUFFIX: &str = "/invoke";
const BEDROCK_STREAM_SUFFIX: &str = "/invoke-with-response-stream";

/// The `cache_control` keys Bedrock accepts. Anything else in that object is
/// refused outright.
///
/// Bedrock validates the request body STRICTLY: an unknown field is a 400, not an
/// ignored extra. First-party Anthropic, by contrast, accepts newer
/// `cache_control` options as they ship. `scope` is the live example -- the CLI
/// sends `cache_control:{type:"ephemeral",scope:"global"}` and Bedrock answers
/// `system.1.cache_control.ephemeral.scope: Extra inputs are not permitted`,
/// failing every request.
///
/// Stripping it here is the correct layer: the CLI speaks ONE canonical format and
/// must not know which upstream serves a model, so per-upstream quirks belong in
/// that upstream's adapter. Dropping `scope` costs nothing observable -- it selects
/// a cache partition, so the worst case is a cache miss, never a wrong answer.
const BEDROCK_CACHE_CONTROL_FIELDS: &[&str] = &[
    "type", // "ephemeral" -- the only type
    "ttl",  // "5m" / "1h" -- verified accepted
];

fn is_accepted_cache_control_field(k: &str) -> bool {
    BEDROCK_CACHE_CONTROL_FIELDS.contains(&k)
}

/// Returns `v` with every `cache_control` object reduced to the fields Bedrock
/// accepts, or `None` when nothing needed changing.
///
/// `None` is the copy-on-write signal: an unaffected request is passed through
/// without reallocation, and the caller's value is never mutated (the server still
/// logs and settles billing against it).
pub fn sanitize_for_bedrock(v: &Value) -> Option<Value> {
    match v {
        Value::Object(map) => {
            let mut out: Option<serde_json::Map<String, Value>> = None;
            for (k, ov) in map {
                let replacement = if k == "cache_control" {
                    match ov.as_object() {
                        Some(cc) => trim_cache_control(cc),
                        None => sanitize_for_bedrock(ov),
                    }
                } else {
                    sanitize_for_bedrock(ov)
                };
                if let Some(new_val) = replacement {
                    // First change: copy before writing, so the original is untouched.
                    out.get_or_insert_with(|| map.clone())
                        .insert(k.clone(), new_val);
                }
            }
            out.map(Value::Object)
        }
        Value::Array(items) => {
            let mut out: Option<Vec<Value>> = None;
            for (i, ov) in items.iter().enumerate() {
                if let Some(new_val) = sanitize_for_bedrock(ov) {
                    out.get_or_insert_with(|| items.clone())[i] = new_val;
                }
            }
            out.map(Value::Array)
        }
        _ => None,
    }
}

/// Keeps only the accepted keys, returning `None` when nothing was dropped.
fn trim_cache_control(cc: &serde_json::Map<String, Value>) -> Option<Value> {
    if cc.keys().all(|k| is_accepted_cache_control_field(k)) {
        return None;
    }
    let kept: serde_json::Map<String, Value> = cc
        .iter()
        .filter(|(k, _)| is_accepted_cache_control_field(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    Some(Value::Object(kept))
}

/// Rewrites the canonical Anthropic request into what Bedrock accepts: inject
/// `anthropic_version`, drop the fields it refuses, and reduce `cache_control` to
/// Bedrock's accepted subset.
///
/// The caller's value is not mutated -- the server still needs it for logging and
/// billing.
pub fn bedrock_body(anthropic: &Value) -> Vec<u8> {
    // Bedrock validates thinking signatures, so a block minted by another provider
    // (or synthesised from an OpenAI-style reasoning field) is a hard 400 here.
    let (stripped, _) = strip_prior_turn_thinking(anthropic);
    let mut out = serde_json::Map::new();
    if let Some(map) = stripped.as_object() {
        for (k, v) in map {
            // Carried by the URL / chosen by the endpoint. Sending either is a 400.
            if k == "model" || k == "stream" {
                continue;
            }
            match sanitize_for_bedrock(v) {
                Some(sanitized) => out.insert(k.clone(), sanitized),
                None => out.insert(k.clone(), v.clone()),
            };
        }
    }
    out.insert("anthropic_version".into(), json!(BEDROCK_API_VERSION));
    serde_json::to_vec(&Value::Object(out)).unwrap_or_else(|_| b"{}".to_vec())
}

/// Builds the per-model invoke URL, streaming or not.
pub fn bedrock_url(route: &Route, upstream_model_id: &str, stream: bool) -> String {
    let url = route.endpoint_for(upstream_model_id);
    if !stream {
        return url;
    }
    // Only swap a TRAILING /invoke: an admin who typed the streaming path already
    // (or a future path shape) is left alone rather than silently rewritten.
    match url.strip_suffix(BEDROCK_INVOKE_SUFFIX) {
        Some(base) => format!("{base}{BEDROCK_STREAM_SUFFIX}"),
        None => url,
    }
}

/// Builds the upstream request.
///
/// Bedrock takes the key as a bearer token regardless of the row's auth scheme; the
/// model is already in the URL.
fn new_bedrock_req(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: Vec<u8>,
) -> Result<reqwest::Request, upstream::UpstreamError> {
    let mut req = client
        .post(url)
        .header(http::header::CONTENT_TYPE, "application/json");
    if !api_key.is_empty() {
        req = req.header(http::header::AUTHORIZATION, format!("Bearer {api_key}"));
    }
    req.body(body)
        .build()
        .map_err(|e| upstream::UpstreamError::Build(e.to_string()))
}

/// Pulls the human part out of Bedrock's error body, which is `{"message": "..."}`
/// rather than an Anthropic error envelope.
pub fn bedrock_error_message(raw: &[u8]) -> String {
    #[derive(serde::Deserialize, Default)]
    struct Err {
        #[serde(default)]
        message: String,
    }
    if let Ok(e) = serde_json::from_slice::<Err>(raw) {
        if !e.message.is_empty() {
            return e.message;
        }
    }
    let s = upstream::err_snippet(raw);
    if s.is_empty() {
        "upstream error".to_string()
    } else {
        s
    }
}

/// Reshapes a Bedrock error into the Anthropic error envelope every other provider
/// returns, so one error path serves all formats.
pub fn bedrock_error_to_anthropic(raw: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": bedrock_error_message(raw),
        },
    }))
    .unwrap_or_else(|_| raw.to_vec())
}

/// Reads a response body, capped at [`MAX_UPSTREAM_BODY`].
async fn read_capped(resp: reqwest::Response) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut stream = resp;
    while let Ok(Some(chunk)) = stream.chunk().await {
        let room = MAX_UPSTREAM_BODY.saturating_sub(out.len());
        if room == 0 {
            break;
        }
        let take = chunk.len().min(room);
        out.extend_from_slice(&chunk[..take]);
    }
    out
}

/// The `bedrock_anthropic` adapter.
pub struct BedrockAnthropic;

#[async_trait::async_trait]
impl Adapter for BedrockAnthropic {
    fn format(&self) -> &'static str {
        providercfg::FORMAT_BEDROCK_ANTHROPIC
    }

    async fn stream(
        &self,
        up: &Upstream,
        req: AdapterRequest,
        on_done: OnStreamDone,
    ) -> StreamStart {
        let body = bedrock_body(&req.anthropic);
        let url = bedrock_url(&req.route, &req.upstream_model_id, true);

        let sent = up
            .send_with_failover(
                &req.keys,
                |secret| new_bedrock_req(up.client(), &url, secret, body.clone()),
                req.on_key_failure.as_ref(),
            )
            .await;
        let (resp, _) = match sent {
            Ok(v) => v,
            Err(e) => return StreamStart::Unreachable(e),
        };

        let status = resp.status().as_u16();
        if status != 200 {
            let raw = read_capped(resp).await;
            let error = format!("bedrock status {status}: {}", upstream::err_snippet(&raw));
            // Bedrock's status is PRESERVED rather than masked as 502: the body is
            // already reshaped into an Anthropic envelope, so the client sees the
            // same contract it would from a direct Anthropic provider.
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            return StreamStart::Failed {
                response: httpx::write_anthropic_error(code, &bedrock_error_message(&raw)),
                error,
                usage: None,
            };
        }

        let (sink, response) = EventSink::new_response(req.keepalive_seconds);
        let byte_stream = resp.bytes_stream();

        tokio::spawn(async move {
            let reader = tokio_util::io::StreamReader::new(futures::TryStreamExt::map_err(
                byte_stream,
                std::io::Error::other,
            ));
            let mut frames = EventStreamReader::new(reader);
            let mut usage = AnthropicUsageAccumulator::default();
            let mut sink = sink;

            // Decode frames -> re-emit Anthropic SSE, incrementally: one frame in,
            // one event out. Nothing is buffered, so time-to-first-token is the
            // upstream's, not ours.
            let mut failure: Option<String> = None;
            while let Some(item) = frames.next_frame().await {
                let frame = match item {
                    Ok(f) => f,
                    Err(e) => {
                        // Mid-stream failure: the client already has bytes, so the
                        // stream just ends. The caller logs it and settles billing
                        // for what arrived.
                        failure = Some(e.to_string());
                        break;
                    }
                };
                if !frame.exception_type.is_empty() {
                    // Bedrock signals mid-stream problems (throttling, timeouts) as
                    // a FRAME, not an HTTP status.
                    failure = Some(format!(
                        "bedrock stream error {}: {}",
                        frame.exception_type,
                        upstream::err_snippet(&frame.payload)
                    ));
                    break;
                }
                if frame.event_type != "chunk" {
                    continue; // ignore metadata frames
                }
                let event = match bedrock_chunk_event(&frame.payload) {
                    Ok(e) => e,
                    Err(e) => {
                        failure = Some(e.to_string());
                        break;
                    }
                };
                // Sniff usage BEFORE writing, so a client that hangs up on this very
                // event is still billed for it.
                usage.observe(&event);
                if sink.raw(format_sse_event(&event)).await.is_err() {
                    failure = None; // the client disconnected; not an upstream fault
                    break;
                }
            }
            on_done(usage.usage(), failure);
        });

        StreamStart::Streaming(response)
    }

    async fn complete(&self, up: &Upstream, req: AdapterRequest) -> CompleteOutcome {
        let body = bedrock_body(&req.anthropic);
        let url = bedrock_url(&req.route, &req.upstream_model_id, false);

        let sent = up
            .send_with_failover(
                &req.keys,
                |secret| new_bedrock_req(up.client(), &url, secret, body.clone()),
                req.on_key_failure.as_ref(),
            )
            .await;
        let (resp, _) = match sent {
            Ok(v) => v,
            Err(e) => return CompleteOutcome::unreachable(e.to_string()),
        };

        let status = resp.status().as_u16();
        let raw = read_capped(resp).await;
        if status != 200 {
            // Bedrock reports errors as {"message": "..."} rather than an Anthropic
            // error envelope. Reshape it so the caller's error handling -- and the
            // CLI -- see the one error format they know.
            return CompleteOutcome {
                usage: None,
                status,
                body: bedrock_error_to_anthropic(&raw),
                error: None,
            };
        }
        let usage: Option<Usage> = usage_from_anthropic_body(&raw);
        CompleteOutcome {
            usage,
            status,
            body: raw,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(base: &str) -> Route {
        let (route, err) = providercfg::build(
            providercfg::Row {
                name: "aws".into(),
                format: providercfg::FORMAT_BEDROCK_ANTHROPIC.into(),
                base_url: base.into(),
                auth_scheme: providercfg::AUTH_BEARER.into(),
                enabled: true,
                key_count: 1,
                ..Default::default()
            },
            providercfg::Options {
                allow_insecure: true,
            },
        );
        assert!(err.is_none(), "a valid bedrock route: {err:?}");
        route
    }

    /// REGRESSION: every real CLI request failed with
    /// `system.1.cache_control.ephemeral.scope: Extra inputs are not permitted`.
    /// Bedrock validates the body strictly, so a cache_control option that
    /// first-party Anthropic accepts (here `scope`, which the CLI sends) breaks
    /// EVERY request.
    #[test]
    fn cache_control_fields_bedrock_rejects_are_stripped() {
        let original = json!({
            "model": "us.anthropic.claude-sonnet-4-6",
            "max_tokens": 8,
            "system": [
                {"type": "text", "text": "You are Rayu.",
                 "cache_control": {"type": "ephemeral", "scope": "global"}},
                // ttl IS accepted and must survive: it changes cache lifetime, and
                // silently dropping it would change caching behaviour and cost.
                {"type": "text", "text": "second",
                 "cache_control": {"type": "ephemeral", "ttl": "1h", "scope": "global"}},
            ],
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "hi",
                     "cache_control": {"type": "ephemeral", "scope": "global"}},
                ]},
            ],
            "tools": [
                {"name": "read_file", "description": "Read a file",
                 "cache_control": {"type": "ephemeral", "scope": "global"}},
            ],
            "metadata": {"user_id": "u2"},
        });

        let raw = bedrock_body(&original);
        assert!(
            !String::from_utf8_lossy(&raw).contains("\"scope\""),
            "scope survived into the Bedrock body: {}",
            String::from_utf8_lossy(&raw)
        );

        let sent: Value = serde_json::from_slice(&raw).unwrap();
        let cc0 = sent["system"][0]["cache_control"].as_object().unwrap();
        assert_eq!(cc0.len(), 1, "want only type: {cc0:?}");
        assert_eq!(cc0["type"], "ephemeral");

        let cc1 = sent["system"][1]["cache_control"].as_object().unwrap();
        assert_eq!(cc1.len(), 2, "want type+ttl: {cc1:?}");
        assert_eq!(cc1["ttl"], "1h");

        // Nested containers (messages -> content -> block) and tools are reached.
        assert_eq!(
            sent["messages"][0]["content"][0]["cache_control"]
                .as_object()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            sent["tools"][0]["cache_control"].as_object().unwrap().len(),
            1
        );
        // Untouched fields survive.
        assert_eq!(sent["metadata"]["user_id"], "u2");

        // The caller's value must be unchanged: the server logs and settles billing
        // against this very object after the adapter returns.
        assert_eq!(
            original["system"][0]["cache_control"]["scope"], "global",
            "the request value was mutated"
        );
    }

    /// A request with nothing to strip must be passed through untouched -- no silent
    /// rewriting of a body that was already valid.
    #[test]
    fn a_clean_body_is_left_alone() {
        let input = json!({
            "max_tokens": 4,
            "system": "be brief",
            "messages": [{"role": "user", "content": "hi",
                          "cache_control": {"type": "ephemeral"}}],
        });
        assert!(
            sanitize_for_bedrock(&input).is_none(),
            "a clean body was reported as changed"
        );
        // And a nested ttl-only object is equally clean.
        let input = json!({"a": [{"cache_control": {"type": "ephemeral", "ttl": "5m"}}]});
        assert!(sanitize_for_bedrock(&input).is_none());
    }

    #[test]
    fn the_body_drops_model_and_stream_and_adds_the_version() {
        let sent: Value = serde_json::from_slice(&bedrock_body(&json!({
            "model": "us.anthropic.claude-sonnet-4-6",
            "stream": true,
            "max_tokens": 1,
            "system": "be brief",
            "messages": [{"role": "user", "content": "hi"}],
        })))
        .unwrap();

        assert!(
            sent.get("model").is_none(),
            r#"Bedrock answers 400 "Extra inputs are not permitted" for model"#
        );
        assert!(
            sent.get("stream").is_none(),
            r#"Bedrock answers 400 "Extra inputs are not permitted" for stream"#
        );
        assert_eq!(sent["anthropic_version"], BEDROCK_API_VERSION);
        assert_eq!(sent["system"], "be brief", "everything else must survive");
        assert_eq!(sent["max_tokens"], 1);
    }

    /// Bedrock validates thinking signatures, so prior-turn thinking blocks must be
    /// stripped or a replayed block from another provider is a hard 400.
    #[test]
    fn prior_turn_thinking_is_stripped_before_sending() {
        let sent: Value = serde_json::from_slice(&bedrock_body(&json!({
            "messages": [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "old", "signature": "from-deepseek"},
                    {"type": "text", "text": "answer"},
                ]},
                {"role": "user", "content": "second"},
            ],
        })))
        .unwrap();
        let raw = serde_json::to_string(&sent).unwrap();
        assert!(
            !raw.contains("from-deepseek"),
            "a foreign thinking signature reached Bedrock: {raw}"
        );
        assert!(raw.contains("answer"), "the visible text must survive");
    }

    /// A model id with characters that must not create new path segments.
    #[test]
    fn the_model_id_is_escaped_in_the_url() {
        let r = route("https://bedrock-runtime.us-east-1.amazonaws.com");
        assert_eq!(
            bedrock_url(&r, "anthropic.claude-3-haiku-20240307-v1:0", false),
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1:0/invoke",
            "dots, dashes and colons must pass through unescaped"
        );
        assert!(
            !bedrock_url(&r, "evil/../../admin", false).contains("/../"),
            "a model id was able to traverse the path"
        );
    }

    #[test]
    fn the_streaming_url_swaps_only_a_trailing_invoke() {
        let r = route("https://bedrock-runtime.us-east-1.amazonaws.com");
        assert_eq!(
            bedrock_url(&r, "m", true),
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke-with-response-stream"
        );
        // An admin who already typed the streaming path is left alone.
        let mut custom = r.clone();
        custom.endpoint_path = "/model/{model}/invoke-with-response-stream".into();
        assert_eq!(
            bedrock_url(&custom, "m", true),
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke-with-response-stream"
        );
    }

    #[test]
    fn error_bodies_are_reshaped_into_the_anthropic_envelope() {
        let out = bedrock_error_to_anthropic(
            br#"{"message":"Invocation of model ID x with on-demand throughput isn't supported."}"#,
        );
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["type"], "error");
        assert_eq!(parsed["error"]["type"], "invalid_request_error");
        assert!(parsed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("on-demand throughput"));
    }

    #[test]
    fn error_messages_fall_back_to_a_snippet() {
        assert_eq!(bedrock_error_message(br#"{"message":"boom"}"#), "boom");
        // Not JSON at all: the raw text is the best available reason.
        assert_eq!(
            bedrock_error_message(b"upstream exploded"),
            "upstream exploded"
        );
        // Nothing at all still produces a message rather than an empty string.
        assert_eq!(bedrock_error_message(b""), "upstream error");
        assert_eq!(bedrock_error_message(b"{}"), "{}");
    }
}
