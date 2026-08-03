//! Adapts the canonical Anthropic Messages request to an OpenAI-compatible
//! `/v1/chat/completions` provider and back.
//!
//! Port of the Go gateway's `internal/translate/openai_chat.go`.
//!
//! The mapping mirrors the CLI's own long-serving OpenAI adapter, because that is
//! the behaviour proven against real providers (DeepSeek, DeepInfra, OpenRouter,
//! Gemini's OpenAI-compat layer, Kimi). The notable hard-won details, kept
//! deliberately:
//!
//! * assistant content is `""` (never `null`) when a turn is only tool calls --
//!   Gemini's OpenAI-compat layer rejects null content;
//! * `tool` messages must come immediately after the assistant turn that made the
//!   calls, so tool results are emitted before any user text;
//! * a tool result containing images becomes a follow-up user message, since a
//!   `tool` message's content must be a string;
//! * reasoning families (o1/o3/o4/gpt-5) need `max_completion_tokens` instead of
//!   `max_tokens` and reject a custom temperature.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use super::common::{
    blocks_to_text, image_parts_from, null_to_default, num_field, reasoning_effort_for, string_of,
    system_text, thinking_requested,
};
use super::{Adapter, AdapterRequest, CompleteOutcome};
use crate::providercfg;
use crate::sse::{
    anthropic_message_json, AnthropicEmitter, EventSink, OnStreamDone, SseScanner, StreamStart,
};
use crate::upstream::{self, Upstream, Usage};

/// Matches the OpenAI reasoning families that reject `max_tokens`.
///
/// Matched as a path/segment token so `gpt-4o` (no standalone o3/o4) and `llama-3`
/// are unaffected.
fn needs_max_completion_tokens() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[/_-])(o1|o3|o4|gpt-5)(?:[._\-]|$)").expect("valid regex")
    })
}

/// Broader than [`needs_max_completion_tokens`] (adds `gpt-oss` / `*reason*` /
/// `*thinking*`) and used only to omit `temperature`, which reasoning models reject
/// or ignore.
pub(crate) fn is_reasoning_model() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[/_-])(o1|o3|o4|gpt-5|gpt-oss)(?:[._\-]|$)|reason|thinking")
            .expect("valid regex")
    })
}

/// Translates an Anthropic Messages request into an OpenAI chat-completions request.
pub fn build_openai_chat_body(anth: &Value, model: &str, stream: bool) -> Vec<u8> {
    let mut req = serde_json::Map::new();
    req.insert("model".into(), json!(model));
    req.insert("messages".into(), json!(openai_messages(anth)));

    if let Some(mt) = num_field(anth, "max_tokens") {
        if needs_max_completion_tokens().is_match(model) {
            req.insert("max_completion_tokens".into(), json!(mt as i64));
        } else {
            req.insert("max_tokens".into(), json!(mt as i64));
        }
    }
    if !is_reasoning_model().is_match(model) {
        if let Some(temp) = num_field(anth, "temperature") {
            req.insert("temperature".into(), json!(temp));
        }
    }
    if let Some(tp) = num_field(anth, "top_p") {
        req.insert("top_p".into(), json!(tp));
    }
    if let Some(stops) = anth.get("stop_sequences").and_then(|s| s.as_array()) {
        if !stops.is_empty() {
            req.insert("stop".into(), Value::Array(stops.clone()));
        }
    }
    let tools = openai_tools(anth.get("tools"));
    if !tools.is_empty() {
        req.insert("tools".into(), json!(tools));
        if let Some(tc) = openai_tool_choice(anth.get("tool_choice")) {
            req.insert("tool_choice".into(), tc);
        }
    }
    // Extended thinking -> reasoning effort. Anthropic expresses a token budget;
    // OpenAI-compatible providers take a coarse effort level, so map by budget.
    if let Some(think) = thinking_requested(anth) {
        req.insert(
            "reasoning_effort".into(),
            json!(reasoning_effort_for(think)),
        );
    }
    if stream {
        req.insert("stream".into(), json!(true));
        // Ask for usage on the final chunk -- without this most providers stream no
        // usage at all and the request could not be billed accurately.
        req.insert("stream_options".into(), json!({"include_usage": true}));
    }
    serde_json::to_vec(&Value::Object(req)).unwrap_or_else(|_| b"{}".to_vec())
}

/// Translates `system` plus `messages[]` into OpenAI `messages[]`.
fn openai_messages(anth: &Value) -> Vec<Value> {
    let mut out = Vec::with_capacity(8);
    let sys = system_text(anth.get("system"));
    if !sys.is_empty() {
        out.push(json!({"role": "system", "content": sys}));
    }
    let Some(msgs) = anth.get("messages").and_then(|m| m.as_array()) else {
        return out;
    };
    for msg in msgs {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let content = msg.get("content");
        match role {
            "assistant" => out.push(openai_assistant_message(content)),
            "user" => out.extend(openai_user_messages(content)),
            other => out.push(json!({"role": other, "content": blocks_to_text(content)})),
        }
    }
    out
}

fn openai_assistant_message(content: Option<&Value>) -> Value {
    let mut text = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();

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
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("");
                        // A missing or null input becomes "{}" rather than "null",
                        // which providers reject.
                        let args = match block.get("input") {
                            Some(v) if !v.is_null() => {
                                serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
                            }
                            _ => "{}".to_string(),
                        };
                        tool_calls.push(json!({
                            "id": id,
                            "type": "function",
                            "function": {"name": name, "arguments": args},
                        }));
                    }
                    _ => {}
                }
            }
        }
        Some(Value::String(s)) => text.push_str(s),
        _ => {}
    }

    // Content must be a STRING, never null: some OpenAI-compatibility layers
    // (notably Gemini's) 400 on a null field for every subsequent request once a
    // tool-call turn is in history.
    let mut m = serde_json::Map::new();
    m.insert("role".into(), json!("assistant"));
    m.insert("content".into(), json!(text));
    if !tool_calls.is_empty() {
        m.insert("tool_calls".into(), json!(tool_calls));
    }
    Value::Object(m)
}

/// Expands one Anthropic user turn -- which may mix tool results, text and images --
/// into the OpenAI message sequence those require.
fn openai_user_messages(content: Option<&Value>) -> Vec<Value> {
    let Some(blocks) = content.and_then(|c| c.as_array()) else {
        return vec![json!({"role": "user", "content": string_of(content)})];
    };

    let mut out: Vec<Value> = Vec::with_capacity(4);
    let mut tool_images: Vec<Value> = Vec::new();

    // Tool results FIRST: OpenAI requires `tool` messages to directly follow the
    // assistant message whose tool_calls they answer.
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let id = block
            .get("tool_use_id")
            .and_then(|i| i.as_str())
            .unwrap_or("");
        out.push(json!({
            "role": "tool",
            "tool_call_id": id,
            "content": blocks_to_text(block.get("content")),
        }));
        tool_images.extend(image_parts_from(block.get("content")));
    }

    // A `tool` message's content must be a string, so images a tool returned are
    // re-sent as a normal user message.
    if !tool_images.is_empty() {
        let mut parts = vec![json!({
            "type": "text",
            "text": "Images returned by the previous tool call(s):",
        })];
        parts.extend(tool_images);
        out.push(json!({"role": "user", "content": parts}));
    }

    // Remaining (non-tool_result) content.
    let rest: Vec<Value> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) != Some("tool_result"))
        .cloned()
        .collect();
    let rest = Value::Array(rest);
    let text = blocks_to_text(Some(&rest));
    let images = image_parts_from(Some(&rest));

    if !images.is_empty() {
        let mut parts: Vec<Value> = Vec::with_capacity(images.len() + 1);
        if !text.is_empty() {
            parts.push(json!({"type": "text", "text": text}));
        }
        parts.extend(images);
        out.push(json!({"role": "user", "content": parts}));
    } else if !text.is_empty() {
        out.push(json!({"role": "user", "content": text}));
    }
    out
}

/// Translates Anthropic `tools[]` into OpenAI function tools.
///
/// Anthropic SERVER tools (web_search, advisor) carry a versioned `type` and no
/// `input_schema`; they have no OpenAI equivalent and are DROPPED rather than sent
/// as a phantom empty function the model might try to call.
fn openai_tools(raw: Option<&Value>) -> Vec<Value> {
    let Some(list) = raw.and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(list.len());
    for tool in list {
        if !tool.is_object() {
            continue;
        }
        // Already OpenAI-shaped: pass through untouched.
        if tool.get("function").is_some_and(|f| !f.is_null()) {
            out.push(tool.clone());
            continue;
        }
        let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let schema = tool.get("input_schema");
        let has_schema = schema.is_some();
        let ty = tool.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if !ty.is_empty() && ty != "custom" && !has_schema {
            continue; // a server tool with no JSON schema
        }
        let parameters = match schema {
            Some(s) if !s.is_null() => s.clone(),
            _ => json!({"type": "object", "properties": {}}),
        };
        let desc = tool
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("");
        out.push(json!({
            "type": "function",
            "function": {"name": name, "description": desc, "parameters": parameters},
        }));
    }
    out
}

fn openai_tool_choice(raw: Option<&Value>) -> Option<Value> {
    let tc = raw?;
    if !tc.is_object() {
        return None;
    }
    match tc.get("type").and_then(|t| t.as_str()) {
        Some("auto") => Some(json!("auto")),
        Some("any") => Some(json!("required")),
        Some("none") => Some(json!("none")),
        Some("tool") => match tc
            .get("name")
            .and_then(|n| n.as_str())
            .filter(|n| !n.is_empty())
        {
            Some(name) => Some(json!({"type": "function", "function": {"name": name}})),
            None => Some(json!("required")),
        },
        _ => None,
    }
}

/// Maps an OpenAI `finish_reason` to an Anthropic `stop_reason`.
fn stop_reason_for(finish: &str) -> &'static str {
    match finish {
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        "" => "",
        _ => "end_turn",
    }
}

/// Normalizes the several shapes providers use for hidden reasoning.
///
/// `content_field` is DeepSeek/Kimi's `reasoning_content`; `direct` is the
/// `reasoning` field, which OpenRouter and Qwen send as a string, an object with
/// `text`/`content`, or an array of either.
fn reasoning_text(direct: Option<&Value>, content_field: &str) -> String {
    if !content_field.is_empty() {
        return content_field.to_string();
    }
    match direct {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => {
            let v = direct.expect("matched Object");
            if let Some(s) = v.get("text").and_then(|t| t.as_str()) {
                return s.to_string();
            }
            v.get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string()
        }
        Some(Value::Array(items)) => {
            let mut b = String::new();
            for item in items {
                match item {
                    Value::String(s) => b.push_str(s),
                    Value::Object(_) => {
                        if let Some(s) = item.get("text").and_then(|t| t.as_str()) {
                            b.push_str(s);
                        } else if let Some(s) = item.get("content").and_then(|c| c.as_str()) {
                            b.push_str(s);
                        }
                    }
                    _ => {}
                }
            }
            b
        }
        _ => String::new(),
    }
}

// --- upstream wire shapes ---------------------------------------------------

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct FnDelta {
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    arguments: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<i64>,
    #[serde(default, deserialize_with = "null_to_default")]
    id: String,
    #[serde(default)]
    function: FnDelta,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct Delta {
    #[serde(default, deserialize_with = "null_to_default")]
    content: String,
    #[serde(default)]
    reasoning: Option<Value>,
    #[serde(default, deserialize_with = "null_to_default")]
    reasoning_content: String,
    #[serde(default, deserialize_with = "null_to_default")]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    message: Delta,
    #[serde(default, deserialize_with = "null_to_default")]
    finish_reason: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct Chunk {
    #[serde(default, deserialize_with = "null_to_default")]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Usage>,
}

/// The `openai_chat` adapter.
pub struct OpenAiChat;

#[async_trait::async_trait]
impl Adapter for OpenAiChat {
    fn format(&self) -> &'static str {
        providercfg::FORMAT_OPENAI_CHAT
    }

    async fn stream(
        &self,
        up: &Upstream,
        req: AdapterRequest,
        on_done: OnStreamDone,
    ) -> StreamStart {
        let body = build_openai_chat_body(&req.anthropic, &req.upstream_model_id, true);
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
            // Tool calls stream as fragments keyed by index; a new index means a new
            // call.
            let mut cur_tool_index: i64 = -1;
            let mut failure: Option<String> = None;

            while let Some(item) = scanner.next_data().await {
                let payload = match item {
                    Ok(p) => p,
                    Err(e) => {
                        failure = Some(e.to_string());
                        break;
                    }
                };
                // Ignore an unparseable chunk rather than killing the turn.
                let Ok(chunk) = serde_json::from_slice::<Chunk>(&payload) else {
                    continue;
                };
                if let Some(u) = chunk.usage.filter(|u| u.total_tokens > 0) {
                    usage = Some(u);
                }

                let mut broke = false;
                for choice in &chunk.choices {
                    let reasoning = reasoning_text(
                        choice.delta.reasoning.as_ref(),
                        &choice.delta.reasoning_content,
                    );
                    if !reasoning.is_empty() && em.thinking(&reasoning).await.is_err() {
                        broke = true;
                        break;
                    }
                    if !choice.delta.content.is_empty()
                        && em.text(&choice.delta.content).await.is_err()
                    {
                        broke = true;
                        break;
                    }
                    for tc in &choice.delta.tool_calls {
                        let idx = tc.index.unwrap_or(cur_tool_index);
                        // A new index -- or a chunk carrying a name -- starts a new call.
                        if idx != cur_tool_index || !tc.function.name.is_empty() {
                            if em.tool_start(&tc.id, &tc.function.name).await.is_err() {
                                broke = true;
                                break;
                            }
                            cur_tool_index = idx;
                        }
                        if em.tool_args(&tc.function.arguments).await.is_err() {
                            broke = true;
                            break;
                        }
                    }
                    if broke {
                        break;
                    }
                    if !choice.finish_reason.is_empty() {
                        stop = stop_reason_for(&choice.finish_reason).to_string();
                    }
                }
                if broke {
                    break; // the client hung up
                }
            }

            if let Some(err) = &failure {
                // The stream broke mid-flight. Tell the client (it has already
                // received events, so an HTTP status is no longer available) and
                // report the usage seen so far so the caller settles what was
                // actually consumed.
                let _ = em
                    .error("The model provider ended the response unexpectedly.")
                    .await;
                let _ = em.finish(&stop, usage.as_ref()).await;
                on_done(usage, Some(err.clone()));
                return;
            }
            let _ = em.finish(&stop, usage.as_ref()).await;
            on_done(usage, None);
        });

        StreamStart::Streaming(response)
    }

    async fn complete(&self, up: &Upstream, req: AdapterRequest) -> CompleteOutcome {
        let body = build_openai_chat_body(&req.anthropic, &req.upstream_model_id, false);
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
            // Hand the upstream body back untranslated; the caller decides whether to
            // relay it (client-fixable 4xx) or mask it (provider failure).
            return CompleteOutcome {
                usage: None,
                status,
                body: raw,
                error: None,
            };
        }

        let parsed: Chunk = match serde_json::from_slice(&raw) {
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

        let mut blocks: Vec<Value> = Vec::with_capacity(3);
        let mut stop = String::new();
        if let Some(choice) = parsed.choices.first() {
            let reasoning = reasoning_text(
                choice.message.reasoning.as_ref(),
                &choice.message.reasoning_content,
            );
            if !reasoning.is_empty() {
                blocks.push(json!({"type": "thinking", "thinking": reasoning, "signature": ""}));
            }
            if !choice.message.content.is_empty() {
                blocks.push(json!({"type": "text", "text": choice.message.content}));
            }
            for tc in &choice.message.tool_calls {
                // Arguments must be decoded into a real object, not left as a string.
                let input: Value = if tc.function.arguments.is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({}))
                };
                blocks.push(json!({
                    "type": "tool_use", "id": tc.id, "name": tc.function.name, "input": input,
                }));
            }
            stop = stop_reason_for(&choice.finish_reason).to_string();
        }

        let usage = parsed.usage;
        let out = anthropic_message_json(&req.upstream_model_id, &stop, blocks, usage.as_ref());
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
        let raw = build_openai_chat_body(&anth, model, stream);
        serde_json::from_slice(&raw).expect("valid JSON")
    }

    #[test]
    fn body_basics() {
        let got = build(
            json!({
                "model": "should-be-ignored",
                "max_tokens": 512,
                "temperature": 0.3,
                "top_p": 0.9,
                "system": "be brief",
                "messages": [{"role": "user", "content": "hi"}],
            }),
            "deepseek-chat",
            true,
        );
        // Model fidelity: the PROVIDER's model id is what goes upstream.
        assert_eq!(got["model"], "deepseek-chat");
        assert_eq!(got["max_tokens"], 512);
        assert_eq!(got["temperature"], 0.3);
        assert_eq!(got["top_p"], 0.9);
        assert_eq!(got["stream"], true);
        // Usage must be requested explicitly or the turn cannot be billed.
        assert_eq!(got["stream_options"]["include_usage"], true);

        let msgs = got["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2, "system + user");
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "be brief");
    }

    #[test]
    fn reasoning_models_swap_the_token_cap_and_drop_temperature() {
        let anth = json!({
            "max_tokens": 1000,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": "hi"}],
        });
        for model in ["gpt-5.5", "o3-mini", "openai/o4-mini"] {
            let got = build(anth.clone(), model, false);
            assert!(got.get("max_tokens").is_none(), "{model}");
            assert_eq!(got["max_completion_tokens"], 1000, "{model}");
            assert!(
                got.get("temperature").is_none(),
                "{model}: reasoning models reject a custom temperature"
            );
        }
        // A normal model keeps both.
        let got = build(anth, "gpt-4o", false);
        assert_eq!(got["max_tokens"], 1000);
        assert_eq!(got["temperature"], 0.7);
    }

    /// The regexes are segment-anchored so ordinary model names are unaffected.
    #[test]
    fn model_regexes_do_not_over_match() {
        for model in ["gpt-4o", "llama-3", "claude-3-opus", "deepseek-chat"] {
            assert!(
                !needs_max_completion_tokens().is_match(model),
                "{model} must keep max_tokens"
            );
        }
        // The broader reasoning regex also catches these.
        for model in ["gpt-oss-120b", "deepseek-reasoner", "qwen-thinking"] {
            assert!(is_reasoning_model().is_match(model), "{model}");
            assert!(
                !needs_max_completion_tokens().is_match(model),
                "{model} still uses max_tokens"
            );
        }
    }

    #[test]
    fn thinking_maps_to_reasoning_effort() {
        for (budget, want) in [(1024, "low"), (4096, "medium"), (20000, "high")] {
            let got = build(
                json!({
                    "thinking": {"type": "enabled", "budget_tokens": budget},
                    "messages": [{"role": "user", "content": "hi"}],
                }),
                "deepseek-reasoner",
                false,
            );
            assert_eq!(got["reasoning_effort"], want, "budget {budget}");
        }
        // Explicitly disabled thinking must NOT request reasoning.
        let got = build(
            json!({
                "thinking": {"type": "disabled"},
                "messages": [{"role": "user", "content": "hi"}],
            }),
            "deepseek-chat",
            false,
        );
        assert!(got.get("reasoning_effort").is_none());
    }

    #[test]
    fn tools_and_tool_choice() {
        let got = build(
            json!({
                "messages": [{"role": "user", "content": "hi"}],
                "tools": [
                    {"name": "read_file", "description": "Read a file",
                     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}},
                    // An Anthropic SERVER tool: versioned type, no input_schema.
                    {"type": "web_search_20260301", "name": "web_search"},
                ],
                "tool_choice": {"type": "any"},
            }),
            "deepseek-chat",
            false,
        );
        let tools = got["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1, "the server tool must be dropped");
        let fnc = &tools[0]["function"];
        assert_eq!(fnc["name"], "read_file");
        assert_eq!(fnc["description"], "Read a file");
        assert_eq!(fnc["parameters"]["type"], "object");
        assert_eq!(
            got["tool_choice"], "required",
            "Anthropic 'any' -> required"
        );
    }

    #[test]
    fn tool_choice_variants() {
        let cases: [(Value, Value); 5] = [
            (json!({"type": "auto"}), json!("auto")),
            (json!({"type": "any"}), json!("required")),
            (json!({"type": "none"}), json!("none")),
            (
                json!({"type": "tool", "name": "bash"}),
                json!({"type": "function", "function": {"name": "bash"}}),
            ),
            // A named choice with no name degrades to "required".
            (json!({"type": "tool"}), json!("required")),
        ];
        for (input, want) in cases {
            assert_eq!(openai_tool_choice(Some(&input)), Some(want), "{input}");
        }
        assert_eq!(openai_tool_choice(None), None);
        assert_eq!(openai_tool_choice(Some(&json!("auto"))), None);
        assert_eq!(openai_tool_choice(Some(&json!({"type": "weird"}))), None);
    }

    #[test]
    fn already_openai_shaped_tools_pass_through() {
        let tools = openai_tools(Some(&json!([
            {"type": "function", "function": {"name": "x", "parameters": {}}},
        ])));
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "x");
    }

    #[test]
    fn a_custom_tool_without_a_schema_gets_an_empty_object_schema() {
        let tools = openai_tools(Some(&json!([{"name": "noargs", "type": "custom"}])));
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["parameters"]["type"], "object");
        // A nameless tool is skipped.
        assert!(openai_tools(Some(&json!([{"description": "x"}]))).is_empty());
    }

    /// An assistant turn that only made tool calls must send content `""` (never
    /// null): Gemini's OpenAI-compatibility layer 400s on null content for every
    /// later turn.
    #[test]
    fn assistant_tool_calls_use_empty_string_content() {
        let got = build(
            json!({"messages": [
                {"role": "user", "content": "read it"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu_1", "name": "read_file",
                     "input": {"path": "a.txt"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1",
                     "content": [{"type": "text", "text": "file body"}]},
                ]},
            ]}),
            "deepseek-chat",
            false,
        );
        let msgs = got["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);

        let assistant = &msgs[1];
        assert_eq!(
            assistant["content"], "",
            "content must be an empty string, never null"
        );
        let calls = assistant["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0]["id"], "toolu_1",
            "the id must be echoed so the result can be paired"
        );
        assert_eq!(calls[0]["function"]["name"], "read_file");
        assert!(calls[0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .contains("a.txt"));

        // The tool result must come immediately after the assistant turn.
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "toolu_1");
        assert_eq!(msgs[2]["content"], "file body");
    }

    /// `tool` messages must precede any user text in the same turn, or OpenAI rejects
    /// the sequence.
    #[test]
    fn tool_results_are_emitted_before_user_text() {
        let got = build(
            json!({"messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "and now continue"},
                    {"type": "tool_result", "tool_use_id": "t1", "content": "done"},
                ]},
            ]}),
            "deepseek-chat",
            false,
        );
        let msgs = got["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "tool", "the tool result comes first");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "and now continue");
    }

    #[test]
    fn images_become_image_url_parts() {
        let got = build(
            json!({"messages": [{"role": "user", "content": [
                {"type": "text", "text": "what is this?"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}},
                {"type": "image", "source": {"type": "url", "url": "https://example.com/x.png"}},
            ]}]}),
            "gpt-4o",
            false,
        );
        let parts = got["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 3, "text + 2 images");
        assert_eq!(parts[0]["text"], "what is this?");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/jpeg;base64,AAAA");
        assert_eq!(parts[2]["image_url"]["url"], "https://example.com/x.png");
    }

    /// A tool result containing an image cannot stay in the `tool` message (its
    /// content must be a string), so it is re-sent as a following user message.
    #[test]
    fn tool_result_images_become_a_follow_up_user_message() {
        let got = build(
            json!({"messages": [{"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_9", "content": [
                    {"type": "text", "text": "screenshot taken"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "BBBB"}},
                ]},
            ]}]}),
            "gpt-4o",
            false,
        );
        let msgs = got["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2, "tool message + image carrier");
        assert_eq!(msgs[0]["role"], "tool");
        assert_eq!(
            msgs[0]["content"], "screenshot taken",
            "a tool message's content must be a plain string"
        );

        let carrier = &msgs[1];
        assert_eq!(carrier["role"], "user");
        let parts = carrier["content"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(
            parts[0]["text"], "Images returned by the previous tool call(s):",
            "the prefix text is a contract with the model"
        );
        assert_eq!(parts[1]["type"], "image_url");
    }

    #[test]
    fn stop_reason_mapping() {
        assert_eq!(stop_reason_for("length"), "max_tokens");
        assert_eq!(stop_reason_for("tool_calls"), "tool_use");
        assert_eq!(stop_reason_for("function_call"), "tool_use");
        assert_eq!(stop_reason_for("stop"), "end_turn");
        assert_eq!(stop_reason_for("content_filter"), "end_turn");
        // An absent finish_reason stays absent so the emitter's default applies.
        assert_eq!(stop_reason_for(""), "");
    }

    /// Port of Go's `TestReasoningTextShapes`: alternate reasoning shapes
    /// (OpenRouter/Qwen) must all normalize.
    #[test]
    fn reasoning_text_shapes() {
        let cases: Vec<(Option<Value>, &str, &str)> = vec![
            (None, "deepseek style", "deepseek style"),
            (Some(json!("qwen style")), "", "qwen style"),
            (Some(json!({"text": "object style"})), "", "object style"),
            (
                Some(json!({"content": "object content"})),
                "",
                "object content",
            ),
            (
                Some(json!(["a", {"text": "b"}, {"content": "c"}])),
                "",
                "abc",
            ),
            (None, "", ""),
            (Some(json!(7)), "", ""),
        ];
        for (direct, field, want) in cases {
            assert_eq!(
                reasoning_text(direct.as_ref(), field),
                want,
                "direct={direct:?} field={field:?}"
            );
        }
    }

    /// A tool-call-only delta sends `"content": null`, which serde would reject
    /// without the null-tolerant deserializer.
    #[test]
    fn chunk_decoding_tolerates_null_fields() {
        let chunk: Chunk = serde_json::from_str(
            r#"{"choices":[{"delta":{"content":null,"tool_calls":null,
                "reasoning_content":null},"finish_reason":null}]}"#,
        )
        .expect("null fields must decode");
        assert_eq!(chunk.choices[0].delta.content, "");
        assert!(chunk.choices[0].delta.tool_calls.is_empty());
        assert_eq!(chunk.choices[0].finish_reason, "");

        // An entirely absent choices array is also fine.
        let empty: Chunk = serde_json::from_str(r#"{"usage":{"total_tokens":5}}"#).unwrap();
        assert!(empty.choices.is_empty());
        assert_eq!(empty.usage.unwrap().total_tokens, 5);
    }

    #[test]
    fn a_non_streaming_body_has_no_stream_flag() {
        let got = build(json!({"messages": []}), "deepseek-chat", false);
        assert!(got.get("stream").is_none());
        assert!(got.get("stream_options").is_none());
    }

    #[test]
    fn stop_sequences_become_stop() {
        let got = build(
            json!({"messages": [], "stop_sequences": ["END", "STOP"]}),
            "deepseek-chat",
            false,
        );
        assert_eq!(got["stop"], json!(["END", "STOP"]));
        // An empty list is omitted.
        let got = build(
            json!({"messages": [], "stop_sequences": []}),
            "deepseek-chat",
            false,
        );
        assert!(got.get("stop").is_none());
    }

    #[test]
    fn an_unknown_role_falls_back_to_flattened_text() {
        let got = build(
            json!({"messages": [
                {"role": "developer", "content": [{"type": "text", "text": "note"}]},
            ]}),
            "gpt-4o",
            false,
        );
        let msgs = got["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "developer");
        assert_eq!(msgs[0]["content"], "note");
    }

    #[test]
    fn a_string_user_content_becomes_a_plain_message() {
        let got = build(
            json!({"messages": [{"role": "user", "content": "just text"}]}),
            "gpt-4o",
            false,
        );
        assert_eq!(got["messages"][0]["content"], "just text");
    }

    #[test]
    fn a_tool_use_with_no_input_sends_an_empty_object() {
        let got = build(
            json!({"messages": [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "noargs"},
                ]},
            ]}),
            "gpt-4o",
            false,
        );
        let args = got["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        assert_eq!(args, "{}", "null input must not become the string \"null\"");
    }
}
