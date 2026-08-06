//! Per-model capability enforcement for the rayu-hosted path.
//!
//! Port of the Go gateway's `internal/server/capabilities.go`.
//!
//! A hosted model declares whether it accepts image content and whether it supports
//! extended thinking (`hosted_models.supportsImage` / `supportsReasoning`,
//! admin-managed). Enforcing that HERE -- before the upstream call, and before any
//! turn or credit is reserved -- buys three things:
//!
//! 1. The user gets an accurate, actionable message ("this model can't read images
//!    -- pick another model") instead of whatever the upstream happens to say, or
//!    worse, a silently ignored attachment.
//! 2. No credits are spent discovering the limitation.
//! 3. The reason is machine-readable (`error.rayu_code`), so the CLI can warn and
//!    offer to switch models without string-matching provider prose.
//!
//! The request is inspected in its canonical Anthropic Messages shape, which is what
//! every hosted request arrives as regardless of the upstream's wire format.

use serde_json::Value;

/// Whether an Anthropic Messages request carries image content.
///
/// Anthropic puts images in a message's content blocks as `{"type":"image", ...}`; a
/// plain string content can never hold one. Tool results may also nest content
/// blocks, so those are inspected too.
pub fn request_has_image(req: &Value) -> bool {
    let Some(msgs) = req.get("messages").and_then(|m| m.as_array()) else {
        return false;
    };
    msgs.iter().any(|m| content_has_image(m.get("content")))
}

/// Walks a content value (string, block, or block list) looking for an image block,
/// including blocks nested inside a `tool_result`.
fn content_has_image(content: Option<&Value>) -> bool {
    match content {
        Some(Value::Array(items)) => items.iter().any(|i| content_has_image(Some(i))),
        Some(Value::Object(obj)) => {
            if obj.get("type").and_then(|t| t.as_str()) == Some("image") {
                return true;
            }
            // tool_result carries its own nested content blocks, which may include an
            // image (for example a screenshot returned by a tool).
            match obj.get("content") {
                Some(nested) => content_has_image(Some(nested)),
                None => false,
            }
        }
        _ => false,
    }
}

/// Whether an Anthropic Messages request asks for extended thinking.
///
/// Anthropic's shape is `{"thinking":{"type":"enabled",...}}`; an explicit
/// `"disabled"` is NOT a request for thinking, so a client that always sends the
/// field with `type=disabled` is unaffected by the reasoning gate.
pub fn request_wants_thinking(req: &Value) -> bool {
    let Some(thinking) = req.get("thinking").filter(|t| t.is_object()) else {
        // A non-object `thinking` (or none) is not a thinking request.
        return false;
    };
    match thinking.get("type").and_then(|t| t.as_str()) {
        Some("disabled") => false,
        Some("enabled") => true,
        // Unknown/absent type but a thinking object present: treat as a request, so
        // an unsupported model fails loudly rather than silently ignoring it.
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_plain_text_request_has_no_image() {
        assert!(!request_has_image(&json!({
            "messages": [{"role": "user", "content": "hello"}],
        })));
        // No messages at all.
        assert!(!request_has_image(&json!({})));
        // A non-array messages value must not panic.
        assert!(!request_has_image(&json!({"messages": "nope"})));
    }

    #[test]
    fn an_image_block_is_detected() {
        assert!(request_has_image(&json!({
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "what is this?"},
                {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
            ]}],
        })));
    }

    /// A screenshot returned by a tool is the common real case, and it is nested one
    /// level deeper than a normal image block.
    #[test]
    fn an_image_nested_in_a_tool_result_is_detected() {
        assert!(request_has_image(&json!({
            "messages": [{"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": [
                    {"type": "text", "text": "screenshot taken"},
                    {"type": "image", "source": {"type": "base64", "data": "BBBB"}},
                ]},
            ]}],
        })));
        // A tool_result with only text is not an image request.
        assert!(!request_has_image(&json!({
            "messages": [{"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "plain output"},
            ]}],
        })));
    }

    /// An image anywhere in the conversation counts, not just the newest turn: the
    /// whole history is re-sent upstream.
    #[test]
    fn an_image_in_an_earlier_turn_counts() {
        assert!(request_has_image(&json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
                ]},
                {"role": "assistant", "content": "I see a cat."},
                {"role": "user", "content": "and now?"},
            ],
        })));
    }

    #[test]
    fn thinking_requests_are_classified() {
        assert!(request_wants_thinking(&json!({
            "thinking": {"type": "enabled", "budget_tokens": 1024},
        })));
        assert!(
            !request_wants_thinking(&json!({"thinking": {"type": "disabled"}})),
            "a client that always sends type=disabled must not trip the gate"
        );
        assert!(!request_wants_thinking(&json!({})));
        // A present object with an unknown/absent type fails LOUDLY rather than
        // silently ignoring the request.
        assert!(request_wants_thinking(
            &json!({"thinking": {"budget_tokens": 100}})
        ));
        assert!(request_wants_thinking(
            &json!({"thinking": {"type": "auto"}})
        ));
        // A non-object thinking value is not a request.
        assert!(!request_wants_thinking(&json!({"thinking": true})));
        assert!(!request_wants_thinking(&json!({"thinking": "enabled"})));
    }
}
