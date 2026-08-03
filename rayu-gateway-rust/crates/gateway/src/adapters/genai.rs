//! Adapts the canonical Anthropic Messages request to Google's Gemini
//! `generateContent` API and back.
//!
//! Port of the Go gateway's `internal/translate/genai.go`.
//!
//! Shape differences that matter:
//!
//! * the conversation is `contents` with roles `user` | `model` (not
//!   "assistant");
//! * the system prompt is `systemInstruction`;
//! * sampling and limits live under `generationConfig`;
//! * tools are `functionDeclarations`, and a tool RESULT is keyed by function
//!   NAME, not by call id -- so the adapter maps `tool_use_id` -> name from the
//!   conversation it was given;
//! * images are `inlineData` (base64 only -- Gemini has no URL image part);
//! * the model id and streaming mode are part of the URL
//!   (`.../v1beta/models/{model}:streamGenerateContent?alt=sse`).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use super::common::{
    blocks_to_text, null_to_default, num_field, string_of, system_text, thinking_requested,
};
use super::{Adapter, AdapterRequest, CompleteOutcome};
use crate::providercfg::{self, Route};
use crate::sse::{
    anthropic_message_json, new_message_id, AnthropicEmitter, EventSink, OnStreamDone, SseScanner,
    StreamStart,
};
use crate::upstream::{self, Upstream, Usage};

// --- thought-signature relay ------------------------------------------------
//
// Gemini 3 attaches an opaque `thoughtSignature` to each functionCall part that
// MUST be echoed back on later turns, or the next request 400s with "Function call
// is missing a thought_signature". The Anthropic wire format has no field for it,
// so the gateway keeps it two ways:
//
//  1. it is emitted on the tool_use block as `thought_signature`, and read back
//     from the client's replayed block when present (fully stateless);
//  2. as a fallback for clients that strip unknown block fields, a bounded
//     in-memory cache keyed by tool-call id.
//
// The cache is best-effort BY DESIGN: it is capped (no unbounded growth) and
// process-local, so on a multi-instance deployment a follow-up turn may land on
// another instance and miss -- which is exactly why (1) exists as the primary
// mechanism.

const MAX_THOUGHT_SIGNATURES: usize = 4096;

struct ThoughtSigs {
    by_id: HashMap<String, String>,
    order: VecDeque<String>,
}

fn thought_sigs() -> &'static Mutex<ThoughtSigs> {
    static SIGS: std::sync::OnceLock<Mutex<ThoughtSigs>> = std::sync::OnceLock::new();
    SIGS.get_or_init(|| {
        Mutex::new(ThoughtSigs {
            by_id: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

/// Records a signature for a tool-call id, evicting the oldest entry when full.
pub fn remember_thought_signature(id: &str, sig: &str) {
    if id.is_empty() || sig.is_empty() {
        return;
    }
    let mut s = thought_sigs().lock().expect("thought signature cache");
    if !s.by_id.contains_key(id) {
        if s.order.len() >= MAX_THOUGHT_SIGNATURES {
            if let Some(oldest) = s.order.pop_front() {
                s.by_id.remove(&oldest);
            }
        }
        s.order.push_back(id.to_string());
    }
    s.by_id.insert(id.to_string(), sig.to_string());
}

/// The signature remembered for a tool-call id, if this instance saw it.
pub fn thought_signature(id: &str) -> String {
    if id.is_empty() {
        return String::new();
    }
    thought_sigs()
        .lock()
        .expect("thought signature cache")
        .by_id
        .get(id)
        .cloned()
        .unwrap_or_default()
}

// --- request translation ----------------------------------------------------

/// Builds the model- and mode-specific URL.
///
/// An admin-provided `endpointPath` override may contain `{model}` and `{method}`
/// placeholders; otherwise the standard v1beta path is used.
pub fn genai_endpoint(route: &Route, model: &str, stream: bool) -> String {
    let (method, query) = if stream {
        // Without `alt=sse` Gemini streams a JSON array, not SSE.
        ("streamGenerateContent", "?alt=sse")
    } else {
        ("generateContent", "")
    };
    // A stored id may already be fully qualified; do not double the prefix.
    let model = model.strip_prefix("models/").unwrap_or(model);
    let path = if route.endpoint_path.is_empty() {
        "/v1beta/models/{model}:{method}"
    } else {
        &route.endpoint_path
    };
    let path = path.replace("{model}", model).replace("{method}", method);
    format!("{}{query}", route.url(&path))
}

/// Translates an Anthropic Messages request into a Gemini `generateContent` body.
pub fn build_genai_body(anth: &Value) -> Vec<u8> {
    let (contents, _) = genai_contents(anth);
    let mut req = Map::new();
    req.insert("contents".into(), json!(contents));

    let sys = system_text(anth.get("system"));
    if !sys.is_empty() {
        req.insert(
            "systemInstruction".into(),
            json!({"parts": [{"text": sys}]}),
        );
    }

    let mut cfg = Map::new();
    if let Some(mt) = num_field(anth, "max_tokens") {
        cfg.insert("maxOutputTokens".into(), json!(mt as i64));
    }
    if let Some(temp) = num_field(anth, "temperature") {
        cfg.insert("temperature".into(), json!(temp));
    }
    if let Some(tp) = num_field(anth, "top_p") {
        cfg.insert("topP".into(), json!(tp));
    }
    if let Some(stops) = anth
        .get("stop_sequences")
        .and_then(|s| s.as_array())
        .filter(|s| !s.is_empty())
    {
        cfg.insert("stopSequences".into(), Value::Array(stops.clone()));
    }
    // Extended thinking -> thinkingConfig. `includeThoughts` is required for Gemini
    // to return thought SUMMARIES at all, which is what becomes the CLI's thinking
    // block.
    if let Some(think) = anth.get("thinking").filter(|t| t.is_object()) {
        if thinking_requested(anth).is_some() {
            let mut tc = Map::new();
            tc.insert("includeThoughts".into(), json!(true));
            if let Some(budget) = num_field(think, "budget_tokens") {
                tc.insert("thinkingBudget".into(), json!(budget as i64));
            }
            cfg.insert("thinkingConfig".into(), Value::Object(tc));
        } else {
            cfg.insert(
                "thinkingConfig".into(),
                json!({"thinkingBudget": 0, "includeThoughts": false}),
            );
        }
    }
    if !cfg.is_empty() {
        req.insert("generationConfig".into(), Value::Object(cfg));
    }

    let decls = genai_function_declarations(anth.get("tools"));
    if !decls.is_empty() {
        req.insert("tools".into(), json!([{"functionDeclarations": decls}]));
        if let Some(tc) = genai_tool_config(anth.get("tool_choice")) {
            req.insert("toolConfig".into(), tc);
        }
    }
    serde_json::to_vec(&Value::Object(req)).unwrap_or_else(|_| b"{}".to_vec())
}

/// Translates Anthropic messages into Gemini contents.
///
/// Also returns the `tool_use_id` -> function name map, because Gemini keys a
/// `functionResponse` by NAME while Anthropic keys a `tool_result` by ID.
fn genai_contents(anth: &Value) -> (Vec<Value>, HashMap<String, String>) {
    let mut id_to_name: HashMap<String, String> = HashMap::new();
    let Some(msgs) = anth.get("messages").and_then(|m| m.as_array()) else {
        return (Vec::new(), id_to_name);
    };
    let mut out: Vec<Value> = Vec::with_capacity(msgs.len());

    for msg in msgs {
        if !msg.is_object() {
            continue;
        }
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let content = msg.get("content");

        if role == "assistant" {
            let mut parts: Vec<Value> = Vec::with_capacity(2);
            match content {
                Some(Value::String(s)) if !s.is_empty() => parts.push(json!({"text": s})),
                Some(Value::Array(blocks)) => {
                    for block in blocks {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(s) = block
                                    .get("text")
                                    .and_then(|t| t.as_str())
                                    .filter(|s| !s.is_empty())
                                {
                                    parts.push(json!({"text": s}));
                                }
                            }
                            Some("tool_use") => {
                                let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("");
                                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                if !id.is_empty() {
                                    id_to_name.insert(id.to_string(), name.to_string());
                                }
                                let args = match block.get("input") {
                                    Some(v) if !v.is_null() => v.clone(),
                                    _ => json!({}),
                                };
                                let mut part = Map::new();
                                part.insert(
                                    "functionCall".into(),
                                    json!({"name": name, "args": args}),
                                );
                                // Echo the thought signature: prefer one the client
                                // replayed on the block, else the cached one. Without
                                // it Gemini 3 rejects the WHOLE request.
                                let sig = block
                                    .get("thought_signature")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let sig = if sig.is_empty() {
                                    thought_signature(id)
                                } else {
                                    sig
                                };
                                if !sig.is_empty() {
                                    part.insert("thoughtSignature".into(), json!(sig));
                                }
                                parts.push(Value::Object(part));
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            if !parts.is_empty() {
                // Gemini's assistant role is "model".
                out.push(json!({"role": "model", "parts": parts}));
            }
            continue;
        }

        let Some(blocks) = content.and_then(|c| c.as_array()) else {
            let s = string_of(content);
            if !s.is_empty() {
                out.push(json!({"role": "user", "parts": [{"text": s}]}));
            }
            continue;
        };

        let mut fn_responses: Vec<Value> = Vec::new();
        let mut user_parts: Vec<Value> = Vec::new();
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("tool_result") => {
                    let id = block
                        .get("tool_use_id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("");
                    // Best effort when the call was not in this conversation: the id
                    // is a better guess than an empty name.
                    let name = id_to_name
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| id.to_string());
                    fn_responses.push(json!({
                        "functionResponse": {
                            "name": name,
                            "response": {"result": blocks_to_text(block.get("content"))},
                        },
                    }));
                    user_parts.extend(genai_image_parts(block.get("content")));
                }
                Some("text") => {
                    if let Some(s) = block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        user_parts.push(json!({"text": s}));
                    }
                }
                Some("image") => {
                    let one = Value::Array(vec![block.clone()]);
                    user_parts.extend(genai_image_parts(Some(&one)));
                }
                _ => {}
            }
        }
        if !fn_responses.is_empty() {
            out.push(json!({"role": "user", "parts": fn_responses}));
        }
        if !user_parts.is_empty() {
            out.push(json!({"role": "user", "parts": user_parts}));
        }
    }
    (out, id_to_name)
}

/// Converts Anthropic image blocks into `inlineData` parts.
///
/// Gemini has no URL image part, so url-sourced images are DROPPED rather than sent
/// in a shape the API would reject.
fn genai_image_parts(content: Option<&Value>) -> Vec<Value> {
    let Some(blocks) = content.and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) != Some("image") {
            continue;
        }
        let Some(src) = block.get("source").filter(|s| s.is_object()) else {
            continue;
        };
        if src.get("type").and_then(|t| t.as_str()) != Some("base64") {
            continue;
        }
        let Some(data) = src
            .get("data")
            .and_then(|d| d.as_str())
            .filter(|d| !d.is_empty())
        else {
            continue;
        };
        let mime = src
            .get("media_type")
            .and_then(|m| m.as_str())
            .filter(|m| !m.is_empty())
            .unwrap_or("image/png");
        out.push(json!({"inlineData": {"mimeType": mime, "data": data}}));
    }
    out
}

/// The subset of JSON Schema Gemini's `functionDeclarations` accept (an OpenAPI 3.0
/// subset).
///
/// Anything else (`$schema`, `additionalProperties`, `$ref`, `allOf`, `oneOf`, ...)
/// must be stripped: Gemini 400s on unknown field names.
const GEMINI_SCHEMA_KEYS: &[&str] = &[
    "type",
    "format",
    "title",
    "description",
    "nullable",
    "enum",
    "maxItems",
    "minItems",
    "properties",
    "required",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength",
    "pattern",
    "example",
    "anyOf",
    "propertyOrdering",
    "default",
    "items",
    "minimum",
    "maximum",
];

fn is_gemini_schema_key(k: &str) -> bool {
    GEMINI_SCHEMA_KEYS.contains(&k)
}

/// Recursively reduces a JSON Schema to the accepted subset, collapsing
/// `type: [x, "null"]` unions into `type` + `nullable`.
pub fn sanitize_gemini_schema(node: &Value) -> Value {
    match node {
        Value::Array(items) => Value::Array(items.iter().map(sanitize_gemini_schema).collect()),
        Value::Object(obj) => {
            let mut out = Map::new();
            // A union type must be collapsed BEFORE the general copy, because the
            // list form is not something Gemini accepts.
            if let Some(types) = obj.get("type").and_then(|t| t.as_array()) {
                for t in types {
                    match t.as_str() {
                        Some("null") => {
                            out.insert("nullable".into(), json!(true));
                        }
                        Some(s) if !s.is_empty() && !out.contains_key("type") => {
                            out.insert("type".into(), json!(s));
                        }
                        _ => {}
                    }
                }
            }
            for (k, val) in obj {
                if !is_gemini_schema_key(k) {
                    continue;
                }
                match k.as_str() {
                    "type" => {
                        if val.is_array() {
                            continue; // handled above
                        }
                        out.insert(k.clone(), val.clone());
                    }
                    "properties" => {
                        if let Some(props) = val.as_object() {
                            let clean: Map<String, Value> = props
                                .iter()
                                .map(|(name, sub)| (name.clone(), sanitize_gemini_schema(sub)))
                                .collect();
                            out.insert("properties".into(), Value::Object(clean));
                        }
                    }
                    "items" | "anyOf" => {
                        out.insert(k.clone(), sanitize_gemini_schema(val));
                    }
                    _ => {
                        out.insert(k.clone(), val.clone());
                    }
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn genai_function_declarations(raw: Option<&Value>) -> Vec<Value> {
    let Some(list) = raw.and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(list.len());
    for tool in list {
        if !tool.is_object() {
            continue;
        }
        let mut name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let mut desc = tool
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("");
        let mut schema = tool.get("input_schema");
        let mut has_schema = schema.is_some();

        // Already-OpenAI-shaped nested function tool.
        if name.is_empty() {
            if let Some(f) = tool.get("function").filter(|f| f.is_object()) {
                name = f.get("name").and_then(|n| n.as_str()).unwrap_or("");
                desc = f.get("description").and_then(|d| d.as_str()).unwrap_or("");
                schema = f.get("parameters");
                has_schema = schema.is_some_and(|p| !p.is_null());
            }
        }
        if name.is_empty() {
            continue;
        }
        // Anthropic server tools carry a versioned type and no schema.
        let ty = tool.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if !ty.is_empty() && ty != "custom" && !has_schema {
            continue;
        }
        let schema = match schema {
            Some(s) if !s.is_null() => s.clone(),
            _ => json!({"type": "object", "properties": {}}),
        };
        out.push(json!({
            "name": name,
            "description": desc,
            "parameters": sanitize_gemini_schema(&schema),
        }));
    }
    out
}

fn genai_tool_config(raw: Option<&Value>) -> Option<Value> {
    let tc = raw?;
    if !tc.is_object() {
        return None;
    }
    let mut cfg = Map::new();
    match tc.get("type").and_then(|t| t.as_str()) {
        Some("auto") => {
            cfg.insert("mode".into(), json!("AUTO"));
        }
        Some("any") => {
            cfg.insert("mode".into(), json!("ANY"));
        }
        Some("none") => {
            cfg.insert("mode".into(), json!("NONE"));
        }
        Some("tool") => {
            cfg.insert("mode".into(), json!("ANY"));
            if let Some(name) = tc
                .get("name")
                .and_then(|n| n.as_str())
                .filter(|n| !n.is_empty())
            {
                cfg.insert("allowedFunctionNames".into(), json!([name]));
            }
        }
        _ => return None,
    }
    Some(json!({"functionCallingConfig": Value::Object(cfg)}))
}

// --- response translation ---------------------------------------------------

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct FunctionCall {
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default)]
    args: Option<Value>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct GenAiPart {
    #[serde(default, deserialize_with = "null_to_default")]
    text: String,
    #[serde(default, deserialize_with = "null_to_default")]
    thought: bool,
    /// Must be echoed back on later turns (Gemini 3).
    #[serde(
        default,
        rename = "thoughtSignature",
        deserialize_with = "null_to_default"
    )]
    thought_signature: String,
    #[serde(default, rename = "functionCall")]
    function_call: Option<FunctionCall>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct GenAiContent {
    #[serde(default, deserialize_with = "null_to_default")]
    parts: Vec<GenAiPart>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct Candidate {
    #[serde(default, deserialize_with = "null_to_default")]
    content: GenAiContent,
    #[serde(default, rename = "finishReason", deserialize_with = "null_to_default")]
    finish_reason: String,
}

/// Gemini's token accounting.
///
/// `promptTokenCount` ALREADY INCLUDES `cachedContentTokenCount`, and
/// `thoughtsTokenCount` is billed as output but reported separately from
/// `candidatesTokenCount`.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
struct GenAiUsage {
    #[serde(
        default,
        rename = "promptTokenCount",
        deserialize_with = "null_to_default"
    )]
    prompt_token_count: i64,
    #[serde(
        default,
        rename = "candidatesTokenCount",
        deserialize_with = "null_to_default"
    )]
    candidates_token_count: i64,
    #[serde(
        default,
        rename = "cachedContentTokenCount",
        deserialize_with = "null_to_default"
    )]
    cached_content_token_count: i64,
    #[serde(
        default,
        rename = "thoughtsTokenCount",
        deserialize_with = "null_to_default"
    )]
    thoughts_token_count: i64,
    #[serde(
        default,
        rename = "totalTokenCount",
        deserialize_with = "null_to_default"
    )]
    total_token_count: i64,
}

impl GenAiUsage {
    fn to_usage(self) -> Usage {
        let cached = self.cached_content_token_count.min(self.prompt_token_count);
        // Thinking tokens are output tokens the provider charges for, so they must
        // be part of completion (and reported separately for observability).
        let completion = self.candidates_token_count + self.thoughts_token_count;
        let total = if self.total_token_count == 0 {
            self.prompt_token_count + completion
        } else {
            self.total_token_count
        };
        Usage {
            prompt_tokens: self.prompt_token_count,
            completion_tokens: completion,
            total_tokens: total,
            // The prompt already includes the cached prefix: SUBTRACT, never add,
            // or the cached tokens get billed twice.
            prompt_cache_hit_tokens: cached,
            prompt_cache_miss_tokens: self.prompt_token_count - cached,
            prompt_tokens_details: Default::default(),
            completion_tokens_details: upstream::CompletionTokensDetails {
                reasoning_tokens: self.thoughts_token_count,
            },
        }
    }
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct GenAiChunk {
    #[serde(default, deserialize_with = "null_to_default")]
    candidates: Vec<Candidate>,
    #[serde(default, rename = "usageMetadata")]
    usage_metadata: Option<GenAiUsage>,
}

/// Maps a Gemini `finishReason` onto an Anthropic `stop_reason`.
fn genai_stop_reason(finish: &str, saw_tool_call: bool) -> &'static str {
    if saw_tool_call {
        return "tool_use";
    }
    match finish.to_ascii_uppercase().as_str() {
        "MAX_TOKENS" => "max_tokens",
        "" | "STOP" => "end_turn",
        // SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, ... -- the turn was cut
        // short by a provider policy, which for the client is a stop, not a crash.
        _ => "end_turn",
    }
}

/// Builds the synthetic tool-call id Gemini responses need.
///
/// Gemini does not supply call ids, but Anthropic's `tool_result` pairing (and the
/// thought-signature cache) both need one, so it is derived from the message id.
fn tool_call_id(msg_id: &str, seq: usize) -> String {
    let suffix = msg_id.strip_prefix("msg_rayu_").unwrap_or(msg_id);
    format!("toolu_rayu_{suffix}_{seq}")
}

/// The `genai` adapter.
pub struct GenAi;

#[async_trait::async_trait]
impl Adapter for GenAi {
    fn format(&self) -> &'static str {
        providercfg::FORMAT_GENAI
    }

    async fn stream(
        &self,
        up: &Upstream,
        req: AdapterRequest,
        on_done: OnStreamDone,
    ) -> StreamStart {
        let body = build_genai_body(&req.anthropic);
        let url = genai_endpoint(&req.route, &req.upstream_model_id, true);
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
            let msg_id = em.message_id().to_string();
            let mut usage: Option<Usage> = None;
            let mut finish = String::new();
            let mut saw_tool_call = false;
            let mut tool_seq = 0usize;
            let mut scan_err: Option<String> = None;

            'outer: while let Some(item) = scanner.next_data().await {
                let payload = match item {
                    Ok(p) => p,
                    Err(e) => {
                        scan_err = Some(e.to_string());
                        break;
                    }
                };
                let Ok(chunk) = serde_json::from_slice::<GenAiChunk>(&payload) else {
                    continue;
                };
                if let Some(u) = chunk.usage_metadata {
                    usage = Some(u.to_usage());
                }

                for cand in &chunk.candidates {
                    for part in &cand.content.parts {
                        // A thought part ALSO carries `text`, so check it FIRST or
                        // the chain-of-thought leaks into the visible answer.
                        if part.thought && !part.text.is_empty() {
                            if em.thinking(&part.text).await.is_err() {
                                break 'outer;
                            }
                            continue;
                        }
                        if let Some(fc) = part.function_call.as_ref() {
                            saw_tool_call = true;
                            tool_seq += 1;
                            let id = tool_call_id(&msg_id, tool_seq);
                            remember_thought_signature(&id, &part.thought_signature);
                            if em.tool_start(&id, &fc.name).await.is_err() {
                                break 'outer;
                            }
                            // Gemini delivers COMPLETE args (not fragments), so emit
                            // exactly one delta.
                            let args = match fc.args.as_ref() {
                                Some(a) if !a.is_null() => a.clone(),
                                _ => json!({}),
                            };
                            let encoded =
                                serde_json::to_string(&args).unwrap_or_else(|_| "{}".into());
                            if em.tool_args(&encoded).await.is_err() {
                                break 'outer;
                            }
                            // Relay the signature to the client so it can be replayed
                            // even if this gateway instance forgets it.
                            if !part.thought_signature.is_empty()
                                && em.tool_signature(&part.thought_signature).await.is_err()
                            {
                                break 'outer;
                            }
                            continue;
                        }
                        if !part.text.is_empty() && em.text(&part.text).await.is_err() {
                            break 'outer;
                        }
                    }
                    if !cand.finish_reason.is_empty() {
                        finish = cand.finish_reason.clone();
                    }
                }
            }

            let stop = genai_stop_reason(&finish, saw_tool_call);
            if let Some(e) = scan_err {
                let _ = em
                    .error("The model provider ended the response unexpectedly.")
                    .await;
                let _ = em.finish(stop, usage.as_ref()).await;
                on_done(usage, Some(e));
                return;
            }
            let _ = em.finish(stop, usage.as_ref()).await;
            on_done(usage, None);
        });

        StreamStart::Streaming(response)
    }

    async fn complete(&self, up: &Upstream, req: AdapterRequest) -> CompleteOutcome {
        let body = build_genai_body(&req.anthropic);
        let url = genai_endpoint(&req.route, &req.upstream_model_id, false);
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

        let parsed: GenAiChunk = match serde_json::from_slice(&raw) {
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
        let usage = parsed.usage_metadata.map(|u| u.to_usage());

        let mut blocks: Vec<Value> = Vec::with_capacity(3);
        let mut finish = String::new();
        let mut saw_tool_call = false;
        let mut seq = 0usize;

        for cand in &parsed.candidates {
            if !cand.finish_reason.is_empty() {
                finish = cand.finish_reason.clone();
            }
            for part in &cand.content.parts {
                if part.thought && !part.text.is_empty() {
                    blocks
                        .push(json!({"type": "thinking", "thinking": part.text, "signature": ""}));
                    continue;
                }
                if let Some(fc) = part.function_call.as_ref() {
                    saw_tool_call = true;
                    seq += 1;
                    let id = tool_call_id(&new_message_id(), seq);
                    remember_thought_signature(&id, &part.thought_signature);
                    let args = match fc.args.as_ref() {
                        Some(a) if !a.is_null() => a.clone(),
                        _ => json!({}),
                    };
                    let mut block = Map::new();
                    block.insert("type".into(), json!("tool_use"));
                    block.insert("id".into(), json!(id));
                    block.insert("name".into(), json!(fc.name));
                    block.insert("input".into(), args);
                    if !part.thought_signature.is_empty() {
                        block.insert("thought_signature".into(), json!(part.thought_signature));
                    }
                    blocks.push(Value::Object(block));
                    continue;
                }
                if !part.text.is_empty() {
                    blocks.push(json!({"type": "text", "text": part.text}));
                }
            }
        }

        let out = anthropic_message_json(
            &req.upstream_model_id,
            genai_stop_reason(&finish, saw_tool_call),
            blocks,
            usage.as_ref(),
        );
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

    fn build(anth: Value) -> Value {
        serde_json::from_slice(&build_genai_body(&anth)).expect("valid JSON")
    }

    fn route(base: &str, endpoint_path: &str) -> Route {
        Route {
            name: "gemini".into(),
            format: providercfg::FORMAT_GENAI.into(),
            base_url: base.into(),
            endpoint_path: endpoint_path.into(),
            auth_scheme: providercfg::AUTH_X_GOOG_API_KEY.into(),
            key_count: 1,
            enabled: true,
        }
    }

    /// The model id and streaming mode live in the URL for this API.
    #[test]
    fn endpoint_url() {
        let r = route("https://generativelanguage.googleapis.com", "");
        assert_eq!(
            genai_endpoint(&r, "gemini-3-pro", true),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            genai_endpoint(&r, "gemini-3-pro", false),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent"
        );
        // A "models/" prefix on the stored model id must not be doubled.
        assert!(
            !genai_endpoint(&r, "models/gemini-3-pro", false).contains("models/models/"),
            "model prefix doubled"
        );
        // An admin override may template the model and method.
        let r = route(
            "https://generativelanguage.googleapis.com",
            "/v1/custom/{model}:{method}",
        );
        assert_eq!(
            genai_endpoint(&r, "gemini-x", true),
            "https://generativelanguage.googleapis.com/v1/custom/gemini-x:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn body_roles_and_system_instruction() {
        let got = build(json!({
            "system": "be brief",
            "max_tokens": 128,
            "temperature": 0.2,
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ],
        }));
        assert_eq!(got["systemInstruction"]["parts"][0]["text"], "be brief");
        assert_eq!(got["generationConfig"]["maxOutputTokens"], 128);
        assert_eq!(got["generationConfig"]["temperature"], 0.2);

        let contents = got["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(
            contents[1]["role"], "model",
            "Gemini's assistant role is 'model', not 'assistant'"
        );
    }

    /// Gemini keys a tool RESULT by function NAME, so the adapter must resolve
    /// `tool_use_id` -> name from the conversation.
    #[test]
    fn tool_result_is_keyed_by_function_name() {
        let got = build(json!({"messages": [
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_42", "name": "read_file",
                 "input": {"path": "a.txt"}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_42",
                 "content": [{"type": "text", "text": "body"}]},
            ]},
        ]}));
        let contents = got["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[0]["parts"][0]["functionCall"]["name"], "read_file");

        let fr = &contents[1]["parts"][0]["functionResponse"];
        assert_eq!(fr["name"], "read_file", "must be the NAME, not the tool id");
        assert_eq!(fr["response"]["result"], "body");
    }

    /// An unknown id falls back to the id itself rather than sending an empty name.
    #[test]
    fn an_unmatched_tool_result_falls_back_to_the_id() {
        let got = build(json!({"messages": [
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_orphan", "content": "x"},
            ]},
        ]}));
        assert_eq!(
            got["contents"][0]["parts"][0]["functionResponse"]["name"],
            "toolu_orphan"
        );
    }

    /// Gemini 3 rejects a follow-up turn whose functionCall lost its
    /// thoughtSignature, so a signature replayed by the client must be echoed back.
    #[test]
    fn echoes_thought_signature_from_the_client_block() {
        let got = build(json!({"messages": [
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_sig", "name": "read_file",
                 "input": {}, "thought_signature": "SIG-FROM-CLIENT"},
            ]},
        ]}));
        assert_eq!(
            got["contents"][0]["parts"][0]["thoughtSignature"],
            "SIG-FROM-CLIENT"
        );
    }

    /// When the client stripped the field, the gateway's bounded cache supplies it.
    #[test]
    fn echoes_thought_signature_from_the_cache() {
        remember_thought_signature("toolu_cached_rs", "SIG-FROM-CACHE");
        let got = build(json!({"messages": [
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_cached_rs", "name": "x", "input": {}},
            ]},
        ]}));
        assert_eq!(
            got["contents"][0]["parts"][0]["thoughtSignature"],
            "SIG-FROM-CACHE"
        );
        // A client-supplied value WINS over the cache.
        let got = build(json!({"messages": [
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_cached_rs", "name": "x", "input": {},
                 "thought_signature": "SIG-NEWER"},
            ]},
        ]}));
        assert_eq!(
            got["contents"][0]["parts"][0]["thoughtSignature"],
            "SIG-NEWER"
        );
    }

    #[test]
    fn the_thought_signature_cache_is_bounded() {
        for i in 0..MAX_THOUGHT_SIGNATURES + 50 {
            remember_thought_signature(&format!("bounded-{i}"), "sig");
        }
        let size = thought_sigs().lock().unwrap().by_id.len();
        assert!(
            size <= MAX_THOUGHT_SIGNATURES,
            "cache grew to {size}, must stay <= {MAX_THOUGHT_SIGNATURES}"
        );
        // Empty inputs are ignored rather than poisoning the cache.
        remember_thought_signature("", "sig");
        remember_thought_signature("id", "");
        assert_eq!(thought_signature(""), "");
        assert_eq!(thought_signature("id"), "");
    }

    #[test]
    fn images_become_inline_data() {
        let got = build(json!({"messages": [
            {"role": "user", "content": [
                {"type": "text", "text": "see"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/webp", "data": "ZZZZ"}},
                // Gemini has no URL image part: this must be DROPPED, not sent in a
                // shape the API would reject.
                {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}},
            ]},
        ]}));
        let parts = got["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2, "text + one inlineData: {parts:?}");
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/webp");
        assert_eq!(parts[1]["inlineData"]["data"], "ZZZZ");
    }

    #[test]
    fn tools_and_thinking_config() {
        let got = build(json!({
            "messages": [{"role": "user", "content": "hi"}],
            "thinking": {"type": "enabled", "budget_tokens": 4096},
            "tools": [
                {"name": "read_file", "description": "Read", "input_schema": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    // Not in Gemini's accepted subset -- must be stripped or Gemini 400s.
                    "additionalProperties": false,
                    "$schema": "http://json-schema.org/draft-07/schema#",
                }},
                {"type": "web_search_20260301", "name": "web_search"},
            ],
            "tool_choice": {"type": "tool", "name": "read_file"},
        }));

        let decls = got["tools"][0]["functionDeclarations"].as_array().unwrap();
        assert_eq!(decls.len(), 1, "the server tool must be dropped");
        let params = &decls[0]["parameters"];
        assert!(
            params.get("additionalProperties").is_none(),
            "additionalProperties must be stripped"
        );
        assert!(params.get("$schema").is_none(), "$schema must be stripped");
        assert!(
            !params["properties"].is_null(),
            "properties must survive sanitization"
        );

        let tc = &got["toolConfig"]["functionCallingConfig"];
        assert_eq!(tc["mode"], "ANY");
        assert_eq!(tc["allowedFunctionNames"][0], "read_file");

        let think = &got["generationConfig"]["thinkingConfig"];
        // includeThoughts is required for Gemini to return thought summaries at all.
        assert_eq!(think["includeThoughts"], true);
        assert_eq!(think["thinkingBudget"], 4096);
    }

    /// Disabled thinking must send an explicit zero budget, not omit the config --
    /// Gemini 3 thinks by default.
    #[test]
    fn disabled_thinking_sends_a_zero_budget() {
        let got = build(json!({
            "messages": [{"role": "user", "content": "hi"}],
            "thinking": {"type": "disabled"},
        }));
        let think = &got["generationConfig"]["thinkingConfig"];
        assert_eq!(think["thinkingBudget"], 0);
        assert_eq!(think["includeThoughts"], false);
    }

    #[test]
    fn tool_config_modes() {
        for (input, mode) in [
            (json!({"type": "auto"}), "AUTO"),
            (json!({"type": "any"}), "ANY"),
            (json!({"type": "none"}), "NONE"),
            (json!({"type": "tool", "name": "x"}), "ANY"),
        ] {
            let got = genai_tool_config(Some(&input)).expect("a config");
            assert_eq!(got["functionCallingConfig"]["mode"], mode, "{input}");
        }
        // A named choice with no name still restricts the mode but names nothing.
        let got = genai_tool_config(Some(&json!({"type": "tool"}))).unwrap();
        assert!(got["functionCallingConfig"]
            .get("allowedFunctionNames")
            .is_none());
        assert_eq!(genai_tool_config(None), None);
        assert_eq!(genai_tool_config(Some(&json!({"type": "??"}))), None);
    }

    #[test]
    fn sanitize_collapses_nullable_unions() {
        let out = sanitize_gemini_schema(&json!({
            "type": ["string", "null"],
            "description": "x",
            "$ref": "#/defs/y",
        }));
        assert_eq!(out["type"], "string");
        assert_eq!(out["nullable"], true);
        assert!(out.get("$ref").is_none(), "$ref must be stripped");
        assert_eq!(out["description"], "x");
    }

    /// Sanitization must reach nested properties and array items, or a rejected key
    /// two levels down still 400s the request.
    #[test]
    fn sanitize_recurses_into_properties_and_items() {
        let out = sanitize_gemini_schema(&json!({
            "type": "object",
            "properties": {
                "list": {
                    "type": "array",
                    "items": {"type": "object", "additionalProperties": true,
                              "properties": {"deep": {"type": "string", "$comment": "no"}}},
                },
            },
            "required": ["list"],
        }));
        let items = &out["properties"]["list"]["items"];
        assert!(items.get("additionalProperties").is_none());
        assert!(items["properties"]["deep"].get("$comment").is_none());
        assert_eq!(items["properties"]["deep"]["type"], "string");
        assert_eq!(out["required"], json!(["list"]));
    }

    /// `promptTokenCount` ALREADY INCLUDES `cachedContentTokenCount` (a
    /// double-billing hazard), and `thoughtsTokenCount` is output the provider
    /// charges for.
    #[test]
    fn usage_mapping() {
        let u: GenAiUsage = serde_json::from_str(
            r#"{"promptTokenCount":1000,"candidatesTokenCount":40,
                "cachedContentTokenCount":900,"thoughtsTokenCount":60,"totalTokenCount":1100}"#,
        )
        .unwrap();
        let got = u.to_usage();
        assert_eq!(got.fresh_input_tokens(), 100, "1000 prompt - 900 cached");
        assert_eq!(got.cache_read_tokens(), 900);
        assert_eq!(
            got.completion_tokens, 100,
            "40 candidates + 60 thoughts, both billed as output"
        );
        assert_eq!(got.completion_tokens_details.reasoning_tokens, 60);
        assert_eq!(got.total_tokens, 1100);
    }

    #[test]
    fn usage_edge_cases() {
        // A missing total is derived, including the thoughts.
        let u: GenAiUsage = serde_json::from_str(
            r#"{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3}"#,
        )
        .unwrap();
        assert_eq!(u.to_usage().total_tokens, 15);
        // A cached count larger than the prompt is clamped, never negative.
        let u: GenAiUsage =
            serde_json::from_str(r#"{"promptTokenCount":5,"cachedContentTokenCount":99}"#).unwrap();
        assert_eq!(u.to_usage().fresh_input_tokens(), 0);
        assert_eq!(u.to_usage().cache_read_tokens(), 5);
    }

    #[test]
    fn stop_reason_mapping() {
        let cases = [
            ("STOP", false, "end_turn"),
            ("MAX_TOKENS", false, "max_tokens"),
            ("", false, "end_turn"),
            ("SAFETY", false, "end_turn"),
            ("RECITATION", false, "end_turn"),
            // A tool call wins over every finish reason.
            ("STOP", true, "tool_use"),
            ("MAX_TOKENS", true, "tool_use"),
        ];
        for (finish, tool, want) in cases {
            assert_eq!(
                genai_stop_reason(finish, tool),
                want,
                "finish={finish:?} tool={tool}"
            );
        }
        // Case-insensitive, like Go's strings.ToUpper.
        assert_eq!(genai_stop_reason("max_tokens", false), "max_tokens");
    }

    #[test]
    fn tool_call_ids_are_derived_from_the_message_id() {
        assert_eq!(tool_call_id("msg_rayu_abc123", 2), "toolu_rayu_abc123_2");
        // A non-conforming id is used whole rather than panicking on the prefix.
        assert_eq!(tool_call_id("weird", 1), "toolu_rayu_weird_1");
    }

    #[test]
    fn a_chunk_with_null_fields_decodes() {
        let chunk: GenAiChunk = serde_json::from_str(
            r#"{"candidates":[{"content":{"parts":null},"finishReason":null}],
                "usageMetadata":null}"#,
        )
        .expect("null fields must decode");
        assert!(chunk.candidates[0].content.parts.is_empty());
        assert!(chunk.usage_metadata.is_none());
    }

    #[test]
    fn an_empty_request_still_produces_valid_contents() {
        let got = build(json!({}));
        assert_eq!(got["contents"], json!([]));
        assert!(got.get("generationConfig").is_none());
        assert!(got.get("tools").is_none());
    }
}
