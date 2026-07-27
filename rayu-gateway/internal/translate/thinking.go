package translate

// Stale `thinking` blocks are the reason a conversation can break the moment a
// user switches models with /model.
//
// THE FAILURE
//
// Every Anthropic-shaped `thinking` block carries a `signature`: an encrypted
// copy of the reasoning that the API verifies when the block is sent back. The
// signature is tied to the model that produced it. Replaying one to a DIFFERENT
// model family is a hard 400 that kills the whole request:
//
//	messages.5.content.0: Invalid `signature` in `thinking` block
//
// A hosted user hits this by doing nothing unusual — ask Claude, /model to
// DeepSeek, ask again, /model back to Claude:
//
//	[0] user       hi
//	[1] assistant  (claude)   thinking + text
//	[2] user       hi
//	[3] assistant  (deepseek) thinking + text   ← signature is DeepSeek's
//	[4] user       hi                            ← next request goes to Claude
//
// The CLI replays history verbatim (which is what a correct Anthropic client
// does), so message 3's foreign block reaches Bedrock and the turn dies.
//
// Signatures from non-Anthropic providers are not merely unverifiable, they are
// not even the same KIND of value: DeepSeek's /anthropic surface returns a plain
// UUID ("4fd2c917-979d-4e69-8a37-3ce63dbd1f9b"), and this gateway's own
// translation adapters synthesise `signature: ""` when they map an OpenAI-style
// `reasoning_content` field into a thinking block. Neither can ever validate.
//
// WHY STRIPPING IS THE CORRECT FIX, NOT A WORKAROUND
//
// It is what Anthropic prescribes. From the thinking documentation:
//
//   - "Switching models mid-conversation. When you switch between any two
//     models, strip `thinking` and `redacted_thinking` blocks from prior
//     assistant turns. Thinking blocks are tied to the model that produced them."
//   - "Required: within a tool-use turn, pass thinking blocks back. Recommended:
//     across turns, pass everything back. Allowed: outside tool use, omit prior
//     turns' thinking."
//
// So prior-turn thinking is optional, and the CURRENT turn's thinking is
// mandatory. That is exactly the line this file draws.
//
// WHY THE SIGNATURE ITSELF IS NEVER INSPECTED
//
// A tempting shortcut is to drop only blocks whose signature "looks wrong"
// (empty, or UUID-shaped). That is guesswork on a field the API documents as
// opaque — "don't interpret or parse it" — and it would still pass through a
// genuine-looking signature minted by any other vendor. The turn boundary is
// structural, so it needs no such guess.
//
// WHY THIS BELONGS IN THE GATEWAY AND NOT THE CLI
//
// Three reasons:
//
//   - The gateway is where the model actually changes. To the client, every
//     hosted model is one endpoint; only the gateway knows the request just moved
//     from a DeepSeek row to a Bedrock row.
//   - It fixes every client immediately, including CLI versions already installed
//     on users' machines.
//   - The gateway is what minted the unusable blocks in the first place (the
//     synthesised empty signatures above), so it owns the cleanup.

// stripPriorTurnThinking returns anth with `thinking` and `redacted_thinking`
// blocks removed from assistant messages that belong to a COMPLETED turn, and
// the number of blocks removed.
//
// The current turn is left byte-identical, because the API requires it: "within
// the latest assistant message, the sequence of consecutive thinking blocks must
// match what the model generated — you can't rearrange, edit, or partially drop
// them." A turn cannot span a model switch (the tool-use loop runs to completion
// before the user can type /model), so blocks in the current turn are always the
// current model's own and always valid.
//
// The turn boundary is the last user message that is NOT a tool-result
// continuation. A tool-use loop looks like this to the API, and all of it is ONE
// assistant turn:
//
//	user      "list the files"      ← boundary: the current turn starts here
//	assistant thinking + tool_use   ← kept: required by the API
//	user      tool_result           ← not a new turn, just a continuation
//	assistant thinking + text       ← kept
//
// Copy-on-write: only the containers that actually change are copied, so an
// unaffected request allocates nothing and the caller's map is never mutated —
// the server still logs and settles billing against the original.
func stripPriorTurnThinking(anth map[string]any) (map[string]any, int) {
	msgs, ok := anth["messages"].([]any)
	if !ok || len(msgs) == 0 {
		return anth, 0
	}

	boundary := currentTurnStart(msgs)
	if boundary < 0 {
		// No plain user message at all (a history of nothing but tool results, or
		// an assistant-only history). Nothing can be classified as a completed
		// turn, so change nothing.
		return anth, 0
	}

	var (
		outMsgs []any // nil until the first change
		removed int
	)
	// A message may be dropped entirely, so the output is built by appending
	// rather than by index.
	commit := func(upto int) {
		if outMsgs == nil {
			outMsgs = make([]any, 0, len(msgs))
			outMsgs = append(outMsgs, msgs[:upto]...)
		}
	}
	for i, raw := range msgs {
		msg, isMap := raw.(map[string]any)
		if i >= boundary || !isMap || msg["role"] != "assistant" {
			if outMsgs != nil {
				outMsgs = append(outMsgs, raw)
			}
			continue
		}
		blocks, isList := msg["content"].([]any)
		if !isList {
			// A plain string content can't hold a thinking block.
			if outMsgs != nil {
				outMsgs = append(outMsgs, raw)
			}
			continue
		}
		kept := make([]any, 0, len(blocks))
		for _, b := range blocks {
			if isThinkingBlock(b) {
				removed++
				continue
			}
			kept = append(kept, b)
		}
		if len(kept) == len(blocks) {
			if outMsgs != nil {
				outMsgs = append(outMsgs, raw)
			}
			continue
		}
		commit(i)
		if len(kept) == 0 {
			// The turn produced nothing but reasoning (e.g. it hit max_tokens
			// mid-thought). With the blocks gone the message carries no content at
			// all, so it is dropped rather than sent as an empty assistant turn.
			continue
		}
		next := make(map[string]any, len(msg))
		for k, v := range msg {
			next[k] = v
		}
		next["content"] = kept
		outMsgs = append(outMsgs, next)
	}
	if outMsgs == nil {
		return anth, 0
	}

	out := make(map[string]any, len(anth))
	for k, v := range anth {
		out[k] = v
	}
	out["messages"] = outMsgs
	return out, removed
}

// currentTurnStart returns the index of the last user message that starts a new
// turn, i.e. the last one that is not purely a tool-result continuation, or -1
// when there is none.
func currentTurnStart(msgs []any) int {
	for i := len(msgs) - 1; i >= 0; i-- {
		msg, ok := msgs[i].(map[string]any)
		if !ok || msg["role"] != "user" {
			continue
		}
		if !carriesToolResult(msg["content"]) {
			return i
		}
	}
	return -1
}

// carriesToolResult reports whether a user message is a tool-result continuation
// of the assistant's turn rather than a fresh instruction. One tool_result block
// is enough: a client may batch several results, or pair them with text.
func carriesToolResult(content any) bool {
	blocks, ok := content.([]any)
	if !ok {
		return false
	}
	for _, b := range blocks {
		if block, ok := b.(map[string]any); ok && block["type"] == "tool_result" {
			return true
		}
	}
	return false
}

// isThinkingBlock matches both block types the docs say to strip together;
// dropping only `thinking` and leaving `redacted_thinking` behind would keep the
// exact 400 this code exists to prevent.
func isThinkingBlock(b any) bool {
	block, ok := b.(map[string]any)
	if !ok {
		return false
	}
	switch block["type"] {
	case "thinking", "redacted_thinking":
		return true
	}
	return false
}
