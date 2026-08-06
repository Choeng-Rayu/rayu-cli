//! End-to-end tests for the `genai` (Gemini) adapter.
//!
//! Ports the URL, auth-header, streaming and non-streaming cases from the Go
//! gateway's `internal/translate/genai_test.go`.
//!
//! Two things here are Gemini-specific and load-bearing: a `thought` part also
//! carries `text` (so mis-ordering the checks leaks the chain-of-thought into the
//! visible answer), and `thoughtSignature` must survive a round trip or the next
//! turn 400s.

use std::sync::{Arc, Mutex};

use http_body_util::BodyExt;
use rayu_gateway_lib::adapters::{Adapter, AdapterRequest};
use rayu_gateway_lib::providercfg::{self, Route};
use rayu_gateway_lib::sse::StreamStart;
use rayu_gateway_lib::upstream::{ApiKey, Upstream, Usage};
use serde_json::Value;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

/// `endpoint_path` is blank for genai: the adapter builds a model-specific URL.
fn route(uri: &str) -> Route {
    Route {
        name: "gemini".into(),
        format: providercfg::FORMAT_GENAI.into(),
        base_url: uri.to_string(),
        endpoint_path: String::new(),
        auth_scheme: providercfg::AUTH_X_GOOG_API_KEY.into(),
        key_count: 1,
        enabled: true,
    }
}

fn request(uri: &str, stream: bool) -> AdapterRequest {
    AdapterRequest {
        route: route(uri),
        keys: vec![ApiKey {
            id: 1,
            secret: zeroize::Zeroizing::new("AIza-test".into()),
        }],
        on_key_failure: None,
        upstream_model_id: "gemini-3-pro".into(),
        anthropic: serde_json::json!({
            "model": "gemini-3-pro",
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

async fn stream_genai(upstream_sse: String) -> (String, Option<Usage>, Option<String>) {
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
    let start = rayu_gateway_lib::adapters::genai::GenAi
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

/// Gemini authenticates with `x-goog-api-key`, and the model id plus method must
/// appear in the PATH -- not in the body.
#[tokio::test]
async fn the_request_uses_the_google_api_key_header_and_model_path() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],
                "usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::genai::GenAi
        .complete(&up, request(&server.uri(), false))
        .await;
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.status, 200);

    let reqs = server.received_requests().await.unwrap();
    let r = &reqs[0];
    assert_eq!(
        r.headers.get("x-goog-api-key").unwrap().to_str().unwrap(),
        "AIza-test"
    );
    assert!(
        r.headers.get("authorization").is_none(),
        "Authorization must not be set for x_goog_api_key auth"
    );
    assert_eq!(r.url.path(), "/v1beta/models/gemini-3-pro:generateContent");
    assert!(
        r.url.query().is_none(),
        "the non-streaming call must not ask for SSE"
    );
}

/// The streaming call must add `?alt=sse`, or Gemini answers with a JSON array
/// instead of an SSE stream and nothing would parse.
#[tokio::test]
async fn the_streaming_request_asks_for_sse_in_the_query() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body(&[
                    r#"data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}]}"#,
                ])),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, settled) = settle_recorder();
    let start = rayu_gateway_lib::adapters::genai::GenAi
        .stream(&up, request(&server.uri(), true), on_done)
        .await;
    let StreamStart::Streaming(resp) = start else {
        panic!("expected a stream");
    };
    let _ = resp.into_body().collect().await;
    wait_for_settle(&settled).await;

    let reqs = server.received_requests().await.unwrap();
    assert_eq!(
        reqs[0].url.path(),
        "/v1beta/models/gemini-3-pro:streamGenerateContent"
    );
    assert_eq!(reqs[0].url.query(), Some("alt=sse"));
}

#[tokio::test]
async fn stream_text_and_usage() {
    let (body, usage, err) = stream_genai(sse_body(&[
        r#"data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}"#,
        r#"data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":500,"candidatesTokenCount":10,"cachedContentTokenCount":400,"totalTokenCount":510}}"#,
    ]))
    .await;
    assert!(err.is_none(), "{err:?}");

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
        ]
    );
    let text: String = events
        .iter()
        .filter(|e| e.name == "content_block_delta")
        .map(|e| e.data["delta"]["text"].as_str().unwrap())
        .collect();
    assert_eq!(text, "Hello");

    let u = &events[events.len() - 2].data["usage"];
    assert_eq!(u["input_tokens"], 100, "500 prompt - 400 cached");
    assert_eq!(u["cache_read_input_tokens"], 400);

    let billed = usage.expect("usage");
    assert_eq!(billed.fresh_input_tokens(), 100);
    assert_eq!(billed.cache_read_tokens(), 400);
    assert_eq!(billed.completion_tokens, 10);
}

/// A thought part also carries `text`, so it must be recognised as thinking and not
/// leak the chain-of-thought into the visible answer.
#[tokio::test]
async fn thought_parts_become_thinking() {
    let (body, _, err) = stream_genai(sse_body(&[
        r#"data: {"candidates":[{"content":{"parts":[{"text":"considering","thought":true}]}}]}"#,
        r#"data: {"candidates":[{"content":{"parts":[{"text":"final"}]},"finishReason":"STOP"}]}"#,
    ]))
    .await;
    assert!(err.is_none(), "{err:?}");

    let events = sse_events(&body);
    let kinds: Vec<String> = events
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

    let (mut thinking, mut text) = (String::new(), String::new());
    for e in events.iter().filter(|e| e.name == "content_block_delta") {
        match e.data["delta"]["type"].as_str() {
            Some("thinking_delta") => {
                thinking.push_str(e.data["delta"]["thinking"].as_str().unwrap())
            }
            Some("text_delta") => text.push_str(e.data["delta"]["text"].as_str().unwrap()),
            _ => {}
        }
    }
    assert_eq!(thinking, "considering");
    assert_eq!(text, "final", "a thought part must NOT become visible text");
}

#[tokio::test]
async fn stream_function_call_relays_and_caches_the_signature() {
    let (body, _, err) = stream_genai(sse_body(&[
        r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}},"thoughtSignature":"SIG-1"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3,"totalTokenCount":12}}"#,
    ]))
    .await;
    assert!(err.is_none(), "{err:?}");

    let events = sse_events(&body);
    let block = events
        .iter()
        .find(|e| e.name == "content_block_start")
        .map(|e| &e.data["content_block"])
        .expect("a tool_use block");
    assert_eq!(block["type"], "tool_use");
    assert_eq!(block["name"], "read_file");

    let mut args = String::new();
    let mut sig = String::new();
    for e in events.iter().filter(|e| e.name == "content_block_delta") {
        match e.data["delta"]["type"].as_str() {
            Some("input_json_delta") => {
                args.push_str(e.data["delta"]["partial_json"].as_str().unwrap())
            }
            Some("signature_delta") => {
                sig = e.data["delta"]["signature"].as_str().unwrap().to_string()
            }
            _ => {}
        }
    }
    assert_eq!(
        args, r#"{"path":"a.txt"}"#,
        "Gemini sends complete args, so exactly one delta"
    );
    assert_eq!(
        sig, "SIG-1",
        "the thought signature must be relayed so the next turn can replay it"
    );

    // And cached under the id the client will echo back.
    let id = block["id"].as_str().unwrap();
    assert_eq!(
        rayu_gateway_lib::adapters::genai::thought_signature(id),
        "SIG-1",
        "signature not cached for id {id}"
    );

    let md = &events[events.len() - 2].data;
    assert_eq!(md["delta"]["stop_reason"], "tool_use");
}

#[tokio::test]
async fn stream_max_tokens_and_safety_stops() {
    for (finish, want) in [("MAX_TOKENS", "max_tokens"), ("SAFETY", "end_turn")] {
        let line = format!(
            r#"data: {{"candidates":[{{"content":{{"parts":[{{"text":"x"}}]}},"finishReason":"{finish}"}}]}}"#
        );
        let (body, _, err) = stream_genai(format!("{line}\n\n")).await;
        assert!(err.is_none(), "{finish}: {err:?}");
        let events = sse_events(&body);
        assert_eq!(
            events[events.len() - 2].data["delta"]["stop_reason"],
            want,
            "finishReason {finish}"
        );
    }
}

/// A provider auth failure must be masked: the message names the customer's Google
/// project.
#[tokio::test]
async fn a_preflight_error_is_masked() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(403).set_body_string(
            r#"{"error":{"message":"API key not valid for project secret-project-123"}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (on_done, _) = settle_recorder();
    let start = rayu_gateway_lib::adapters::genai::GenAi
        .stream(&up, request(&server.uri(), true), on_done)
        .await;
    let StreamStart::Failed {
        response, error, ..
    } = start
    else {
        panic!("a 403 must be a Failed outcome");
    };
    assert!(!error.is_empty());
    assert_eq!(
        response.status().as_u16(),
        502,
        "a provider auth failure is masked"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert!(
        !String::from_utf8_lossy(&body).contains("secret-project-123"),
        "provider detail leaked"
    );
}

#[tokio::test]
async fn complete_translation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_string(
                    r#"{"candidates":[{"content":{"parts":[
                    {"text":"weighing","thought":true},
                    {"text":"answer"},
                    {"functionCall":{"name":"list_dir","args":{"path":"."}},"thoughtSignature":"SIG-2"}
                ]},"finishReason":"STOP"}],
                "usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":8,"cachedContentTokenCount":60,"thoughtsTokenCount":4,"totalTokenCount":112}}"#,
                ),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::genai::GenAi
        .complete(&up, request(&server.uri(), false))
        .await;
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.status, 200);

    let body: Value = serde_json::from_slice(&out.body).unwrap();
    assert_eq!(body["type"], "message");
    assert_eq!(body["stop_reason"], "tool_use");

    let blocks = body["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 3, "{blocks:?}");
    assert_eq!(blocks[0]["type"], "thinking");
    assert_eq!(blocks[0]["thinking"], "weighing");
    assert_eq!(blocks[1]["text"], "answer");
    assert_eq!(blocks[2]["name"], "list_dir");
    assert_eq!(blocks[2]["input"]["path"], ".");
    assert_eq!(
        blocks[2]["thought_signature"], "SIG-2",
        "the signature travels back on the block so the next turn can replay it"
    );

    let u = out.usage.expect("usage");
    assert_eq!(u.fresh_input_tokens(), 40, "100 prompt - 60 cached");
    assert_eq!(u.cache_read_tokens(), 60);
    assert_eq!(
        u.completion_tokens, 12,
        "8 candidates + 4 thoughts, both billed as output"
    );
}

#[tokio::test]
async fn complete_returns_the_upstream_error_untranslated() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400).set_body_string(
            r#"{"error":{"message":"Invalid JSON payload received. Unknown name \"foo\""}}"#,
        ))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let out = rayu_gateway_lib::adapters::genai::GenAi
        .complete(&up, request(&server.uri(), false))
        .await;
    assert!(out.error.is_none(), "a 4xx is not an adapter error");
    assert_eq!(out.status, 400);
    assert!(String::from_utf8_lossy(&out.body).contains("Unknown name"));
}

#[test]
fn the_adapter_is_registered() {
    let a = rayu_gateway_lib::adapters::adapter_for(providercfg::FORMAT_GENAI)
        .expect("genai must be registered");
    assert_eq!(a.format(), providercfg::FORMAT_GENAI);
    assert!(rayu_gateway_lib::adapters::formats().contains(&providercfg::FORMAT_GENAI));
}
