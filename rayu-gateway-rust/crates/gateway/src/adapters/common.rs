//! Small helpers shared by the translating adapters.
//!
//! Port of the helper functions at the bottom of the Go gateway's
//! `internal/translate/openai_chat.go`, which the Responses and GenAI adapters also
//! use.

use serde_json::Value;

/// Deserializes a field that a provider may send as `null`, yielding the type's
/// default instead of failing.
///
/// Go's `json.Unmarshal` leaves a `string` field untouched (so `""`) when the JSON
/// value is `null`; serde would error. Every provider sends `"content": null` on a
/// tool-call-only delta, so this is load-bearing rather than defensive.
pub fn null_to_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

use serde::Deserialize as _;

/// Flattens Anthropic's `system` (a string or a block list) into text.
pub fn system_text(system: Option<&Value>) -> String {
    match system {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => {
            let mut out = String::new();
            for item in items {
                match item {
                    Value::String(s) => out.push_str(s),
                    Value::Object(_) => {
                        if let Some(s) = item.get("text").and_then(|t| t.as_str()) {
                            if !out.is_empty() {
                                out.push('\n');
                            }
                            out.push_str(s);
                        }
                    }
                    _ => {}
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Joins the text of a content value (a string or a block list).
///
/// Only `text` blocks contribute; images and tool results are handled separately by
/// each adapter.
pub fn blocks_to_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => {
            let mut out = String::new();
            for item in items {
                if item.get("type").and_then(|t| t.as_str()) != Some("text") {
                    continue;
                }
                if let Some(s) = item.get("text").and_then(|t| t.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(s);
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Renders a value as text the way Go's `fmt.Sprint` would for the shapes that
/// reach it: a string passes through, anything else is its JSON form.
pub fn string_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Reads a JSON number field (all JSON numbers decode as floats).
pub fn num_field(m: &Value, key: &str) -> Option<f64> {
    m.get(key).and_then(|v| v.as_f64())
}

/// Maps an Anthropic thinking budget onto OpenAI's coarse effort levels.
pub fn reasoning_effort_for(thinking: &Value) -> &'static str {
    match num_field(thinking, "budget_tokens") {
        None => "medium",
        Some(b) if b <= 2048.0 => "low",
        Some(b) if b <= 8192.0 => "medium",
        Some(_) => "high",
    }
}

/// Whether an Anthropic `thinking` object asks for reasoning.
///
/// An explicit `type: "disabled"` is not a request; anything else on a present
/// object is.
pub fn thinking_requested(anth: &Value) -> Option<&Value> {
    let t = anth.get("thinking")?;
    if !t.is_object() {
        return None;
    }
    if t.get("type").and_then(|v| v.as_str()) == Some("disabled") {
        return None;
    }
    Some(t)
}

/// Converts Anthropic image blocks into OpenAI `image_url` parts.
///
/// A base64 source becomes a data URL (defaulting to `image/png` when the media
/// type is missing, as Go does); a URL source is passed through. Anything else is
/// skipped rather than sent in a shape the API would reject.
pub fn image_parts_from(content: Option<&Value>) -> Vec<Value> {
    let Some(blocks) = content.and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for raw in blocks {
        if raw.get("type").and_then(|t| t.as_str()) != Some("image") {
            continue;
        }
        let Some(src) = raw.get("source") else {
            continue;
        };
        match src.get("type").and_then(|t| t.as_str()) {
            Some("base64") => {
                let data = src.get("data").and_then(|d| d.as_str()).unwrap_or("");
                if data.is_empty() {
                    continue;
                }
                let mt = src
                    .get("media_type")
                    .and_then(|m| m.as_str())
                    .filter(|m| !m.is_empty())
                    .unwrap_or("image/png");
                out.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {"url": format!("data:{mt};base64,{data}")},
                }));
            }
            Some("url") => {
                if let Some(u) = src
                    .get("url")
                    .and_then(|u| u.as_str())
                    .filter(|u| !u.is_empty())
                {
                    out.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": {"url": u},
                    }));
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_text_flattens_both_shapes() {
        assert_eq!(system_text(Some(&json!("be brief"))), "be brief");
        assert_eq!(
            system_text(Some(&json!([
                {"type": "text", "text": "line one"},
                {"type": "text", "text": "line two"},
            ]))),
            "line one\nline two",
            "blocks are newline-joined"
        );
        // Bare strings in the array concatenate WITHOUT a separator, like Go.
        assert_eq!(system_text(Some(&json!(["a", "b"]))), "ab");
        assert_eq!(system_text(None), "");
        assert_eq!(system_text(Some(&json!(42))), "");
    }

    #[test]
    fn blocks_to_text_ignores_non_text_blocks() {
        assert_eq!(blocks_to_text(Some(&json!("plain"))), "plain");
        assert_eq!(
            blocks_to_text(Some(&json!([
                {"type": "text", "text": "a"},
                {"type": "image", "source": {}},
                {"type": "text", "text": "b"},
            ]))),
            "a\nb"
        );
        assert_eq!(blocks_to_text(None), "");
        assert_eq!(blocks_to_text(Some(&json!(7))), "");
    }

    #[test]
    fn reasoning_effort_thresholds() {
        assert_eq!(reasoning_effort_for(&json!({"budget_tokens": 1024})), "low");
        assert_eq!(reasoning_effort_for(&json!({"budget_tokens": 2048})), "low");
        assert_eq!(
            reasoning_effort_for(&json!({"budget_tokens": 2049})),
            "medium"
        );
        assert_eq!(
            reasoning_effort_for(&json!({"budget_tokens": 8192})),
            "medium"
        );
        assert_eq!(
            reasoning_effort_for(&json!({"budget_tokens": 8193})),
            "high"
        );
        assert_eq!(
            reasoning_effort_for(&json!({"budget_tokens": 20000})),
            "high"
        );
        // No budget at all defaults to medium.
        assert_eq!(reasoning_effort_for(&json!({"type": "enabled"})), "medium");
    }

    #[test]
    fn thinking_requested_honours_disabled() {
        assert!(thinking_requested(&json!({"thinking": {"type": "enabled"}})).is_some());
        // An unknown type on a present object still counts as a request.
        assert!(thinking_requested(&json!({"thinking": {"budget_tokens": 100}})).is_some());
        assert!(thinking_requested(&json!({"thinking": {"type": "disabled"}})).is_none());
        assert!(thinking_requested(&json!({})).is_none());
        // A non-object thinking value is not a request.
        assert!(thinking_requested(&json!({"thinking": true})).is_none());
    }

    #[test]
    fn image_parts_cover_both_source_types() {
        let parts = image_parts_from(Some(&json!([
            {"type": "text", "text": "what is this?"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}},
            {"type": "image", "source": {"type": "url", "url": "https://example.com/x.png"}},
        ])));
        assert_eq!(parts.len(), 2, "only image blocks become parts");
        assert_eq!(parts[0]["image_url"]["url"], "data:image/jpeg;base64,AAAA");
        assert_eq!(parts[1]["image_url"]["url"], "https://example.com/x.png");
    }

    #[test]
    fn image_parts_default_the_media_type_and_skip_junk() {
        let parts = image_parts_from(Some(&json!([
            {"type": "image", "source": {"type": "base64", "data": "BBBB"}},
            // No data: skipped rather than sent as an empty data URL.
            {"type": "image", "source": {"type": "base64", "data": ""}},
            // No source at all.
            {"type": "image"},
            // An unknown source type.
            {"type": "image", "source": {"type": "file", "path": "/x"}},
            // An empty URL.
            {"type": "image", "source": {"type": "url", "url": ""}},
        ])));
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["image_url"]["url"], "data:image/png;base64,BBBB");
        assert!(image_parts_from(None).is_empty());
        assert!(image_parts_from(Some(&json!("string"))).is_empty());
    }

    #[test]
    fn string_of_shapes() {
        assert_eq!(string_of(Some(&json!("hi"))), "hi");
        assert_eq!(string_of(None), "");
        assert_eq!(string_of(Some(&json!(null))), "");
        assert_eq!(string_of(Some(&json!(7))), "7");
    }
}
