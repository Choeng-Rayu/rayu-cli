//! Adapts the canonical Anthropic Messages request to OpenAI's Responses API
//! (`POST /v1/responses`) and back.
//!
//! Port of the Go gateway's `internal/translate/openai_responses.go`.
//!
//! Shape differences from chat-completions that matter here:
//!
//! * the conversation is a flat `input` ITEM list, not `messages`: a tool call is
//!   its own `function_call` item and its result a `function_call_output` item,
//!   paired by `call_id` (not by message position);
//! * the system prompt is `instructions`;
//! * text parts are `input_text` / `output_text`, images are `input_image`;
//! * function tools are FLAT (`{type, name, parameters}`), not nested under
//!   `function`;
//! * the token cap is `max_output_tokens`.
//!
//! Streaming order (from the official streaming-events reference):
//!
//! ```text
//! response.created -> response.in_progress -> response.output_item.added
//!   -> response.output_text.delta / response.function_call_arguments.delta /
//!      response.reasoning*.delta -> response.output_item.done -> response.completed
//! ```
//!
//! CRITICAL: `response.failed` and `response.incomplete` are TERMINAL EVENTS ON A
//! 200 STREAM, not HTTP errors -- so a 200 must not be treated as unconditional
//! success. `incomplete_details.reason == "max_tokens"` becomes Anthropic's
//! `max_tokens` stop reason, and usage is still settled when present.

use serde_json::{json, Value};

use super::common::{
    blocks_to_text, image_parts_from, null_to_default, num_field, reasoning_effort_for, string_of,
    system_text, thinking_requested,
};
use super::openai_chat::is_reasoning_model;
use super::{Adapter, AdapterRequest, CompleteOutcome};
use crate::providercfg;
use crate::sse::{
    anthropic_message_json, AnthropicEmitter, EventSink, OnStreamDone, SseScanner, StreamStart,
};
use crate::upstream::{self, Upstream, Usage};

/// Translates an Anthropic Messages request into a Responses API request.
pub fn build_responses_body(anth: &Value, model: &str, stream: bool) -> Vec<u8> {
    let mut req = serde_json::Map::new();
    req.insert("model".into(), json!(model));
    req.insert("input".into(), json!(responses_input(anth)));

    let sys = system_text(anth.get("system"));
    if !sys.is_empty() {
        // The system prompt is `instructions` on this API, not a message.
        req.insert("instructions".into(), json!(sys));
    }
    if let Some(mt) = num_field(anth, "max_tokens") {
        req.insert("max_output_tokens".into(), json!(mt as i64));
    }
    // Reasoning models on this API reject a custom temperature, same as on chat.
    if !is_reasoning_model().is_match(model) {
        if let Some(temp) = num_field(anth, "temperature") {
            req.insert("temperature".into(), json!(temp));
        }
        if let Some(tp) = num_field(anth, "top_p") {
            req.insert("top_p".into(), json!(tp));
        }
    }
    let tools = responses_tools(anth.get("tools"));
    if !tools.is_empty() {
        req.insert("tools".into(), json!(tools));
        if let Some(tc) = responses_tool_choice(anth.get("tool_choice")) {
            req.insert("tool_choice".into(), tc);
        }
    }
    if let Some(think) = thinking_requested(anth) {
        req.insert(
            "reasoning".into(),
            json!({"effort": reasoning_effort_for(think)}),
        );
    }
    if stream {
        req.insert("stream".into(), json!(true));
        // Delta events carry a random `obfuscation` padding field by default (a
        // side-channel mitigation) which is pure stream overhead for a
        // server-to-server relay. Ask for it off; the adapter ignores the field
        // regardless, so a provider that does not support the flag is unaffected.
        req.insert("include_obfuscation".into(), json!(false));
    }
    serde_json::to_vec(&Value::Object(req)).unwrap_or_else(|_| b"{}".to_vec())
}

/// Flattens Anthropic messages into Responses input items.
fn responses_input(anth: &Value) -> Vec<Value> {
    let Some(msgs) = anth.get("messages").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = Vec::with_capacity(msgs.len() + 2);

    for msg in msgs {
        if !msg.is_object() {
            continue;
        }
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let content = msg.get("content");

        if role == "assistant" {
            let mut text = String::new();
            match content {
                Some(Value::Array(blocks)) => {
                    for block in blocks {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                                    text.push_str(s);
                                }
                            }
                            Some("tool_use") => {
                                // A tool call is its own item, paired to its result
                                // by call_id.
                                let args = match block.get("input") {
                                    Some(v) if !v.is_null() => {
                                        serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
                                    }
                                    _ => "{}".to_string(),
                                };
                                out.push(json!({
                                    "type": "function_call",
                                    "call_id": block.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                                    "name": block.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                                    "arguments": args,
                                }));
                            }
                            _ => {}
                        }
                    }
                }
                Some(Value::String(s)) => text.push_str(s),
                _ => {}
            }
            if !text.is_empty() {
                out.push(json!({
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }));
            }
            continue;
        }

        // user (or any other) role.
        let Some(blocks) = content.and_then(|c| c.as_array()) else {
            let s = string_of(content);
            if !s.is_empty() {
                out.push(json!({
                    "role": "user",
                    "content": [{"type": "input_text", "text": s}],
                }));
            }
            continue;
        };

        let mut parts: Vec<Value> = Vec::new();
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("tool_result") => {
                    out.push(json!({
                        "type": "function_call_output",
                        "call_id": block.get("tool_use_id").and_then(|i| i.as_str()).unwrap_or(""),
                        "output": blocks_to_text(block.get("content")),
                    }));
                    // Images returned by a tool: function_call_output takes a
                    // string, so re-send them as user input parts.
                    parts.extend(responses_image_parts(block.get("content")));
                }
                Some("text") => {
                    if let Some(s) = block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        parts.push(json!({"type": "input_text", "text": s}));
                    }
                }
                Some("image") => {
                    let one = Value::Array(vec![block.clone()]);
                    parts.extend(responses_image_parts(Some(&one)));
                }
                _ => {}
            }
        }
        if !parts.is_empty() {
            out.push(json!({"role": "user", "content": parts}));
        }
    }
    out
}

/// Converts Anthropic image blocks into `input_image` parts.
fn responses_image_parts(content: Option<&Value>) -> Vec<Value> {
    image_parts_from(content)
        .into_iter()
        .filter_map(|p| {
            let url = p
                .get("image_url")
                .and_then(|iu| iu.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or("");
            if url.is_empty() {
                return None;
            }
            Some(json!({"type": "input_image", "image_url": url}))
        })
        .collect()
}

/// Emits FLAT function tools (the Responses shape).
fn responses_tools(raw: Option<&Value>) -> Vec<Value> {
    let Some(list) = raw.and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    let empty_schema = json!({"type": "object", "properties": {}});
    let mut out = Vec::with_capacity(list.len());

    for tool in list {
        if !tool.is_object() {
            continue;
        }
        let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let schema = tool.get("input_schema");
        let has_schema = schema.is_some();

        if name.is_empty() {
            // Already-OpenAI-shaped nested function tool: flatten it.
            let Some(f) = tool.get("function").filter(|f| f.is_object()) else {
                continue;
            };
            let fname = f.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if fname.is_empty() {
                continue;
            }
            let params = match f.get("parameters") {
                Some(p) if !p.is_null() => p.clone(),
                _ => empty_schema.clone(),
            };
            out.push(json!({
                "type": "function",
                "name": fname,
                "description": f.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                "parameters": params,
            }));
            continue;
        }
        // Anthropic server tools (versioned type, no schema) have no equivalent.
        let ty = tool.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if !ty.is_empty() && ty != "custom" && !has_schema {
            continue;
        }
        let params = match schema {
            Some(s) if !s.is_null() => s.clone(),
            _ => empty_schema.clone(),
        };
        out.push(json!({
            "type": "function",
            "name": name,
            "description": tool.get("description").and_then(|d| d.as_str()).unwrap_or(""),
            "parameters": params,
        }));
    }
    out
}

fn responses_tool_choice(raw: Option<&Value>) -> Option<Value> {
    let tc = raw?;
    if !tc.is_object() {
        return None;
    }
    match tc.get("type").and_then(|t| t.as_str()) {
        Some("auto") => Some(json!("auto")),
        Some("any") => Some(json!("required")),
        Some("none") => Some(json!("none")),
        Some("tool") => {
            match tc
                .get("name")
                .and_then(|n| n.as_str())
                .filter(|n| !n.is_empty())
            {
                // Responses names the function inline (no nested "function" object).
                Some(name) => Some(json!({"type": "function", "name": name})),
                None => Some(json!("required")),
            }
        }
        _ => None,
    }
}

// --- response translation ---------------------------------------------------

#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
struct CachedTokens {
    #[serde(default, deserialize_with = "null_to_default")]
    cached_tokens: i64,
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
struct ReasoningTokens {
    #[serde(default, deserialize_with = "null_to_default")]
    reasoning_tokens: i64,
}

/// The Responses token accounting.
///
/// `input_tokens` is the TOTAL prompt INCLUDING any cached prefix;
/// `input_tokens_details.cached_tokens` is optional (absent = no cache discount,
/// which is the correct billing outcome).
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
struct ResponsesUsage {
    #[serde(default, deserialize_with = "null_to_default")]
    input_tokens: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    output_tokens: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    total_tokens: i64,
    #[serde(default)]
    input_tokens_details: Option<CachedTokens>,
    #[serde(default)]
    output_tokens_details: Option<ReasoningTokens>,
}

impl ResponsesUsage {
    /// Normalizes into the billing buckets.
    ///
    /// Cached tokens are SUBTRACTED from input to get the fresh count, because
    /// `input_tokens` already includes them -- counting both would bill the cached
    /// prefix twice.
    fn to_usage(self) -> Usage {
        let cached = self
            .input_tokens_details
            .map(|d| d.cached_tokens)
            .unwrap_or(0)
            .min(self.input_tokens);
        let total = if self.total_tokens == 0 {
            self.input_tokens + self.output_tokens
        } else {
            self.total_tokens
        };
        Usage {
            prompt_tokens: self.input_tokens,
            completion_tokens: self.output_tokens,
            total_tokens: total,
            prompt_cache_hit_tokens: cached,
            prompt_cache_miss_tokens: self.input_tokens - cached,
            prompt_tokens_details: Default::default(),
            completion_tokens_details: upstream::CompletionTokensDetails {
                reasoning_tokens: self
                    .output_tokens_details
                    .map(|d| d.reasoning_tokens)
                    .unwrap_or(0),
            },
        }
    }
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct StreamItem {
    #[serde(default, rename = "type", deserialize_with = "null_to_default")]
    kind: String,
    #[serde(default, deserialize_with = "null_to_default")]
    id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    call_id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct IncompleteDetails {
    #[serde(default, deserialize_with = "null_to_default")]
    reason: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct ResponseError {
    #[serde(default, deserialize_with = "null_to_default")]
    code: String,
    #[serde(default, deserialize_with = "null_to_default")]
    message: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct TextPart {
    #[serde(default, rename = "type", deserialize_with = "null_to_default")]
    kind: String,
    #[serde(default, deserialize_with = "null_to_default")]
    text: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct OutputItem {
    #[serde(default, rename = "type", deserialize_with = "null_to_default")]
    kind: String,
    #[serde(default, deserialize_with = "null_to_default")]
    call_id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    arguments: String,
    #[serde(default, deserialize_with = "null_to_default")]
    content: Vec<TextPart>,
    #[serde(default, deserialize_with = "null_to_default")]
    summary: Vec<TextPart>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct ResponsesResponse {
    #[serde(default, deserialize_with = "null_to_default")]
    status: String,
    #[serde(default)]
    usage: Option<ResponsesUsage>,
    #[serde(default)]
    incomplete_details: Option<IncompleteDetails>,
    #[serde(default)]
    error: Option<ResponseError>,
    #[serde(default, deserialize_with = "null_to_default")]
    output: Vec<OutputItem>,
}

impl ResponsesResponse {
    fn truncated(&self) -> bool {
        self.incomplete_details
            .as_ref()
            .is_some_and(|d| d.reason == "max_tokens")
    }
}

/// One streaming event.
///
/// Only the fields the adapter acts on are decoded, so unknown or new event types
/// are ignored rather than breaking the turn.
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct ResponsesEvent {
    #[serde(default, rename = "type", deserialize_with = "null_to_default")]
    kind: String,
    /// Text / argument deltas.
    #[serde(default, deserialize_with = "null_to_default")]
    delta: String,
    /// Item lifecycle (function calls arrive as items).
    #[serde(default)]
    item: Option<StreamItem>,
    /// Terminal events carry the whole response object.
    #[serde(default)]
    response: Option<ResponsesResponse>,
}

/// Whether an event type carries reasoning text.
///
/// Both `response.reasoning_text.delta` and `response.reasoning_summary_text.delta`
/// exist depending on model and config, so match on the family.
fn is_reasoning_delta(event_type: &str) -> bool {
    event_type.starts_with("response.reasoning") && event_type.ends_with(".delta")
}

/// The `openai_responses` adapter.
pub struct OpenAiResponses;

#[async_trait::async_trait]
impl Adapter for OpenAiResponses {
    fn format(&self) -> &'static str {
        providercfg::FORMAT_OPENAI_RESPONSES
    }

    async fn stream(
        &self,
        up: &Upstream,
        req: AdapterRequest,
        on_done: OnStreamDone,
    ) -> StreamStart {
        let body = build_responses_body(&req.anthropic, &req.upstream_model_id, true);
        let url = req.route.endpoint();
        let route = req.route.clone();

        let sent = up
            .send_with_failover(
                &req.keys,
                |secret| {
                    let mut r = crate::sse::new_upstream_req(
                        up.client(),
                        &url,
                        secret,
                        &route,
                        body.clone(),
                    )?;
                    r.headers_mut().insert(
                        http::header::ACCEPT,
                        http::HeaderValue::from_static("text/event-stream"),
                    );
                    Ok(r)
                },
                req.on_key_failure.as_ref(),
            )
            .await;

        let (resp, _) = match sent {
            Ok(v) => v,
            Err(e) => return StreamStart::Unreachable(e),
        };
        let status = resp.status().as_u16();
        if status != 200 {
            let raw = resp.bytes().await.unwrap_or_default();
            let error = format!("upstream status {status}: {}", upstream::err_snippet(&raw));
            return StreamStart::Failed {
                response: upstream::relay_upstream_error(status, &raw),
                error,
                usage: None,
            };
        }

        let (sink, response) = EventSink::new_response(req.keepalive_seconds);
        let model = req.upstream_model_id.clone();
        let byte_stream = resp.bytes_stream();

        tokio::spawn(async move {
            let reader = tokio_util::io::StreamReader::new(futures::TryStreamExt::map_err(
                byte_stream,
                std::io::Error::other,
            ));
            let mut scanner = SseScanner::new(reader);
            let mut em = AnthropicEmitter::new(sink, &model);
            let mut usage: Option<Usage> = None;
            let mut stop = String::new();
            let mut saw_tool_call = false;
            let mut scan_err: Option<String> = None;
            // Set by a terminal `response.failed` event: a 200 stream can still
            // report failure, and the caller must learn about it.
            let mut failure: Option<String> = None;

            while let Some(item) = scanner.next_data().await {
                let payload = match item {
                    Ok(p) => p,
                    Err(e) => {
                        scan_err = Some(e.to_string());
                        break;
                    }
                };
                let Ok(ev) = serde_json::from_slice::<ResponsesEvent>(&payload) else {
                    continue;
                };

                let write = match ev.kind.as_str() {
                    "response.output_text.delta" => em.text(&ev.delta).await,
                    "response.output_item.added" => {
                        // A function call starts as an item; its arguments then
                        // stream separately.
                        match ev.item.as_ref().filter(|i| i.kind == "function_call") {
                            Some(i) => {
                                saw_tool_call = true;
                                let id = if i.call_id.is_empty() {
                                    &i.id
                                } else {
                                    &i.call_id
                                };
                                em.tool_start(id, &i.name).await
                            }
                            None => Ok(()),
                        }
                    }
                    "response.function_call_arguments.delta" => em.tool_args(&ev.delta).await,
                    // Arguments were already streamed as deltas.
                    "response.function_call_arguments.done" => Ok(()),
                    "response.completed" | "response.incomplete" | "response.failed" => {
                        if let Some(r) = ev.response.as_ref() {
                            if let Some(u) = r.usage {
                                usage = Some(u.to_usage());
                            }
                            // max_tokens truncation is reported HERE, not as an
                            // HTTP error.
                            if r.truncated() {
                                stop = "max_tokens".to_string();
                            }
                            if ev.kind == "response.failed" {
                                failure = Some(match r.error.as_ref() {
                                    Some(e) => format!(
                                        "upstream response failed ({}): {}",
                                        e.code, e.message
                                    ),
                                    None => "upstream reported the response failed".to_string(),
                                });
                            }
                        } else if ev.kind == "response.failed" {
                            failure = Some("upstream reported the response failed".to_string());
                        }
                        Ok(())
                    }
                    other if is_reasoning_delta(other) => em.thinking(&ev.delta).await,
                    _ => Ok(()),
                };
                if write.is_err() {
                    break; // the client hung up
                }
            }

            if stop.is_empty() && saw_tool_call {
                stop = "tool_use".to_string();
            }
            if let Some(e) = scan_err {
                let _ = em
                    .error("The model provider ended the response unexpectedly.")
                    .await;
                let _ = em.finish(&stop, usage.as_ref()).await;
                on_done(usage, Some(e));
                return;
            }
            if let Some(e) = failure {
                // Terminal failure on a 200 stream: tell the client, close the
                // stream cleanly, and report the error so it is logged and settled.
                // The provider's own message is NOT forwarded -- it can name a
                // provider or carry an upsell URL.
                let _ = em
                    .error("The model provider could not complete this response.")
                    .await;
                let _ = em.finish(&stop, usage.as_ref()).await;
                on_done(usage, Some(e));
                return;
            }
            let _ = em.finish(&stop, usage.as_ref()).await;
            on_done(usage, None);
        });

        StreamStart::Streaming(response)
    }

    async fn complete(&self, up: &Upstream, req: AdapterRequest) -> CompleteOutcome {
        let body = build_responses_body(&req.anthropic, &req.upstream_model_id, false);
        let url = req.route.endpoint();
        let route = req.route.clone();

        let sent = up
            .send_with_failover(
                &req.keys,
                |secret| {
                    crate::sse::new_upstream_req(up.client(), &url, secret, &route, body.clone())
                },
                req.on_key_failure.as_ref(),
            )
            .await;
        let (resp, _) = match sent {
            Ok(v) => v,
            Err(e) => return CompleteOutcome::unreachable(e.to_string()),
        };

        let status = resp.status().as_u16();
        let raw = resp.bytes().await.unwrap_or_default().to_vec();
        if status != 200 {
            return CompleteOutcome {
                usage: None,
                status,
                body: raw,
                error: None,
            };
        }

        let parsed: ResponsesResponse = match serde_json::from_slice(&raw) {
            Ok(p) => p,
            Err(e) => {
                return CompleteOutcome {
                    usage: None,
                    status,
                    body: raw,
                    error: Some(format!("unparseable upstream response: {e}")),
                }
            }
        };
        let usage = parsed.usage.map(|u| u.to_usage());

        let mut blocks: Vec<Value> = Vec::with_capacity(3);
        let mut saw_tool_call = false;
        for item in &parsed.output {
            match item.kind.as_str() {
                "reasoning" => {
                    let text: String = item.summary.iter().map(|s| s.text.as_str()).collect();
                    if !text.is_empty() {
                        blocks.push(json!({"type": "thinking", "thinking": text, "signature": ""}));
                    }
                }
                "message" => {
                    let text: String = item
                        .content
                        .iter()
                        .filter(|c| c.kind == "output_text")
                        .map(|c| c.text.as_str())
                        .collect();
                    if !text.is_empty() {
                        blocks.push(json!({"type": "text", "text": text}));
                    }
                }
                "function_call" => {
                    saw_tool_call = true;
                    let input: Value = if item.arguments.is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&item.arguments).unwrap_or_else(|_| json!({}))
                    };
                    blocks.push(json!({
                        "type": "tool_use", "id": item.call_id, "name": item.name, "input": input,
                    }));
                }
                _ => {}
            }
        }

        let stop = if parsed.truncated() {
            "max_tokens"
        } else if saw_tool_call {
            "tool_use"
        } else {
            "end_turn"
        };

        // A failed response is a provider-side failure even though HTTP said 200;
        // let the caller mask it rather than presenting a half-empty message as
        // success.
        if parsed.status == "failed" {
            let msg = parsed
                .error
                .as_ref()
                .map(|e| e.message.clone())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| "the model provider could not complete this response".into());
            return CompleteOutcome {
                usage,
                status: 502,
                body: raw,
                error: Some(format!("upstream response failed: {msg}")),
            };
        }

        let out = anthropic_message_json(&req.upstream_model_id, stop, blocks, usage.as_ref());
        CompleteOutcome {
            usage,
            status,
            body: out,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(anth: Value, model: &str, stream: bool) -> Value {
        serde_json::from_slice(&build_responses_body(&anth, model, stream)).expect("valid JSON")
    }

    #[test]
    fn body_basics() {
        let got = build(
            json!({
                "system": "be brief",
                "max_tokens": 256,
                "temperature": 0.4,
                "messages": [{"role": "user", "content": "hi"}],
            }),
            "gpt-5.5-mini",
            true,
        );
        assert_eq!(got["model"], "gpt-5.5-mini");
        // The system prompt is `instructions` on this API, not a message.
        assert_eq!(got["instructions"], "be brief");
        // The token cap is max_output_tokens.
        assert_eq!(got["max_output_tokens"], 256);
        assert!(
            got.get("max_tokens").is_none(),
            "max_tokens must not be sent to the Responses API"
        );
        // gpt-5 is a reasoning family: temperature must be omitted.
        assert!(got.get("temperature").is_none());
        assert_eq!(got["stream"], true);
        // Obfuscation padding is pure overhead for a server-to-server relay.
        assert_eq!(got["include_obfuscation"], false);

        let input = got["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(
            input[0]["content"][0]["type"], "input_text",
            "text parts must be input_text"
        );
    }

    /// A non-reasoning model keeps both sampling parameters -- unlike chat, this API
    /// gates `top_p` on the reasoning check too.
    #[test]
    fn sampling_params_survive_for_a_normal_model() {
        let got = build(
            json!({"temperature": 0.4, "top_p": 0.8, "messages": []}),
            "gpt-4.1",
            false,
        );
        assert_eq!(got["temperature"], 0.4);
        assert_eq!(got["top_p"], 0.8);

        // And a reasoning model loses BOTH.
        let got = build(
            json!({"temperature": 0.4, "top_p": 0.8, "messages": []}),
            "gpt-5.5",
            false,
        );
        assert!(got.get("temperature").is_none());
        assert!(
            got.get("top_p").is_none(),
            "top_p is gated on the same check on this API"
        );
    }

    /// Tool calls and their results are separate ITEMS paired by `call_id` -- not
    /// position-dependent messages as in chat-completions.
    #[test]
    fn a_tool_call_round_trip_becomes_items() {
        let got = build(
            json!({"messages": [
                {"role": "user", "content": "read it"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "sure"},
                    {"type": "tool_use", "id": "call_1", "name": "read_file",
                     "input": {"path": "a.txt"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1",
                     "content": [{"type": "text", "text": "contents"}]},
                ]},
            ]}),
            "gpt-5.5",
            false,
        );

        let input = got["input"].as_array().unwrap();
        let types: Vec<String> = input
            .iter()
            .map(|item| match item.get("type").and_then(|t| t.as_str()) {
                Some(t) => t.to_string(),
                None => format!("message:{}", item["role"].as_str().unwrap()),
            })
            .collect();
        assert_eq!(
            types,
            vec![
                "message:user",
                "function_call",
                "message:assistant",
                "function_call_output"
            ],
            "the assistant's tool_use item comes BEFORE its text item"
        );

        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(input[1]["name"], "read_file");
        assert!(input[1]["arguments"].as_str().unwrap().contains("a.txt"));
        // The result must reference the SAME call_id, which is how they pair up.
        assert_eq!(input[3]["call_id"], "call_1");
        assert_eq!(input[3]["output"], "contents");
        // Assistant text uses output_text.
        assert_eq!(input[2]["content"][0]["type"], "output_text");
    }

    #[test]
    fn tools_are_flat_and_images_are_input_image() {
        let got = build(
            json!({
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": "see"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
                ]}],
                "tools": [
                    {"name": "read_file", "description": "Read", "input_schema": {"type": "object"}},
                    {"type": "web_search_20260301", "name": "web_search"},
                ],
                "tool_choice": {"type": "tool", "name": "read_file"},
            }),
            "gpt-4.1",
            false,
        );

        let tools = got["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1, "the server tool must be dropped");
        // FLAT shape: no nested "function" object on this API.
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["name"], "read_file");
        assert!(!tools[0]["parameters"].is_null());
        assert!(
            tools[0].get("function").is_none(),
            "Responses tools must not nest under `function`"
        );

        assert_eq!(got["tool_choice"]["type"], "function");
        assert_eq!(got["tool_choice"]["name"], "read_file");

        let parts = got["input"][0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["type"], "input_image");
        assert_eq!(
            parts[1]["image_url"], "data:image/png;base64,AAAA",
            "the image URL is a bare string on this API, not a nested object"
        );
    }

    /// An already-OpenAI-shaped nested tool must be FLATTENED, not passed through as
    /// chat does -- this API would reject the nested form.
    #[test]
    fn a_nested_openai_tool_is_flattened() {
        let tools = responses_tools(Some(&json!([
            {"type": "function", "function": {"name": "x", "description": "d",
             "parameters": {"type": "object"}}},
            // Nameless even after unwrapping: skipped.
            {"type": "function", "function": {"description": "no name"}},
            // No function object and no name: skipped.
            {"type": "function"},
        ])));
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "x");
        assert_eq!(tools[0]["description"], "d");
        assert!(tools[0].get("function").is_none());

        // A nested tool with no parameters still gets a usable schema.
        let tools = responses_tools(Some(&json!([
            {"type": "function", "function": {"name": "y"}},
        ])));
        assert_eq!(tools[0]["parameters"]["type"], "object");
    }

    #[test]
    fn tool_choice_variants() {
        let cases: [(Value, Value); 5] = [
            (json!({"type": "auto"}), json!("auto")),
            (json!({"type": "any"}), json!("required")),
            (json!({"type": "none"}), json!("none")),
            (
                json!({"type": "tool", "name": "bash"}),
                json!({"type": "function", "name": "bash"}),
            ),
            (json!({"type": "tool"}), json!("required")),
        ];
        for (input, want) in cases {
            assert_eq!(responses_tool_choice(Some(&input)), Some(want), "{input}");
        }
        assert_eq!(responses_tool_choice(None), None);
        assert_eq!(responses_tool_choice(Some(&json!({"type": "??"}))), None);
    }

    #[test]
    fn thinking_maps_to_reasoning_effort() {
        let got = build(
            json!({
                "thinking": {"type": "enabled", "budget_tokens": 20000},
                "messages": [{"role": "user", "content": "hi"}],
            }),
            "gpt-5.5",
            false,
        );
        assert_eq!(got["reasoning"]["effort"], "high");

        let off = build(
            json!({
                "thinking": {"type": "disabled"},
                "messages": [{"role": "user", "content": "hi"}],
            }),
            "gpt-5.5",
            false,
        );
        assert!(off.get("reasoning").is_none());
    }

    /// `input_tokens` INCLUDES cached tokens, so fresh must be derived by
    /// SUBTRACTION -- otherwise the cached prefix is billed twice.
    #[test]
    fn usage_cache_subtraction() {
        let u: ResponsesUsage = serde_json::from_str(
            r#"{"input_tokens":1000,"output_tokens":50,"total_tokens":1050,
                "input_tokens_details":{"cached_tokens":900},
                "output_tokens_details":{"reasoning_tokens":30}}"#,
        )
        .unwrap();
        let got = u.to_usage();
        assert_eq!(got.prompt_tokens, 1000);
        assert_eq!(got.completion_tokens, 50);
        assert_eq!(got.total_tokens, 1050);
        assert_eq!(got.cache_read_tokens(), 900);
        assert_eq!(
            got.fresh_input_tokens(),
            100,
            "1000 total - 900 cached, NOT 1000"
        );
        assert_eq!(got.completion_tokens_details.reasoning_tokens, 30);
    }

    /// The documented usage example has NO `input_tokens_details`, so it must be
    /// optional: absent means no cache discount.
    #[test]
    fn usage_without_cache_details() {
        let u: ResponsesUsage =
            serde_json::from_str(r#"{"input_tokens":40,"output_tokens":5,"total_tokens":45}"#)
                .unwrap();
        let got = u.to_usage();
        assert_eq!(got.cache_read_tokens(), 0);
        assert_eq!(got.fresh_input_tokens(), 40);
    }

    /// A missing total must be derived, and a cached count larger than the input
    /// must be clamped rather than producing a negative fresh count.
    #[test]
    fn usage_edge_cases() {
        let u: ResponsesUsage =
            serde_json::from_str(r#"{"input_tokens":10,"output_tokens":4}"#).unwrap();
        assert_eq!(
            u.to_usage().total_tokens,
            14,
            "total is derived when absent"
        );

        let u: ResponsesUsage = serde_json::from_str(
            r#"{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":99}}"#,
        )
        .unwrap();
        let got = u.to_usage();
        assert_eq!(got.cache_read_tokens(), 10, "clamped to the input total");
        assert_eq!(
            got.fresh_input_tokens(),
            0,
            "never negative -- a negative would corrupt the credit math"
        );
    }

    #[test]
    fn reasoning_delta_family_matching() {
        assert!(is_reasoning_delta("response.reasoning_text.delta"));
        assert!(is_reasoning_delta("response.reasoning_summary_text.delta"));
        assert!(is_reasoning_delta("response.reasoning.delta"));
        // Not a delta, and not reasoning.
        assert!(!is_reasoning_delta("response.reasoning_text.done"));
        assert!(!is_reasoning_delta("response.output_text.delta"));
    }

    #[test]
    fn an_event_with_null_fields_decodes() {
        let ev: ResponsesEvent = serde_json::from_str(
            r#"{"type":"response.output_text.delta","delta":null,"item":null,"response":null}"#,
        )
        .expect("null fields must decode");
        assert_eq!(ev.delta, "");
        assert!(ev.item.is_none());
    }

    #[test]
    fn a_string_user_message_becomes_an_input_text_item() {
        let got = build(
            json!({"messages": [{"role": "user", "content": "plain"}]}),
            "gpt-4.1",
            false,
        );
        assert_eq!(got["input"][0]["content"][0]["text"], "plain");
        // An empty string produces no item at all.
        let got = build(
            json!({"messages": [{"role": "user", "content": ""}]}),
            "gpt-4.1",
            false,
        );
        assert!(got["input"].as_array().unwrap().is_empty());
    }

    /// A tool result carrying images must still emit the string output item, with the
    /// images re-sent as user input parts.
    #[test]
    fn tool_result_images_become_user_input_parts() {
        let got = build(
            json!({"messages": [{"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1", "content": [
                    {"type": "text", "text": "shot"},
                    {"type": "image", "source": {"type": "base64", "data": "BBBB"}},
                ]},
            ]}]}),
            "gpt-4.1",
            false,
        );
        let input = got["input"].as_array().unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], "function_call_output");
        assert_eq!(input[0]["output"], "shot");
        assert_eq!(input[1]["role"], "user");
        assert_eq!(input[1]["content"][0]["type"], "input_image");
    }

    #[test]
    fn a_non_streaming_body_omits_the_stream_flags() {
        let got = build(json!({"messages": []}), "gpt-4.1", false);
        assert!(got.get("stream").is_none());
        assert!(got.get("include_obfuscation").is_none());
    }
}
