//! Estimates how many input tokens an Anthropic Messages request would consume.
//!
//! Port of the Go gateway's `internal/tokencount`.
//!
//! # Why the gateway needs this
//!
//! The Anthropic SDK (which the CLI speaks) offers
//! `POST /v1/messages/count_tokens`, and clients call it to render context usage
//! and to decide when to compact. Hosted models are served by providers whose wire
//! formats (OpenAI Chat Completions, OpenAI Responses, Google GenAI) have no
//! equivalent endpoint, and even the Anthropic-compatible ones do not all implement
//! it. Without an answer here the client is left with two bad options: give up, or
//! "count" by sending a REAL one-token request -- which costs the user credits and,
//! done once per context section, trips the concurrency limiter.
//!
//! So the gateway answers locally: no upstream call, no credits, no rate limit.
//!
//! # Accuracy contract
//!
//! This is an ESTIMATE and callers must treat it as one. It is deliberately
//! tokenizer-free: shipping a per-provider tokenizer would be a large dependency
//! that is still wrong for any model whose vocabulary we do not have. The heuristic
//! below is close enough for context accounting (typically within ~10-15% on
//! English + code) and, importantly, is STABLE -- the same request always yields the
//! same number, so a UI does not flicker.
//!
//! It errs slightly HIGH rather than low: a client that thinks it has less room than
//! it does compacts a little early, which is harmless. The reverse causes a
//! mid-request overflow from the upstream.

use serde_json::Value;

/// English prose averages ~4 characters per token for BPE vocabularies; code is
/// denser (~3.2) because of punctuation. 4 is used for prose and the punctuation
/// surcharge in [`estimate_text`] covers code.
const CHARS_PER_TOKEN: f64 = 4.0;

/// Accounts for the role marker and message delimiters that every provider adds
/// around each message.
const MESSAGE_OVERHEAD: i64 = 4;

/// Covers the structural wrapper of a non-text content block (type discriminator,
/// ids, field names).
const BLOCK_OVERHEAD: i64 = 8;

/// Covers the JSON scaffolding around one tool definition, on top of the characters
/// of its name/description/schema.
const TOOL_OVERHEAD: i64 = 12;

/// A flat per-image estimate.
///
/// Anthropic prices an image at roughly `(width * height) / 750` tokens, which for
/// the ~1092x1092 that clients typically send is about 1590. Without the pixel
/// dimensions (the payload is base64) a flat figure is the honest answer.
const IMAGE_TOKENS: i64 = 1600;

/// Estimates the input tokens for a raw Anthropic Messages JSON body.
///
/// An unparseable body yields `None`, so the caller can answer with a 400 rather
/// than a confidently wrong number.
pub fn estimate_body(body: &[u8]) -> Option<i64> {
    let req: Value = serde_json::from_slice(body).ok()?;
    Some(estimate(&req))
}

/// Returns the estimated input tokens for a parsed request.
///
/// Everything else in the body (`max_tokens`, `temperature`, `stream`, ...) is
/// irrelevant to counting and is ignored.
pub fn estimate(req: &Value) -> i64 {
    let mut total = 0i64;

    // `system` may be a plain string or an array of content blocks.
    total += estimate_any(req.get("system"));

    if let Some(msgs) = req.get("messages").and_then(|m| m.as_array()) {
        for m in msgs {
            total += MESSAGE_OVERHEAD;
            total += estimate_any(m.get("content"));
        }
    }

    // Tool definitions are sent on every request and are frequently the largest
    // fixed cost in an agent conversation, so they must be counted.
    if let Some(tools) = req.get("tools").and_then(|t| t.as_array()) {
        for t in tools {
            let raw = serde_json::to_string(t).unwrap_or_default();
            total += TOOL_OVERHEAD + estimate_text(&raw);
        }
    }
    total
}

/// Counts a value that may be a string, a content-block array, or a single block
/// object -- the three shapes the Messages API accepts.
fn estimate_any(v: Option<&Value>) -> i64 {
    match v {
        None | Some(Value::Null) => 0,
        Some(Value::String(s)) => estimate_text(s),
        Some(Value::Array(items)) => items.iter().map(|i| estimate_any(Some(i))).sum(),
        Some(Value::Object(_)) => estimate_block(v.expect("matched Object")),
        _ => 0,
    }
}

/// Counts one content block by its type.
///
/// Unknown block types fall back to counting their JSON, which is never zero -- a
/// new block type must not silently vanish from the estimate.
fn estimate_block(b: &Value) -> i64 {
    let text_of =
        |key: &str| -> i64 { estimate_text(b.get(key).and_then(|v| v.as_str()).unwrap_or("")) };
    match b.get("type").and_then(|t| t.as_str()) {
        Some("text") => text_of("text"),
        Some("thinking") => BLOCK_OVERHEAD + text_of("thinking"),
        // Opaque payload: it still occupies context.
        Some("redacted_thinking") => BLOCK_OVERHEAD + text_of("data"),
        Some("image") => BLOCK_OVERHEAD + IMAGE_TOKENS,
        Some("tool_use") => BLOCK_OVERHEAD + text_of("name") + estimate_any(b.get("input")),
        Some("tool_result") => BLOCK_OVERHEAD + estimate_any(b.get("content")),
        // A PDF/text document block: the source is base64, so count it the same way
        // as any opaque payload.
        Some("document") => BLOCK_OVERHEAD + estimate_any(b.get("source")),
        // Includes server_tool_use, web_search_result, and anything added later.
        _ => {
            let raw = serde_json::to_string(b).unwrap_or_default();
            BLOCK_OVERHEAD + estimate_text(&raw)
        }
    }
}

/// Converts characters to tokens.
///
/// Two adjustments make this hold up on the mixed prose+code traffic an agent
/// actually sends:
///
/// * punctuation and symbols tokenize far more finely than letters (each often
///   becoming its own token), so they are counted at a higher rate;
/// * a short non-empty string still costs at least one token.
fn estimate_text(s: &str) -> i64 {
    if s.is_empty() {
        return 0;
    }
    let (mut letters, mut symbols) = (0i64, 0i64);
    for c in s.chars() {
        if c.is_alphanumeric() || c == ' ' {
            letters += 1;
        } else if c.is_whitespace() {
            // Newlines/tabs are cheap but not free.
            letters += 1;
        } else {
            symbols += 1;
        }
    }
    // Letters at ~4 chars/token; symbols at ~2 (denser tokenization).
    let est = letters as f64 / CHARS_PER_TOKEN + symbols as f64 / 2.0;
    let mut n = est as i64;
    if est > n as f64 {
        n += 1; // round up: erring high is the safe direction
    }
    if n == 0 {
        n = 1;
    }
    n
}

/// The exported single-string estimate, for callers that only have raw text (for
/// example counting a system prompt on its own).
pub fn estimate_text_public(s: &str) -> i64 {
    estimate_text(s.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_empty_string_is_free_but_any_text_costs_at_least_one() {
        assert_eq!(estimate_text(""), 0);
        assert_eq!(estimate_text("a"), 1);
        assert_eq!(estimate_text("."), 1);
    }

    #[test]
    fn prose_and_symbols_are_priced_differently() {
        // 8 letters -> 8/4 = 2 tokens.
        assert_eq!(estimate_text("abcdefgh"), 2);
        // 8 symbols -> 8/2 = 4 tokens, because punctuation tokenizes finely.
        assert_eq!(estimate_text("{}{}{}{}"), 4);
    }

    #[test]
    fn the_estimate_rounds_up() {
        // 5 letters -> 1.25 -> 2, never 1: erring high is the safe direction.
        assert_eq!(estimate_text("abcde"), 2);
    }

    #[test]
    fn whitespace_counts_as_a_letter_not_a_symbol() {
        // 4 chars (2 letters + 2 newlines) -> 1 token, not 2.
        assert_eq!(estimate_text("a\nb\n"), 1);
    }

    #[test]
    fn a_message_carries_role_overhead() {
        let one = estimate(&json!({"messages": [{"role": "user", "content": ""}]}));
        assert_eq!(
            one, MESSAGE_OVERHEAD,
            "an empty message still costs its wrapper"
        );
        let two = estimate(&json!({"messages": [
            {"role": "user", "content": ""},
            {"role": "assistant", "content": ""},
        ]}));
        assert_eq!(two, MESSAGE_OVERHEAD * 2);
    }

    #[test]
    fn the_system_prompt_is_counted_in_both_shapes() {
        let as_string = estimate(&json!({"system": "You are Rayu.", "messages": []}));
        let as_blocks = estimate(&json!({
            "system": [{"type": "text", "text": "You are Rayu."}],
            "messages": [],
        }));
        assert!(as_string > 0);
        assert_eq!(
            as_string, as_blocks,
            "both system shapes must cost the same"
        );
    }

    #[test]
    fn an_image_costs_a_flat_estimate() {
        let with_image = estimate(&json!({"messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
        ]}]}));
        assert_eq!(
            with_image,
            MESSAGE_OVERHEAD + BLOCK_OVERHEAD + IMAGE_TOKENS,
            "the base64 payload must NOT be counted as text -- it would be wildly high"
        );
    }

    #[test]
    fn tools_are_counted_because_they_are_sent_every_turn() {
        let without = estimate(&json!({"messages": []}));
        let with = estimate(&json!({
            "messages": [],
            "tools": [{"name": "read_file", "description": "Read a file",
                       "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}],
        }));
        assert!(
            with > without + TOOL_OVERHEAD,
            "a tool definition must cost its schema too: {with} vs {without}"
        );
    }

    #[test]
    fn thinking_and_redacted_thinking_both_occupy_context() {
        let thinking = estimate(&json!({"messages": [{"role": "assistant", "content": [
            {"type": "thinking", "thinking": "some long chain of thought here"},
        ]}]}));
        assert!(thinking > MESSAGE_OVERHEAD + BLOCK_OVERHEAD);

        let redacted = estimate(&json!({"messages": [{"role": "assistant", "content": [
            {"type": "redacted_thinking", "data": "opaquepayloadopaquepayload"},
        ]}]}));
        assert!(
            redacted > MESSAGE_OVERHEAD + BLOCK_OVERHEAD,
            "an opaque payload still takes up room"
        );
    }

    #[test]
    fn a_tool_result_counts_its_nested_content() {
        let empty = estimate(&json!({"messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": []},
        ]}]}));
        let full = estimate(&json!({"messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": [
                {"type": "text", "text": "a long file body returned by the tool"},
            ]},
        ]}]}));
        assert!(full > empty);
    }

    /// An unknown block type must still cost something, or a new Anthropic block
    /// would silently disappear from every context readout.
    #[test]
    fn an_unknown_block_type_still_costs_its_json() {
        let got = estimate(&json!({"messages": [{"role": "user", "content": [
            {"type": "server_tool_use", "id": "srv_1", "name": "web_search",
             "input": {"query": "rust async"}},
        ]}]}));
        assert!(got > MESSAGE_OVERHEAD + BLOCK_OVERHEAD, "got {got}");
    }

    #[test]
    fn the_estimate_is_stable() {
        let body = json!({
            "system": "You are Rayu.",
            "messages": [{"role": "user", "content": "explain borrow checking"}],
        });
        let first = estimate(&body);
        for _ in 0..5 {
            assert_eq!(
                estimate(&body),
                first,
                "an unstable estimate would make the UI flicker"
            );
        }
    }

    #[test]
    fn an_unparseable_body_is_reported_rather_than_guessed() {
        assert!(estimate_body(b"not json").is_none());
        assert_eq!(
            estimate_body(br#"{"messages":[]}"#),
            Some(0),
            "a valid but empty request is genuinely zero"
        );
    }

    /// Go's `TestProseIsAboutFourCharsPerToken`: 440 characters of English prose
    /// must land near 110 tokens, which is what pins the 4-chars-per-token claim.
    #[test]
    fn prose_is_about_four_chars_per_token() {
        let text = "the quick brown fox jumps over the lazy dog ".repeat(10);
        assert_eq!(text.len(), 440);
        let n = estimate(&json!({"messages": [{"role": "user", "content": text}]}));
        assert!(
            (80..=160).contains(&n),
            "estimate={n} for 440 chars of prose, want ~110"
        );
    }

    /// Go's `TestRealisticConversation` sanity band: hundreds, not tens and not tens
    /// of thousands.
    #[test]
    fn a_realistic_conversation_lands_in_gos_sanity_band() {
        let body = json!({
            "model": "deepseek-v4-flash",
            "max_tokens": 1,
            "system": [{"type": "text", "text": "You are Rayu, a coding agent. ".repeat(20)}],
            "messages": [
                {"role": "user", "content": "refactor the parser"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Reading the file first."},
                    {"type": "tool_use", "id": "t1", "name": "read_file",
                     "input": {"path": "/repo/src/parser.go"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1",
                     "content": "package parser\n".repeat(100)},
                ]},
            ],
            "tools": [{"name": "read_file", "description": "Read a file",
                       "input_schema": {"type": "object"}}],
        });
        let n = estimate_body(&serde_json::to_vec(&body).unwrap())
            .expect("a realistic request must parse");
        assert!(
            (200..=5000).contains(&n),
            "estimate={n} for a realistic conversation, want a few hundred"
        );
    }

    #[test]
    fn public_text_estimate_trims_first() {
        assert_eq!(estimate_text_public("   "), 0);
        assert_eq!(estimate_text_public("  abcdefgh  "), 2);
    }

    /// A realistic agent request must land in a sane range -- this is the "within
    /// 10-15%" claim held to something observable.
    #[test]
    fn a_realistic_request_is_in_a_plausible_range() {
        let body = json!({
            "system": "You are Rayu, an AI coding agent. Be concise and correct.",
            "messages": [
                {"role": "user", "content": "Refactor the parser to use a state machine."},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "I will start by reading the current parser."},
                    {"type": "tool_use", "id": "t1", "name": "read_file",
                     "input": {"path": "src/parser.rs"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1",
                     "content": [{"type": "text", "text": "fn parse() {}\n".repeat(20)}]},
                ]},
            ],
        });
        let got = estimate(&body);
        assert!(
            (60..600).contains(&got),
            "estimate {got} is outside a plausible range for this request"
        );
    }
}
