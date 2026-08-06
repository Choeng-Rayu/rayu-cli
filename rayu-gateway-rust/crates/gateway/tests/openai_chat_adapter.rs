//! End-to-end tests for the `openai_chat` adapter.
//!
//! Ports the streaming and non-streaming cases from the Go gateway's
//! `internal/translate/openai_chat_test.go`. These run a real HTTP upstream that
//! replays a captured OpenAI SSE body, and assert on the translated Anthropic
//! stream the client would receive -- the only assertion that actually proves the
//! CLI keeps working.

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
        name: "deepseek".into(),
        format: providercfg::FORMAT_OPENAI_CHAT.into(),
        base_url: uri.to_string(),
        endpoint_path: "/v1/chat/completions".into(),
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
        upstream_model_id: "deepseek-chat".into(),
        anthropic: serde_json::json!({
            "model": "deepseek-chat",
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

/// One translated SSE event.
#[derive(Debug)]
struct Event {
    name: String,
    data: Value,
}

/// Parses a translated Anthropic SSE stream into (event, payload) pairs.
fn sse_events(raw: &str) -> Vec<Event> {
    let mut out = Vec::new();
    for block in raw.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut name = String::new();
        let mut data = String::new();
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

/// Runs the adapter against an upstream that replays `upstream_sse`, returning the
/// translated Anthropic stream and whatever usage was settled.
async fn stream_openai_chat(upstream_sse: String) -> (String, Option<Usage>, Option<String>) {
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
    let start = rayu_gateway_lib::adapters::openai_chat::OpenAiChat
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

fn sse_body(lines: &[&str]) -> String {
    format!("{}\n\n", lines.join("\n\n"))
}

#[tokio::test]
async fn stream_text_translation() {
    let (body, usage, err) = stream_openai_chat(sse_body(&[
        r#"data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
        r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"total_tokens":107,"prompt_tokens_details":{"cached_tokens":40}}}"#,
        "data: [DONE]",
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
        "the event sequence is a contract with the CLI"
    );

    // Text deltas must carry Anthropic's text_delta shape.
    assert_eq!(events[2].data["delta"]["type"], "text_delta");
    assert_eq!(events[2].data["delta"]["text"], "Hello");
    assert_eq!(events[3].data["delta"]["text"], " world");

    let md = &events[5].data;
    assert_eq!(md["delta"]["stop_reason"], "end_turn");
    // Usage on message_delta must be split into Anthropic's buckets.
    assert_eq!(md["usage"]["input_tokens"], 60, "fresh input");
    assert_eq!(md["usage"]["cache_read_input_tokens"], 40);
    assert_eq!(md["usage"]["output_tokens"], 7);

    // And the adapter must report the same numbers for billing.
    let u = usage.expect("usage must be reported");
    assert_eq!(u.prompt_tokens, 100);
    assert_eq!(u.completion_tokens, 7);
    assert_eq!(u.cache_read_tokens(), 40);
    assert_eq!(u.fresh_input_tokens(), 60);
}

#[tokio::test]
async fn stream_max_tokens_stop_reason() {
    let (body, _, _) = stream_openai_chat(sse_body(&[
        r#"data: {"choices":[{"delta":{"content":"tru"},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#,
        "data: [DONE]",
    ]))
    .await;
    let events = sse_events(&body);
    let md = &events[events.len() - 2];
    assert_eq!(md.name, "message_delta");
    assert_eq!(md.data["delta"]["stop_reason"], "max_tokens");
}

#[tokio::test]
async fn stream_multiple_tool_calls() {
    let (body, _, _) = stream_openai_chat(sse_body(&[
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"list_dir","arguments":"{}"}}]},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        "data: [DONE]",
    ]))
    .await;

    let events = sse_events(&body);
    let mut starts: Vec<&Value> = Vec::new();
    let mut indices: Vec<i64> = Vec::new();
    let mut arg_deltas: Vec<String> = Vec::new();
    for e in &events {
        match e.name.as_str() {
            "content_block_start" => {
                starts.push(&e.data["content_block"]);
                indices.push(e.data["index"].as_i64().unwrap());
            }
            "content_block_delta" if e.data["delta"]["type"] == "input_json_delta" => {
                arg_deltas.push(
                    e.data["delta"]["partial_json"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                );
            }
            _ => {}
        }
    }

    assert_eq!(starts.len(), 2, "two separate tool_use blocks: {starts:?}");
    assert_eq!(starts[0]["type"], "tool_use");
    assert_eq!(starts[0]["id"], "call_a");
    assert_eq!(starts[0]["name"], "read_file");
    assert_eq!(starts[1]["id"], "call_b");
    assert_eq!(starts[1]["name"], "list_dir");
    assert_ne!(
        indices[0], indices[1],
        "parallel tool calls must use distinct block indices"
    );
    assert_eq!(
        arg_deltas[..2].join(""),
        r#"{"path":"a.txt"}"#,
        "argument fragments stream incrementally, in order"
    );

    let md = &events[events.len() - 2];
    assert_eq!(md.data["delta"]["stop_reason"], "tool_use");
}

/// A tool-call chunk that carries a name but NO index must still start a new call:
/// some providers omit the index entirely.
#[tokio::test]
async fn a_named_tool_chunk_without_an_index_starts_a_new_call() {
    let (body, _, _) = stream_openai_chat(sse_body(&[
        r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"one","arguments":"{}"}}]}}]}"#,
        r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"c2","function":{"name":"two","arguments":"{}"}}]}}]}"#,
        r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        "data: [DONE]",
    ]))
    .await;
    let events = sse_events(&body);
    let starts: Vec<&Value> = events
        .iter()
        .filter(|e| e.name == "content_block_start")
        .map(|e| &e.data["content_block"])
        .collect();
    assert_eq!(starts.len(), 2, "{starts:?}");
    assert_eq!(starts[0]["name"], "one");
    assert_eq!(starts[1]["name"], "two");
}

#[tokio::test]
async fn stream_reasoning_becomes_a_thinking_block() {
    let (body, _, _) = stream_openai_chat(sse_body(&[
        r#"data: {"choices":[{"delta":{"reasoning_content":"let me think"},"finish_reason":null}]}"#,
        r#"data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}"#,
        "data: [DONE]",
    ]))
    .await;

    let events = sse_events(&body);
    let mut kinds: Vec<String> = Vec::new();
    let (mut thinking, mut text) = (String::new(), String::new());
    for e in &events {
        match e.name.as_str() {
            "content_block_start" => kinds.push(
                e.data["content_block"]["type"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            ),
            "content_block_delta" => match e.data["delta"]["type"].as_str() {
                Some("thinking_delta") => {
                    thinking.push_str(e.data["delta"]["thinking"].as_str().unwrap())
                }
                Some("text_delta") => text.push_str(e.data["delta"]["text"].as_str().unwrap()),
                _ => {}
            },
            _ => {}
        }
    }
    assert_eq!(kinds, vec!["thinking", "text"], "block kinds");
    assert_eq!(thinking, "let me think");
    assert_eq!(text, "answer");
}

/// The OpenRouter-style `reasoning` object must translate identically to DeepSeek's
/// `reasoning_content` string.
#[tokio::test]
async fn the_openrouter_reasoning_shape_also_becomes_thinking() {
    let (body, _, _) = stream_openai_chat(sse_body(&[
        r#"data: {"choices":[{"delta":{"reasoning":{"text":"hmm"}}}]}"#,
        r#"data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}"#,
        "data: [DONE]",
    ]))
    .await;
    assert!(
        body.contains(r#""thinking":"hmm""#),
        "reasoning object must become a thinking delta: {body}"
    );
}

/// A stream that dies mid-flight must still close cleanly and report the usage seen
/// so far, so the caller settles what was actually consumed.
#[tokio::test]
async fn a_truncated_stream_still_closes_and_reports_prior_usage() {
    // The last line never terminates, so the body ends mid-event.
    let truncated = format!(
        "{}\n\n{}\n\n{}",
        r#"data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}"#,
        r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}"#,
        r#"data: {"choices":[{"delta":{"content":"tial"#,
    );
    let (body, usage, _) = stream_openai_chat(truncated).await;
    assert!(
        body.contains("message_stop"),
        "the stream must still be closed: {body}"
    );
    let u = usage.expect("pre-break usage must survive for settlement");
    assert_eq!(u.prompt_tokens, 10);
    assert_eq!(u.completion_tokens, 2);
}

/// A genuine scanner failure (here an over-long line) must tell the client -- the
/// status is already sent, so an SSE error event is the only channel left -- and
/// still settle the usage seen so far.
#[tokio::test]
async fn a_mid_stream_scanner_failure_emits_an_error_event() {
    let huge = "x".repeat(1 << 20);
    let stream = format!(
        "{}\n\n{}\n\ndata: {}\n\n",
        r#"data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}"#,
        r#"data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}"#,
        huge,
    );
    let (body, usage, err) = stream_openai_chat(stream).await;
    assert!(err.is_some(), "the failure must be reported to the caller");
    assert!(
        body.contains("The model provider ended the response unexpectedly."),
        "the client must be told: {}",
        &body[body.len().saturating_sub(400)..]
    );
    assert!(body.contains("message_stop"), "the stream must still close");
    let u = usage.expect("pre-break usage must survive");
    assert_eq!(u.prompt_tokens, 11);
}

/// A pre-stream upstream failure must follow the shared relay policy: a
/// client-fixable 400 keeps its cause, a provider 403 is masked as 502.
#[tokio::test]
async fn preflight_error_relay_follows_the_shared_policy() {
    struct Case {
        upstream_status: u16,
        upstream_body: &'static str,
        want_status: u16,
        want_contains: &'static str,
        want_absent: &'static str,
    }
    let cases = [
        Case {
            upstream_status: 400,
            upstream_body: r#"{"error":{"message":"context length exceeded"}}"#,
            want_status: 400,
            want_contains: "context length exceeded",
            want_absent: "",
        },
        Case {
            upstream_status: 403,
            upstream_body: r#"{"error":{"message":"upgrade at https://provider.example/upgrade"}}"#,
            want_status: 502,
            want_contains: "",
            want_absent: "provider.example",
        },
    ];

    for c in cases {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(c.upstream_status).set_body_string(c.upstream_body))
            .mount(&server)
            .await;

        let up = Upstream::new();
        let (on_done, _) = settle_recorder();
        let start = rayu_gateway_lib::adapters::openai_chat::OpenAiChat
            .stream(&up, request(&server.uri(), true), on_done)
            .await;

        let StreamStart::Failed {
            response, error, ..
        } = start
        else {
            panic!("upstream {} should have failed", c.upstream_status);
        };
        assert!(
            !error.is_empty(),
            "the caller needs a reason to log and not charge"
        );
        assert_eq!(
            response.status().as_u16(),
            c.want_status,
            "upstream {}",
            c.upstream_status
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body = String::from_utf8(body.to_vec()).unwrap();
        if !c.want_contains.is_empty() {
            assert!(body.contains(c.want_contains), "body={body}");
        }
        if !c.want_absent.is_empty() {
            assert!(
                !body.contains(c.want_absent),
                "provider detail leaked: {body}"
            );
        }
    }
}

/// An unreachable upstream must be distinguishable from one that answered with an
/// error, because only the former means "never charge".
#[tokio::test]
async fn an_unreachable_upstream_is_reported_as_unreachable() {
    let up = Upstream::new();
    let (on_done, _) = settle_recorder();
    // Port 1 on loopback refuses instantly.
    let start = rayu_gateway_lib::adapters::openai_chat::OpenAiChat
        .stream(&up, request("http://127.0.0.1:1", true), on_done)
        .await;
    assert!(matches!(start, StreamStart::Unreachable(_)));
}

#[tokio::test]
async fn complete_translation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).insert_header("content-type", "application/json").set_body_string(
                r#"{"choices":[{"message":{"role":"assistant","content":"done","reasoning_content":"thought","tool_calls":[{"id":"call_x","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":9,"total_tokens":59,"prompt_cache_hit_tokens":30,"prompt_cache_miss_tokens":20}}"#,
            ),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::openai_chat::OpenAiChat
        .complete(&up, request(&server.uri(), false))
        .await;
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.status, 200);

    // The upstream must not receive a stream flag on the non-streaming path.
    let reqs = server.received_requests().await.unwrap();
    let sent: Value = serde_json::from_slice(&reqs[0].body).unwrap();
    assert!(
        sent.get("stream").is_none(),
        "non-streaming request must not set stream"
    );

    let body: Value = serde_json::from_slice(&out.body).unwrap();
    assert_eq!(body["type"], "message");
    assert_eq!(body["role"], "assistant");
    assert_eq!(body["stop_reason"], "tool_use");

    let blocks = body["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 3, "thinking, text, tool_use: {blocks:?}");
    assert_eq!(blocks[0]["type"], "thinking");
    assert_eq!(blocks[0]["thinking"], "thought");
    assert_eq!(blocks[1]["text"], "done");
    assert_eq!(blocks[2]["type"], "tool_use");
    assert_eq!(blocks[2]["id"], "call_x");
    assert_eq!(blocks[2]["name"], "read_file");
    // Arguments must be decoded into a real object, not left as a JSON string.
    assert_eq!(
        blocks[2]["input"]["path"], "a.txt",
        "input must be a decoded object: {:?}",
        blocks[2]["input"]
    );

    // The DeepSeek-convention cache split must survive into both body and billing.
    assert_eq!(body["usage"]["input_tokens"], 20, "fresh");
    assert_eq!(body["usage"]["cache_read_input_tokens"], 30);
    let u = out.usage.expect("usage must be reported");
    assert_eq!(u.cache_read_tokens(), 30);
    assert_eq!(u.fresh_input_tokens(), 20);
}

#[tokio::test]
async fn complete_returns_the_upstream_error_untranslated() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(400)
                .set_body_string(r#"{"error":{"message":"bad tool schema"}}"#),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::openai_chat::OpenAiChat
        .complete(&up, request(&server.uri(), false))
        .await;
    assert!(
        out.error.is_none(),
        "an upstream 4xx is not an adapter error: {:?}",
        out.error
    );
    assert_eq!(
        out.status, 400,
        "the status passes through for the caller to relay"
    );
    assert!(
        String::from_utf8_lossy(&out.body).contains("bad tool schema"),
        "the upstream error body must be returned as-is"
    );
}

/// The adapter must be reachable through the registry, or a provider row naming
/// `openai_chat` would 500.
#[test]
fn the_adapter_is_registered() {
    let a = rayu_gateway_lib::adapters::adapter_for(providercfg::FORMAT_OPENAI_CHAT)
        .expect("openai_chat must be registered");
    assert_eq!(a.format(), providercfg::FORMAT_OPENAI_CHAT);
    assert!(rayu_gateway_lib::adapters::formats().contains(&providercfg::FORMAT_OPENAI_CHAT));
}
