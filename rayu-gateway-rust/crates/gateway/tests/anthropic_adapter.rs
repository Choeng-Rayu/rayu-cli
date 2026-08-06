//! End-to-end tests for the `anthropic_messages` passthrough adapter.
//!
//! The passthrough's whole promise is that the client sees EXACTLY what the
//! provider sent. That is a byte-level claim, so these tests assert bytes: a
//! captured DeepSeek-shaped SSE stream goes in, and the same bytes must come out
//! while usage is sniffed off the wire for billing.

use std::sync::{Arc, Mutex};

use http_body_util::BodyExt;
use rayu_gateway_lib::adapters::{Adapter, AdapterRequest};
use rayu_gateway_lib::providercfg::{self, Route};
use rayu_gateway_lib::sse::StreamStart;
use rayu_gateway_lib::upstream::{ApiKey, Upstream, Usage};
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A realistic Anthropic SSE stream: usage split across `message_start` and the
/// final `message_delta`, exactly as DeepSeek's `/anthropic` surface sends it.
const CAPTURED_STREAM: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_up_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"deepseek-chat\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":120,\"output_tokens\":1,\"cache_read_input_tokens\":880,\"cache_creation_input_tokens\":0}}}\n\
\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\
\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\
\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":42}}\n\
\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\
\n";

fn route(uri: &str) -> Route {
    Route {
        name: "deepseek".into(),
        format: providercfg::FORMAT_ANTHROPIC_MESSAGES.into(),
        base_url: uri.to_string(),
        endpoint_path: "/anthropic/v1/messages".into(),
        auth_scheme: providercfg::AUTH_X_API_KEY.into(),
        key_count: 1,
        enabled: true,
    }
}

fn request(uri: &str, stream: bool) -> AdapterRequest {
    AdapterRequest {
        route: route(uri),
        keys: vec![ApiKey {
            id: 1,
            secret: zeroize::Zeroizing::new("sk-test".into()),
        }],
        on_key_failure: None,
        upstream_model_id: "deepseek-chat".into(),
        anthropic: serde_json::json!({
            "model": "deepseek-chat",
            "stream": stream,
            "messages": [{"role": "user", "content": "hi"}],
        }),
        stream,
        keepalive_seconds: 0,
    }
}

/// Captures whatever the settle callback receives.
type Settled = Arc<Mutex<Option<(Option<Usage>, Option<String>)>>>;

fn settle_recorder() -> (rayu_gateway_lib::sse::OnStreamDone, Settled) {
    let seen: Settled = Arc::new(Mutex::new(None));
    let sink = seen.clone();
    (
        Box::new(move |u, e| *sink.lock().unwrap() = Some((u, e))),
        seen,
    )
}

async fn wait_for_settle(seen: &Settled) -> (Option<Usage>, Option<String>) {
    for _ in 0..200 {
        if let Some(v) = seen.lock().unwrap().clone() {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the settle callback never ran");
}

#[tokio::test]
async fn the_relay_is_byte_identical_and_usage_is_sniffed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(CAPTURED_STREAM),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::anthropic::AnthropicPassthrough
        .stream(&up, request(&server.uri(), true), on_done)
        .await;

    let response = match start {
        StreamStart::Streaming(r) => r,
        StreamStart::Failed { error, .. } => panic!("unexpected failure: {error}"),
        StreamStart::Unreachable(e) => panic!("unexpected unreachable: {e}"),
    };
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/event-stream"
    );

    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        String::from_utf8(body.to_vec()).unwrap(),
        CAPTURED_STREAM,
        "the passthrough must relay bytes VERBATIM"
    );

    let (usage, err) = wait_for_settle(&settled).await;
    assert!(err.is_none(), "clean stream: {err:?}");
    let u = usage.expect("usage must be sniffed off the relayed stream");
    // message_start's input buckets plus message_delta's cumulative output.
    assert_eq!(u.prompt_tokens, 1000);
    assert_eq!(u.cache_read_tokens(), 880);
    assert_eq!(u.fresh_input_tokens(), 120);
    assert_eq!(u.completion_tokens, 42, "the LAST delta wins");
}

/// A stream that reports no usage at all must settle with `None`, so the caller can
/// log "(no usage reported)" instead of billing a zero it invented.
#[tokio::test]
async fn a_stream_without_usage_settles_as_none() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "event: content_block_delta\n\
             data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::anthropic::AnthropicPassthrough
        .stream(&up, request(&server.uri(), true), on_done)
        .await;
    let StreamStart::Streaming(response) = start else {
        panic!("expected a stream");
    };
    let _ = response.into_body().collect().await.unwrap();

    let (usage, err) = wait_for_settle(&settled).await;
    assert!(err.is_none());
    assert!(usage.is_none(), "no usage event means no usage");
}

/// A client-fixable 4xx keeps its real status and message so the CLI shows the cause
/// and does not retry.
#[tokio::test]
async fn a_client_fixable_error_is_relayed_with_its_real_status() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400).set_body_string(
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"this model does not support image input"}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, _settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::anthropic::AnthropicPassthrough
        .stream(&up, request(&server.uri(), true), on_done)
        .await;

    let StreamStart::Failed {
        response, error, ..
    } = start
    else {
        panic!("expected a pre-flight failure");
    };
    assert_eq!(response.status(), 400);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(
        text.contains("does not support image input"),
        "the real cause must reach the CLI: {text}"
    );
    assert!(error.contains("upstream status 400"), "log line: {error}");
}

/// A provider-side failure must be SANITIZED: the customer never sees the upstream's
/// raw body, which can name the provider or carry upgrade URLs.
#[tokio::test]
async fn a_provider_side_error_is_sanitized() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(403).set_body_string(
            r#"{"error":{"message":"this model requires a subscription, see https://ollama.com/upgrade"}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, _settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::anthropic::AnthropicPassthrough
        .stream(&up, request(&server.uri(), true), on_done)
        .await;

    let StreamStart::Failed { response, .. } = start else {
        panic!("expected a pre-flight failure");
    };
    assert_eq!(response.status(), 502, "sanitized to a generic bad gateway");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(
        !text.contains("ollama.com"),
        "the upstream body must not leak: {text}"
    );
    assert!(text.contains("provider_unavailable"), "{text}");
}

/// An unreachable upstream leaves the response choice to the caller, because only the
/// route knows whether to answer 503 (circuit open) or 502.
#[tokio::test]
async fn an_unreachable_upstream_defers_to_the_caller() {
    let up = Upstream::new();
    let (on_done, _settled) = settle_recorder();
    // Port 1 is reserved and never listening.
    let start = rayu_gateway_lib::adapters::anthropic::AnthropicPassthrough
        .stream(&up, request("http://127.0.0.1:1", true), on_done)
        .await;
    match start {
        StreamStart::Unreachable(e) => {
            assert!(!e.is_circuit_open(), "a dial failure, not an open breaker");
        }
        _ => panic!("expected Unreachable"),
    }
}

#[tokio::test]
async fn complete_returns_the_anthropic_body_and_usage() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":90}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::anthropic::AnthropicPassthrough
        .complete(&up, request(&server.uri(), false))
        .await;

    assert_eq!(out.status, 200);
    assert!(out.error.is_none());
    let u = out.usage.expect("usage from the body");
    assert_eq!(u.prompt_tokens, 100);
    assert_eq!(u.cache_read_tokens(), 90);
    assert_eq!(u.completion_tokens, 5);
    // The body is passed through untouched for the route to forward.
    let text = String::from_utf8(out.body).unwrap();
    assert!(text.contains(r#""text":"hi""#));
}

/// The thinking sanitiser must actually be wired into the adapter: a foreign
/// signature from a completed turn must not reach the upstream.
#[tokio::test]
async fn the_request_body_has_prior_turn_thinking_stripped() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"id":"m","type":"message"}"#))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let mut req = request(&server.uri(), false);
    req.anthropic = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": [
                // DeepSeek's UUID signature, which Bedrock rejects.
                {"type": "thinking", "thinking": "from deepseek",
                 "signature": "4fd2c917-979d-4e69-8a37-3ce63dbd1f9b"},
                {"type": "text", "text": "Hi!"},
            ]},
            {"role": "user", "content": "hi again"},
        ],
    });
    let original = req.anthropic.clone();

    rayu_gateway_lib::adapters::anthropic::AnthropicPassthrough
        .complete(&up, req)
        .await;

    let sent = &server.received_requests().await.unwrap()[0];
    let body = String::from_utf8(sent.body.clone()).unwrap();
    assert!(
        !body.contains("4fd2c917"),
        "a foreign thinking signature reached the upstream: {body}"
    );
    assert!(body.contains("Hi!"), "the visible answer must survive");
    // The caller's value is untouched, because the route still logs and bills
    // against it.
    assert!(original.to_string().contains("4fd2c917"));
}
