//! End-to-end tests for the `openai_responses` adapter.
//!
//! Ports the streaming and non-streaming cases from the Go gateway's
//! `internal/translate/openai_responses_test.go`.
//!
//! The load-bearing case here is that `response.failed` and `response.incomplete`
//! are TERMINAL EVENTS ON A 200 STREAM: treating a 200 as unconditional success
//! would silently bill a failed generation and hand the client a truncated message
//! with no explanation.

use std::sync::{Arc, Mutex};

use http_body_util::BodyExt;
use rayu_gateway_lib::adapters::{Adapter, AdapterRequest};
use rayu_gateway_lib::providercfg::{self, Route};
use rayu_gateway_lib::sse::StreamStart;
use rayu_gateway_lib::upstream::{ApiKey, Upstream, Usage};
use serde_json::Value;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn route(uri: &str) -> Route {
    Route {
        name: "openai".into(),
        format: providercfg::FORMAT_OPENAI_RESPONSES.into(),
        base_url: uri.to_string(),
        endpoint_path: "/v1/responses".into(),
        auth_scheme: providercfg::AUTH_BEARER.into(),
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
        upstream_model_id: "gpt-5.5".into(),
        anthropic: serde_json::json!({
            "model": "gpt-5.5",
            "max_tokens": 64,
            "stream": stream,
            "messages": [{"role": "user", "content": "hi"}],
        }),
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

#[derive(Debug)]
struct Event {
    name: String,
    data: Value,
}

fn sse_events(raw: &str) -> Vec<Event> {
    let mut out = Vec::new();
    for block in raw.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let (mut name, mut data) = (String::new(), String::new());
        for line in block.split('\n') {
            if let Some(rest) = line.strip_prefix("event: ") {
                name = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("data: ") {
                data = rest.to_string();
            }
        }
        if name.is_empty() {
            continue;
        }
        let payload: Value = if data.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&data)
                .unwrap_or_else(|e| panic!("event {name} has bad JSON: {e} ({data})"))
        };
        out.push(Event {
            name,
            data: payload,
        });
    }
    out
}

fn names(events: &[Event]) -> Vec<&str> {
    events.iter().map(|e| e.name.as_str()).collect()
}

fn sse_body(lines: &[&str]) -> String {
    format!("{}\n\n", lines.join("\n\n"))
}

async fn stream_responses(upstream_sse: String) -> (String, Option<Usage>, Option<String>) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(upstream_sse),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::openai_responses::OpenAiResponses
        .stream(&up, request(&server.uri(), true), on_done)
        .await;

    let response = match start {
        StreamStart::Streaming(r) => r,
        StreamStart::Failed { error, .. } => panic!("unexpected failure: {error}"),
        StreamStart::Unreachable(e) => panic!("unexpected unreachable: {e}"),
    };
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let (usage, err) = wait_for_settle(&settled).await;
    (String::from_utf8(body.to_vec()).unwrap(), usage, err)
}

#[tokio::test]
async fn stream_text_and_usage() {
    let (body, usage, err) = stream_responses(sse_body(&[
        r#"data: {"type":"response.created","response":{"status":"in_progress"}}"#,
        r#"data: {"type":"response.in_progress","response":{"status":"in_progress"}}"#,
        r#"data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1"}}"#,
        r#"data: {"type":"response.content_part.added","part":{"type":"output_text"}}"#,
        r#"data: {"type":"response.output_text.delta","delta":"Hel","obfuscation":"xxxxx"}"#,
        r#"data: {"type":"response.output_text.delta","delta":"lo","obfuscation":"yyyy"}"#,
        r#"data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1"}}"#,
        r#"data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":500,"output_tokens":12,"total_tokens":512,"input_tokens_details":{"cached_tokens":400}}}}"#,
    ]))
    .await;
    assert!(err.is_none(), "clean stream: {err:?}");

    let events = sse_events(&body);
    assert_eq!(
        names(&events),
        vec![
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ],
        "lifecycle events (created/in_progress/content_part.added) must produce NO \
         client events"
    );

    let text: String = events
        .iter()
        .filter(|e| e.name == "content_block_delta")
        .map(|e| e.data["delta"]["text"].as_str().unwrap())
        .collect();
    assert_eq!(text, "Hello");

    let md = &events[events.len() - 2].data;
    assert_eq!(md["delta"]["stop_reason"], "end_turn");
    assert_eq!(md["usage"]["input_tokens"], 100, "fresh = 500 - 400 cached");
    assert_eq!(md["usage"]["cache_read_input_tokens"], 400);

    let u = usage.expect("usage must be reported");
    assert_eq!(u.prompt_tokens, 500);
    assert_eq!(u.fresh_input_tokens(), 100);
    assert_eq!(u.cache_read_tokens(), 400);
    assert_eq!(u.completion_tokens, 12);
}

#[tokio::test]
async fn stream_function_call() {
    let (body, _, err) = stream_responses(sse_body(&[
        r#"data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_9","name":"read_file","arguments":""}}"#,
        r#"data: {"type":"response.function_call_arguments.delta","delta":"{\"path\":"}"#,
        r#"data: {"type":"response.function_call_arguments.delta","delta":"\"a.txt\"}"}"#,
        r#"data: {"type":"response.function_call_arguments.done","arguments":"{\"path\":\"a.txt\"}"}"#,
        r#"data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28}}}"#,
    ]))
    .await;
    assert!(err.is_none(), "{err:?}");

    let events = sse_events(&body);
    let block = events
        .iter()
        .find(|e| e.name == "content_block_start")
        .map(|e| &e.data["content_block"])
        .expect("a tool_use block must open");
    assert_eq!(block["type"], "tool_use");
    assert_eq!(
        block["id"], "call_9",
        "the id must be the call_id so the result pairs on the next turn"
    );
    assert_eq!(block["name"], "read_file");

    let args: String = events
        .iter()
        .filter(|e| {
            e.name == "content_block_delta" && e.data["delta"]["type"] == "input_json_delta"
        })
        .map(|e| e.data["delta"]["partial_json"].as_str().unwrap())
        .collect();
    assert_eq!(
        args, r#"{"path":"a.txt"}"#,
        "the `.done` event must not duplicate the arguments"
    );

    let md = &events[events.len() - 2].data;
    assert_eq!(md["delta"]["stop_reason"], "tool_use");
}

#[tokio::test]
async fn stream_reasoning_becomes_thinking() {
    let (body, _, err) = stream_responses(sse_body(&[
        r#"data: {"type":"response.reasoning_summary_text.delta","delta":"weighing options"}"#,
        r#"data: {"type":"response.output_text.delta","delta":"answer"}"#,
        r#"data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7,"output_tokens_details":{"reasoning_tokens":1}}}}"#,
    ]))
    .await;
    assert!(err.is_none(), "{err:?}");

    let kinds: Vec<String> = sse_events(&body)
        .iter()
        .filter(|e| e.name == "content_block_start")
        .map(|e| {
            e.data["content_block"]["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(kinds, vec!["thinking", "text"]);
    assert!(body.contains("weighing options"));
}

/// `response.incomplete` is a TERMINAL EVENT ON A 200 STREAM: max_tokens truncation
/// must become Anthropic's max_tokens stop reason, and usage must still settle.
#[tokio::test]
async fn stream_incomplete_becomes_a_max_tokens_stop() {
    let (body, usage, err) = stream_responses(sse_body(&[
        r#"data: {"type":"response.output_text.delta","delta":"trunca"}"#,
        r#"data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_tokens"},"usage":{"input_tokens":30,"output_tokens":64,"total_tokens":94}}}"#,
    ]))
    .await;
    assert!(
        err.is_none(),
        "an incomplete response is not an error: {err:?}"
    );

    let events = sse_events(&body);
    let md = &events[events.len() - 2].data;
    assert_eq!(md["delta"]["stop_reason"], "max_tokens");

    let u = usage.expect("truncated turns are still billed");
    assert_eq!(u.prompt_tokens, 30);
    assert_eq!(u.completion_tokens, 64);
}

/// `response.failed` is also terminal on a 200 stream: the client must be told, the
/// stream must close cleanly, and the error must surface for logging and settlement.
#[tokio::test]
async fn stream_failed_event_is_reported_without_leaking_provider_text() {
    let (body, usage, err) = stream_responses(sse_body(&[
        r#"data: {"type":"response.output_text.delta","delta":"partial"}"#,
        r#"data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response."},"usage":{"input_tokens":11,"output_tokens":3,"total_tokens":14}}}"#,
    ]))
    .await;

    let err = err.expect("a response.failed event must be reported as an error");
    assert!(
        err.contains("server_error"),
        "the error should carry the provider's code for the log: {err}"
    );
    let u = usage.expect("the reported usage must survive a failure");
    assert_eq!(u.prompt_tokens, 11);

    // The client learns about it AND the stream is closed properly.
    assert!(body.contains(r#""type":"error""#), "no error event: {body}");
    assert!(body.contains("message_stop"), "stream not closed: {body}");
    // The provider's raw message must not be forwarded verbatim mid-stream.
    assert!(
        !body.contains("The model failed to generate a response."),
        "provider error text leaked to the client: {body}"
    );
}

/// A `response.failed` with no error object must still be reported.
#[tokio::test]
async fn a_bare_failed_event_is_still_an_error() {
    let (_, _, err) = stream_responses(sse_body(&[
        r#"data: {"type":"response.failed","response":{"status":"failed"}}"#,
    ]))
    .await;
    assert_eq!(
        err.as_deref(),
        Some("upstream reported the response failed")
    );
}

#[tokio::test]
async fn preflight_error_relay_follows_the_shared_policy() {
    for (upstream_status, want_status) in [(400u16, 400u16), (403, 502)] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(upstream_status)
                    .set_body_string(r#"{"error":{"message":"nope at https://provider.example"}}"#),
            )
            .mount(&server)
            .await;

        let up = Upstream::new();
        let (on_done, _) = settle_recorder();
        let start = rayu_gateway_lib::adapters::openai_responses::OpenAiResponses
            .stream(&up, request(&server.uri(), true), on_done)
            .await;
        let StreamStart::Failed { response, .. } = start else {
            panic!("upstream {upstream_status} should have failed");
        };
        assert_eq!(response.status().as_u16(), want_status);
        if want_status == 502 {
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert!(
                !String::from_utf8_lossy(&body).contains("provider.example"),
                "the provider host must not leak"
            );
        }
    }
}

#[tokio::test]
async fn complete_translation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_string(
                    r#"{
                    "status":"completed",
                    "output":[
                      {"type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]},
                      {"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]},
                      {"type":"function_call","call_id":"call_7","name":"read_file","arguments":"{\"path\":\"b.txt\"}"}
                    ],
                    "usage":{"input_tokens":80,"output_tokens":10,"total_tokens":90,"input_tokens_details":{"cached_tokens":60}}
                }"#,
                ),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::openai_responses::OpenAiResponses
        .complete(&up, request(&server.uri(), false))
        .await;
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.status, 200);

    let body: Value = serde_json::from_slice(&out.body).unwrap();
    assert_eq!(body["type"], "message");
    assert_eq!(body["stop_reason"], "tool_use");

    let blocks = body["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 3, "{blocks:?}");
    assert_eq!(blocks[0]["thinking"], "thought");
    assert_eq!(blocks[1]["text"], "done");
    assert_eq!(blocks[2]["id"], "call_7");
    assert_eq!(blocks[2]["input"]["path"], "b.txt");

    let u = out.usage.expect("usage");
    assert_eq!(u.fresh_input_tokens(), 20, "80 - 60 cached");
    assert_eq!(u.cache_read_tokens(), 60);
}

/// A 200 whose body says `status: "failed"` must not be presented as success.
#[tokio::test]
async fn complete_failed_status_is_an_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"status":"failed","error":{"code":"server_error","message":"boom"},"output":[],"usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::openai_responses::OpenAiResponses
        .complete(&up, request(&server.uri(), false))
        .await;
    let err = out.error.expect("status:failed must surface as an error");
    assert!(err.contains("boom"), "{err}");
    assert_eq!(
        out.status, 502,
        "the caller must mask it, not relay a half-empty message"
    );
    let u = out.usage.expect("usage should still be reported");
    assert_eq!(u.prompt_tokens, 3);
}

#[tokio::test]
async fn complete_max_tokens_stop() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"status":"incomplete","incomplete_details":{"reason":"max_tokens"},
                "output":[{"type":"message","content":[{"type":"output_text","text":"trunc"}]}],
                "usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::openai_responses::OpenAiResponses
        .complete(&up, request(&server.uri(), false))
        .await;
    assert!(
        out.error.is_none() && out.status == 200,
        "truncation is a normal outcome: {:?} / {}",
        out.error,
        out.status
    );
    let body: Value = serde_json::from_slice(&out.body).unwrap();
    assert_eq!(body["stop_reason"], "max_tokens");
}

#[test]
fn the_adapter_is_registered() {
    let a = rayu_gateway_lib::adapters::adapter_for(providercfg::FORMAT_OPENAI_RESPONSES)
        .expect("openai_responses must be registered");
    assert_eq!(a.format(), providercfg::FORMAT_OPENAI_RESPONSES);
    assert!(rayu_gateway_lib::adapters::formats().contains(&providercfg::FORMAT_OPENAI_RESPONSES));
}
