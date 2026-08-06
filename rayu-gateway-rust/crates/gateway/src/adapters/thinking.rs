//! Dropping stale `thinking` blocks from completed turns.
//!
//! Port of the Go gateway's `internal/translate/thinking.go`.
//!
//! # The failure this prevents
//!
//! Every Anthropic-shaped `thinking` block carries a `signature`: an encrypted copy
//! of the reasoning that the API verifies when the block is sent back. The
//! signature is tied to the model that produced it. Replaying one to a DIFFERENT
//! model family is a hard 400 that kills the whole request:
//!
//! ```text
//! messages.5.content.0: Invalid `signature` in `thinking` block
//! ```
//!
//! A hosted user hits this by doing nothing unusual -- ask Claude, `/model` to
//! DeepSeek, ask again, `/model` back to Claude. The CLI replays history verbatim
//! (which is what a correct Anthropic client does), so the foreign block reaches
//! Bedrock and the turn dies.
//!
//! Signatures from non-Anthropic providers are not merely unverifiable, they are
//! not even the same KIND of value: DeepSeek's `/anthropic` surface returns a plain
//! UUID, and this gateway's own translation adapters synthesise `signature: ""`
//! when they map an OpenAI-style `reasoning_content` field into a thinking block.
//! Neither can ever validate.
//!
//! # Why stripping is the correct fix, not a workaround
//!
//! It is what Anthropic prescribes. From the thinking documentation:
//!
//! * "Switching models mid-conversation. When you switch between any two models,
//!   strip `thinking` and `redacted_thinking` blocks from prior assistant turns.
//!   Thinking blocks are tied to the model that produced them."
//! * "Required: within a tool-use turn, pass thinking blocks back. Recommended:
//!   across turns, pass everything back. Allowed: outside tool use, omit prior
//!   turns' thinking."
//!
//! So prior-turn thinking is optional, and the CURRENT turn's thinking is
//! mandatory. That is exactly the line this module draws.
//!
//! # Why the signature is never inspected
//!
//! A tempting shortcut is to drop only blocks whose signature "looks wrong" (empty,
//! or UUID-shaped). That is guesswork on a field the API documents as opaque --
//! "don't interpret or parse it" -- and it would still pass through a
//! genuine-looking signature minted by any other vendor. The turn boundary is
//! structural, so it needs no such guess.
//!
//! # Why this belongs in the gateway and not the CLI
//!
//! * The gateway is where the model actually changes. To the client, every hosted
//!   model is one endpoint; only the gateway knows the request just moved from a
//!   DeepSeek row to a Bedrock row.
//! * It fixes every client immediately, including CLI versions already installed.
//! * The gateway is what minted the unusable blocks in the first place (the
//!   synthesised empty signatures above), so it owns the cleanup.

use serde_json::Value;

/// Returns `anth` with `thinking` and `redacted_thinking` blocks removed from
/// assistant messages that belong to a COMPLETED turn, plus the number removed.
///
/// The current turn is left byte-identical, because the API requires it: "within
/// the latest assistant message, the sequence of consecutive thinking blocks must
/// match what the model generated -- you can't rearrange, edit, or partially drop
/// them." A turn cannot span a model switch (the tool-use loop runs to completion
/// before the user can type `/model`), so blocks in the current turn are always the
/// current model's own and always valid.
///
/// The turn boundary is the last user message that is NOT a tool-result
/// continuation. A tool-use loop looks like this to the API, and all of it is ONE
/// assistant turn:
///
/// ```text
/// user      "list the files"      <- boundary: the current turn starts here
/// assistant thinking + tool_use   <- kept: required by the API
/// user      tool_result           <- not a new turn, just a continuation
/// assistant thinking + text       <- kept
/// ```
///
/// Copy-on-write: an unaffected request is returned untouched and the caller's
/// value is never mutated -- the server still logs and settles billing against the
/// original.
pub fn strip_prior_turn_thinking(anth: &Value) -> (Value, usize) {
    let Some(msgs) = anth.get("messages").and_then(|m| m.as_array()) else {
        return (anth.clone(), 0);
    };
    if msgs.is_empty() {
        return (anth.clone(), 0);
    }

    let Some(boundary) = current_turn_start(msgs) else {
        // No plain user message at all (a history of nothing but tool results, or
        // an assistant-only history). Nothing can be classified as a completed
        // turn, so change nothing.
        return (anth.clone(), 0);
    };

    let mut removed = 0usize;
    let mut out_msgs: Vec<Value> = Vec::with_capacity(msgs.len());
    let mut changed = false;

    for (i, raw) in msgs.iter().enumerate() {
        // Messages at or after the boundary are the CURRENT turn: untouchable.
        let is_prior_assistant =
            i < boundary && raw.get("role").and_then(|r| r.as_str()) == Some("assistant");
        if !is_prior_assistant {
            out_msgs.push(raw.clone());
            continue;
        }
        let Some(blocks) = raw.get("content").and_then(|c| c.as_array()) else {
            // A plain string content can't hold a thinking block.
            out_msgs.push(raw.clone());
            continue;
        };

        let kept: Vec<Value> = blocks
            .iter()
            .filter(|b| {
                if is_thinking_block(b) {
                    removed += 1;
                    false
                } else {
                    true
                }
            })
            .cloned()
            .collect();

        if kept.len() == blocks.len() {
            out_msgs.push(raw.clone());
            continue;
        }
        changed = true;
        if kept.is_empty() {
            // The turn produced nothing but reasoning (e.g. it hit max_tokens
            // mid-thought). With the blocks gone the message carries no content at
            // all, so it is dropped rather than sent as an empty assistant turn.
            continue;
        }
        let mut next = raw.clone();
        next["content"] = Value::Array(kept);
        out_msgs.push(next);
    }

    if !changed {
        return (anth.clone(), 0);
    }
    let mut out = anth.clone();
    out["messages"] = Value::Array(out_msgs);
    (out, removed)
}

/// The index of the last user message that starts a new turn -- the last one that
/// is not purely a tool-result continuation -- or `None` when there is none.
fn current_turn_start(msgs: &[Value]) -> Option<usize> {
    for (i, msg) in msgs.iter().enumerate().rev() {
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        if !carries_tool_result(msg.get("content")) {
            return Some(i);
        }
    }
    None
}

/// Whether a user message is a tool-result continuation of the assistant's turn
/// rather than a fresh instruction.
///
/// One `tool_result` block is enough: a client may batch several results, or pair
/// them with text.
fn carries_tool_result(content: Option<&Value>) -> bool {
    content.and_then(|c| c.as_array()).is_some_and(|blocks| {
        blocks
            .iter()
            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
    })
}

/// Matches both block types the docs say to strip together.
///
/// Dropping only `thinking` and leaving `redacted_thinking` behind would keep the
/// exact 400 this module exists to prevent.
fn is_thinking_block(b: &Value) -> bool {
    matches!(
        b.get("type").and_then(|t| t.as_str()),
        Some("thinking") | Some("redacted_thinking")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thinking_block(text: &str, sig: &str) -> Value {
        json!({"type": "thinking", "thinking": text, "signature": sig})
    }
    fn text_block(text: &str) -> Value {
        json!({"type": "text", "text": text})
    }
    fn user_msg(content: Value) -> Value {
        json!({"role": "user", "content": content})
    }
    fn assistant_msg(blocks: Vec<Value>) -> Value {
        json!({"role": "assistant", "content": blocks})
    }
    fn tool_use(id: &str) -> Value {
        json!({"type": "tool_use", "id": id, "name": "ls", "input": {}})
    }
    fn tool_result(id: &str) -> Value {
        json!([{"type": "tool_result", "tool_use_id": id, "content": "ok"}])
    }

    /// Counts thinking-family blocks anywhere in a request, so assertions describe
    /// what the UPSTREAM sees rather than internal structure.
    fn count_thinking(v: &Value) -> usize {
        match v {
            Value::Object(map) => {
                let mut total = usize::from(matches!(
                    map.get("type").and_then(|t| t.as_str()),
                    Some("thinking") | Some("redacted_thinking")
                ));
                for val in map.values() {
                    total += count_thinking(val);
                }
                total
            }
            Value::Array(items) => items.iter().map(count_thinking).sum(),
            _ => 0,
        }
    }

    /// Reproduces the exact bug report: ask Claude, `/model` to DeepSeek, ask again,
    /// `/model` back to Claude. DeepSeek's thinking block (a UUID signature,
    /// captured from the live API) must not reach Bedrock.
    #[test]
    fn switching_models_drops_foreign_thinking_blocks() {
        let req = json!({
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                user_msg(json!("hi")),
                assistant_msg(vec![thinking_block("Greeting.", "ErUBCkYIBxgCIkDs"), text_block("Hi!")]),
                user_msg(json!("hi")),
                // DeepSeek's /anthropic surface returns a plain UUID as the signature.
                assistant_msg(vec![
                    thinking_block("Greeting again.", "4fd2c917-979d-4e69-8a37-3ce63dbd1f9b"),
                    text_block("Hi!"),
                ]),
                user_msg(json!("hi")),
            ],
        });

        let (out, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 2, "both completed turns must be stripped");
        assert_eq!(
            count_thinking(&out),
            0,
            "no thinking may reach the upstream"
        );

        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 5, "no message should be dropped");
        // The visible answers must survive: only the reasoning is dropped.
        for i in [1, 3] {
            let blocks = msgs[i]["content"].as_array().unwrap();
            assert_eq!(blocks.len(), 1, "message {i}");
            assert_eq!(blocks[0]["type"], "text", "message {i}");
        }
    }

    /// Covers the gateway's own output: the OpenAI/Gemini adapters map
    /// `reasoning_content` into a thinking block with `signature: ""`, which no
    /// Anthropic endpoint can validate either.
    #[test]
    fn synthesised_empty_signature_is_also_dropped() {
        let req = json!({"messages": [
            user_msg(json!("hi")),
            assistant_msg(vec![
                thinking_block("Reasoning from an OpenAI-shaped provider.", ""),
                text_block("Hi!"),
            ]),
            user_msg(json!("and now?")),
        ]});
        let (out, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 1);
        assert_eq!(count_thinking(&out), 0);
    }

    /// The docs say to strip both types together. Dropping only `thinking` would
    /// leave the same 400 in place.
    #[test]
    fn redacted_thinking_is_stripped_too() {
        let req = json!({"messages": [
            user_msg(json!("hi")),
            assistant_msg(vec![
                json!({"type": "redacted_thinking", "data": "EroBCkYIBxgCIkD"}),
                text_block("Hi!"),
            ]),
            user_msg(json!("again")),
        ]});
        let (out, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 1);
        assert_eq!(count_thinking(&out), 0);
    }

    /// Pins the API's hard requirement: inside a tool-use turn the thinking blocks
    /// MUST be passed back unmodified. A `tool_result` user message continues the
    /// turn, it does not start a new one.
    #[test]
    fn tool_use_turn_keeps_its_thinking_blocks() {
        let req = json!({"messages": [
            // A completed earlier turn -- strippable.
            user_msg(json!("hi")),
            assistant_msg(vec![thinking_block("old", "sig-old"), text_block("Hi!")]),
            // The current turn starts here and is still running.
            user_msg(json!("list the files")),
            assistant_msg(vec![thinking_block("I should list them.", "sig-current"), tool_use("toolu_1")]),
            user_msg(tool_result("toolu_1")),
        ]});

        let (out, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 1, "only the completed turn may be stripped");
        let current = out["messages"][3]["content"].as_array().unwrap();
        assert_eq!(current.len(), 2, "the in-flight turn must be untouched");
        assert_eq!(current[0]["signature"], "sig-current");
    }

    /// Several tool rounds are still ONE assistant turn, so every thinking block
    /// after the user's instruction stays.
    #[test]
    fn multi_round_tool_loop_keeps_the_whole_turn() {
        let req = json!({"messages": [
            user_msg(json!("do the thing")),
            assistant_msg(vec![thinking_block("step 1", "s1"), tool_use("t1")]),
            user_msg(tool_result("t1")),
            assistant_msg(vec![thinking_block("step 2", "s2"), tool_use("t2")]),
            user_msg(tool_result("t2")),
        ]});
        let (out, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 0, "nothing in the current turn may be dropped");
        assert_eq!(count_thinking(&out), 2, "both blocks must survive");
        assert_eq!(out, req, "an unaffected request comes back unchanged");
    }

    /// The server logs and settles billing against the original request, so the
    /// sanitiser must be copy-on-write.
    #[test]
    fn caller_value_is_never_mutated() {
        let req = json!({"messages": [
            user_msg(json!("hi")),
            assistant_msg(vec![thinking_block("keep me", "sig"), text_block("Hi!")]),
            user_msg(json!("hi")),
        ]});
        let before = count_thinking(&req);

        let (_, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 1);
        assert_eq!(
            count_thinking(&req),
            before,
            "the caller's request was mutated"
        );
        assert_eq!(
            req["messages"][1]["content"].as_array().unwrap().len(),
            2,
            "the caller's content array was mutated in place"
        );
    }

    /// A turn cut off mid-thought leaves nothing to send once the block is gone, so
    /// the message goes rather than being sent empty.
    #[test]
    fn thinking_only_message_is_dropped() {
        let req = json!({"messages": [
            user_msg(json!("hi")),
            assistant_msg(vec![thinking_block("cut off by max_tokens", "sig")]),
            user_msg(json!("continue")),
        ]});
        let (out, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 1);
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2, "the empty assistant message must be dropped");
        for m in msgs {
            assert_eq!(m["role"], "user", "unexpected surviving message {m}");
        }
    }

    /// The common case: no thinking anywhere means the exact same value comes back.
    #[test]
    fn nothing_to_strip_is_a_passthrough() {
        let req = json!({"messages": [
            user_msg(json!("hi")),
            assistant_msg(vec![text_block("Hi!")]),
            user_msg(json!("hi")),
        ]});
        let (out, removed) = strip_prior_turn_thinking(&req);
        assert_eq!(removed, 0);
        assert_eq!(out, req);
    }

    /// String content, a missing messages array and a history with no plain user
    /// message must not panic or corrupt the request.
    #[test]
    fn malformed_history_is_left_alone() {
        let cases = [
            json!({"model": "x"}),
            json!({"messages": "not an array"}),
            json!({"messages": []}),
            json!({"messages": [
                user_msg(json!("hi")),
                {"role": "assistant", "content": "plain string"},
                user_msg(json!("hi")),
            ]}),
            // Tool results only: no turn boundary can be established.
            json!({"messages": [
                user_msg(tool_result("t1")),
                assistant_msg(vec![thinking_block("keep", "sig"), text_block("hi")]),
            ]}),
        ];
        for (i, req) in cases.iter().enumerate() {
            let (out, removed) = strip_prior_turn_thinking(req);
            assert_eq!(removed, 0, "case {i}");
            assert_eq!(&out, req, "case {i}: the request was altered");
        }
    }
}
