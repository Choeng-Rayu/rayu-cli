//! End-to-end tests for the `bedrock_anthropic` adapter.
//!
//! Ports the cases from the Go gateway's `internal/translate/bedrock_test.go`.
//!
//! The interesting part is the stream: Bedrock answers with
//! `application/vnd.amazon.eventstream` frames, and the CLI only understands
//! Anthropic SSE. These tests build real frames the way Bedrock does and assert the
//! client receives named SSE events with usage still captured for billing.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use http_body_util::BodyExt;
use rayu_gateway_lib::adapters::{Adapter, AdapterRequest};
use rayu_gateway_lib::providercfg::{self, Route};
use rayu_gateway_lib::sse::StreamStart;
use rayu_gateway_lib::upstream::{ApiKey, Upstream, Usage};
use serde_json::Value;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const PRELUDE_LEN: usize = 12;
const CRC_LEN: usize = 4;
const HEADER_TYPE_STRING: u8 = 7;

/// Builds one AWS event-stream frame the way Bedrock does.
fn frame(headers: &[(&str, &str)], payload: &[u8]) -> Vec<u8> {
    let mut hdr = Vec::new();
    for (name, value) in headers {
        hdr.push(name.len() as u8);
        hdr.extend_from_slice(name.as_bytes());
        hdr.push(HEADER_TYPE_STRING);
        hdr.extend_from_slice(&(value.len() as u16).to_be_bytes());
        hdr.extend_from_slice(value.as_bytes());
    }
    let total = (PRELUDE_LEN + hdr.len() + payload.len() + CRC_LEN) as u32;
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(&total.to_be_bytes());
    out.extend_from_slice(&(hdr.len() as u32).to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes()); // prelude CRC (not verified)
    out.extend_from_slice(&hdr);
    out.extend_from_slice(payload);
    out.extend_from_slice(&0u32.to_be_bytes()); // message CRC (not verified)
    out
}

/// Wraps an Anthropic event the way Bedrock does: base64 inside `{"bytes":...}`.
fn chunk(event: &str) -> Vec<u8> {
    let payload = serde_json::json!({
        "bytes": base64::engine::general_purpose::STANDARD.encode(event.as_bytes()),
        "p": "abc",
    });
    frame(
        &[
            (":event-type", "chunk"),
            (":content-type", "application/json"),
            (":message-type", "event"),
        ],
        serde_json::to_string(&payload).unwrap().as_bytes(),
    )
}

fn route(uri: &str) -> Route {
    let (r, err) = providercfg::build(
        providercfg::Row {
            name: "aws".into(),
            format: providercfg::FORMAT_BEDROCK_ANTHROPIC.into(),
            base_url: uri.to_string(),
            auth_scheme: providercfg::AUTH_BEARER.into(),
            enabled: true,
            key_count: 1,
            ..Default::default()
        },
        providercfg::Options {
            allow_insecure: true,
        },
    );
    assert!(err.is_none(), "{err:?}");
    r
}

fn request(uri: &str, model: &str, stream: bool, anthropic: Value) -> AdapterRequest {
    AdapterRequest {
        route: route(uri),
        keys: vec![ApiKey {
            id: 1,
            secret: zeroize::Zeroizing::new("bedrock-key".into()),
        }],
        on_key_failure: None,
        upstream_model_id: model.to_string(),
        anthropic,
        stream,
        keepalive_seconds: 0,
    }
}

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
    for _ in 0..400 {
        if let Some(v) = seen.lock().unwrap().clone() {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the settle callback never ran");
}

#[tokio::test]
async fn the_model_goes_in_the_url_not_the_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],
                "usage":{"input_tokens":8,"output_tokens":2}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .complete(
            &up,
            request(
                &server.uri(),
                "us.anthropic.claude-sonnet-4-6",
                false,
                serde_json::json!({
                    "model": "us.anthropic.claude-sonnet-4-6",
                    "stream": false,
                    "max_tokens": 1,
                    "system": "be brief",
                    "messages": [{"role": "user", "content": "hi"}],
                }),
            ),
        )
        .await;
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.status, 200);

    let reqs = server.received_requests().await.unwrap();
    let r = &reqs[0];
    assert_eq!(
        r.url.path(),
        "/model/us.anthropic.claude-sonnet-4-6/invoke",
        "Bedrock takes the model in the URL"
    );
    assert_eq!(
        r.headers.get("authorization").unwrap().to_str().unwrap(),
        "Bearer bedrock-key"
    );

    let sent: Value = serde_json::from_slice(&r.body).unwrap();
    assert!(
        sent.get("model").is_none(),
        r#"body carried "model" -- Bedrock answers 400 "Extra inputs are not permitted""#
    );
    assert!(sent.get("stream").is_none(), r#"body carried "stream""#);
    assert_eq!(sent["anthropic_version"], "bedrock-2023-05-31");
    assert_eq!(sent["system"], "be brief", "everything else must survive");

    let u = out.usage.expect("usage must be parsed for billing");
    assert_eq!(u.prompt_tokens, 8);
    assert_eq!(u.completion_tokens, 2);
}

/// The CLI only understands Anthropic SSE, so the event-stream frames must come out
/// as `event:`/`data:` pairs -- with usage still captured for billing.
#[tokio::test]
async fn the_stream_becomes_anthropic_sse() {
    let events = [
        r#"{"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":11,"cache_read_input_tokens":4,"output_tokens":1}}}"#,
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}"#,
        r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}"#,
        r#"{"type":"message_stop"}"#,
    ];
    let mut body = Vec::new();
    for e in events {
        body.extend_from_slice(&chunk(e));
    }

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/vnd.amazon.eventstream")
                .set_body_bytes(body),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .stream(
            &up,
            request(
                &server.uri(),
                "us.anthropic.claude-sonnet-4-6",
                true,
                serde_json::json!({"model": "x", "max_tokens": 16, "stream": true}),
            ),
            on_done,
        )
        .await;

    let StreamStart::Streaming(resp) = start else {
        panic!("expected a stream");
    };
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "text/event-stream"
    );
    let raw = resp.into_body().collect().await.unwrap().to_bytes();
    let out = String::from_utf8(raw.to_vec()).unwrap();

    // The SDK dispatches on the event NAME, so a bare data: stream is useless.
    for want in [
        "event: message_start",
        "event: content_block_start",
        "event: content_block_delta",
        "event: message_delta",
        "event: message_stop",
    ] {
        assert!(out.contains(want), "stream is missing {want:?}\n{out}");
    }
    assert!(
        out.contains(r#""text":"hello""#),
        "the model's text never reached the client:\n{out}"
    );
    // No base64 wrapper may leak through.
    assert!(
        !out.contains("\"bytes\""),
        "the eventstream wrapper leaked:\n{out}"
    );

    let (usage, err) = wait_for_settle(&settled).await;
    assert!(err.is_none(), "clean stream: {err:?}");
    // Billing must be identical to a direct Anthropic provider: fresh input + cache
    // read counted, final cumulative output taken from message_delta.
    let u = usage.expect("no usage captured -- the request would be billed as zero");
    assert_eq!(
        u.prompt_tokens, 15,
        "11 fresh + 4 cached, exactly like a direct provider"
    );
    assert_eq!(u.completion_tokens, 7);
    assert_eq!(u.cache_read_tokens(), 4);
}

/// A metadata frame in the middle must be ignored, not forwarded as an event.
#[tokio::test]
async fn metadata_frames_are_ignored() {
    let mut body = chunk(
        r#"{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}"#,
    );
    body.extend_from_slice(&frame(
        &[(":event-type", "metadata"), (":message-type", "event")],
        br#"{"metrics":{"latencyMs":42}}"#,
    ));
    body.extend_from_slice(&chunk(r#"{"type":"message_stop"}"#));

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .stream(
            &up,
            request(
                &server.uri(),
                "m",
                true,
                serde_json::json!({"max_tokens": 8}),
            ),
            on_done,
        )
        .await;
    let StreamStart::Streaming(resp) = start else {
        panic!("expected a stream");
    };
    let raw = resp.into_body().collect().await.unwrap().to_bytes();
    let out = String::from_utf8(raw.to_vec()).unwrap();
    assert!(
        !out.contains("latencyMs"),
        "a metadata frame leaked:\n{out}"
    );
    assert!(out.contains("event: message_stop"));
    let (_, err) = wait_for_settle(&settled).await;
    assert!(err.is_none(), "{err:?}");
}

/// Bedrock reports mid-stream trouble as a FRAME, not an HTTP status, so it has to
/// end the stream rather than look like a clean finish.
#[tokio::test]
async fn an_exception_frame_is_surfaced() {
    let mut body = chunk(
        r#"{"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}"#,
    );
    // Exactly how Bedrock reports throttling mid-stream.
    body.extend_from_slice(&frame(
        &[
            (":message-type", "exception"),
            (":exception-type", "throttlingException"),
            (":content-type", "application/json"),
        ],
        br#"{"message":"slow down"}"#,
    ));

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .stream(
            &up,
            request(
                &server.uri(),
                "m",
                true,
                serde_json::json!({"max_tokens": 8}),
            ),
            on_done,
        )
        .await;
    let StreamStart::Streaming(resp) = start else {
        panic!("the 200 must still start a stream");
    };
    let _ = resp.into_body().collect().await;

    let (usage, err) = wait_for_settle(&settled).await;
    let err = err.expect("an exception frame was treated as a clean stream");
    assert!(
        err.contains("throttlingException"),
        "the reason must reach the log: {err}"
    );
    // Whatever arrived before the failure must still be billable.
    let u = usage.expect("usage before the error must survive");
    assert_eq!(u.prompt_tokens, 5);
}

/// A stream that is cut mid-frame must be reported, not accepted as a short answer.
#[tokio::test]
async fn a_truncated_stream_is_reported() {
    let full = chunk(
        r#"{"type":"message_start","message":{"usage":{"input_tokens":6,"output_tokens":1}}}"#,
    );
    let mut body = full.clone();
    let cut = &full[..full.len() - 6];
    body.extend_from_slice(cut);

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .stream(
            &up,
            request(
                &server.uri(),
                "m",
                true,
                serde_json::json!({"max_tokens": 8}),
            ),
            on_done,
        )
        .await;
    let StreamStart::Streaming(resp) = start else {
        panic!("expected a stream");
    };
    let _ = resp.into_body().collect().await;

    let (usage, err) = wait_for_settle(&settled).await;
    assert!(err.is_some(), "a truncated frame must be reported");
    assert_eq!(usage.expect("prior usage").prompt_tokens, 6);
}

/// Bedrock's error shape is `{"message": ...}`; the CLI only understands
/// Anthropic's error envelope.
#[tokio::test]
async fn errors_are_reshaped_for_the_client() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400).set_body_string(
            r#"{"message":"Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand throughput isn't supported."}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .complete(
            &up,
            request(
                &server.uri(),
                "anthropic.claude-sonnet-4-6",
                false,
                serde_json::json!({"max_tokens": 1}),
            ),
        )
        .await;
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.status, 400, "the upstream 400 must be preserved");

    let body: Value = serde_json::from_slice(&out.body).unwrap();
    assert_eq!(body["type"], "error", "not an Anthropic error envelope");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("on-demand throughput"),
        "the real reason was lost: {body}"
    );
}

/// A pre-stream failure keeps Bedrock's own status (the body is already an Anthropic
/// envelope), unlike the translating adapters which mask a provider fault as 502.
#[tokio::test]
async fn a_preflight_error_keeps_the_upstream_status() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(400)
                .set_body_string(r#"{"message":"max_tokens: Field required"}"#),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, _) = settle_recorder();
    let start = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .stream(
            &up,
            request(&server.uri(), "m", true, serde_json::json!({})),
            on_done,
        )
        .await;
    let StreamStart::Failed {
        response, error, ..
    } = start
    else {
        panic!("a 400 must be a Failed outcome");
    };
    assert!(error.contains("bedrock status 400"), "{error}");
    assert_eq!(response.status().as_u16(), 400);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let parsed: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["type"], "error");
    assert!(parsed["error"]["message"]
        .as_str()
        .unwrap()
        .contains("max_tokens"));
}

#[tokio::test]
async fn an_unreachable_upstream_is_reported_as_unreachable() {
    let up = Upstream::new();
    let (on_done, _) = settle_recorder();
    let start = rayu_gateway_lib::adapters::bedrock::BedrockAnthropic
        .stream(
            &up,
            request("http://127.0.0.1:1", "m", true, serde_json::json!({})),
            on_done,
        )
        .await;
    assert!(matches!(start, StreamStart::Unreachable(_)));
}

#[test]
fn the_adapter_is_registered() {
    let a = rayu_gateway_lib::adapters::adapter_for(providercfg::FORMAT_BEDROCK_ANTHROPIC)
        .expect("bedrock_anthropic must be registered");
    assert_eq!(a.format(), providercfg::FORMAT_BEDROCK_ANTHROPIC);
    assert!(rayu_gateway_lib::adapters::formats().contains(&providercfg::FORMAT_BEDROCK_ANTHROPIC));
}
