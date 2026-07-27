package translate

import (
	"encoding/json"
	"reflect"
	"testing"
)

// thinkingBlock is the shape every Anthropic-compatible provider returns, with
// the signature value that provider happens to mint.
func thinkingBlock(text, sig string) map[string]any {
	return map[string]any{"type": "thinking", "thinking": text, "signature": sig}
}

func textBlock(text string) map[string]any {
	return map[string]any{"type": "text", "text": text}
}

func userMsg(content any) map[string]any {
	return map[string]any{"role": "user", "content": content}
}

func assistantMsg(blocks ...any) map[string]any {
	return map[string]any{"role": "assistant", "content": append([]any{}, blocks...)}
}

// countThinking walks a marshalled request and counts thinking-family blocks, so
// the assertions describe what the UPSTREAM sees rather than internal structure.
func countThinking(t *testing.T, v any) int {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	var walk func(any) int
	walk = func(node any) int {
		switch n := node.(type) {
		case map[string]any:
			total := 0
			if n["type"] == "thinking" || n["type"] == "redacted_thinking" {
				total++
			}
			for _, v := range n {
				total += walk(v)
			}
			return total
		case []any:
			total := 0
			for _, v := range n {
				total += walk(v)
			}
			return total
		}
		return 0
	}
	return walk(decoded)
}

// TestSwitchingModelsDropsForeignThinkingBlocks reproduces the exact bug report:
// ask Claude, /model to DeepSeek, ask again, /model back to Claude. DeepSeek's
// thinking block (a UUID signature, captured from the live API) must not reach
// Bedrock, which rejects it with
// "messages.5.content.0: Invalid `signature` in `thinking` block".
func TestSwitchingModelsDropsForeignThinkingBlocks(t *testing.T) {
	req := map[string]any{
		"model": "us.anthropic.claude-sonnet-4-6",
		"messages": []any{
			userMsg("hi"),
			assistantMsg(thinkingBlock("Greeting.", "ErUBCkYIBxgCIkDs"), textBlock("Hi!")),
			userMsg("hi"),
			// DeepSeek's /anthropic surface returns a plain UUID as the signature.
			assistantMsg(thinkingBlock("Greeting again.", "4fd2c917-979d-4e69-8a37-3ce63dbd1f9b"), textBlock("Hi!")),
			userMsg("hi"),
		},
	}

	out, removed := stripPriorTurnThinking(req)
	if removed != 2 {
		t.Fatalf("expected both completed turns' thinking blocks removed, got %d", removed)
	}
	if n := countThinking(t, out); n != 0 {
		t.Fatalf("a thinking block still reaches the upstream: %d left", n)
	}

	msgs := out["messages"].([]any)
	if len(msgs) != 5 {
		t.Fatalf("no message should be dropped, got %d", len(msgs))
	}
	// The visible answers must survive: only the reasoning is dropped.
	for _, i := range []int{1, 3} {
		blocks := msgs[i].(map[string]any)["content"].([]any)
		if len(blocks) != 1 || blocks[0].(map[string]any)["type"] != "text" {
			t.Fatalf("message %d should keep exactly its text block, got %#v", i, blocks)
		}
	}
}

// TestSynthesisedEmptySignatureIsAlsoDropped covers the gateway's own output: the
// OpenAI/Gemini adapters map `reasoning_content` into a thinking block with
// `signature: ""`, which no Anthropic endpoint can validate either.
func TestSynthesisedEmptySignatureIsAlsoDropped(t *testing.T) {
	req := map[string]any{"messages": []any{
		userMsg("hi"),
		assistantMsg(thinkingBlock("Reasoning from an OpenAI-shaped provider.", ""), textBlock("Hi!")),
		userMsg("and now?"),
	}}
	out, removed := stripPriorTurnThinking(req)
	if removed != 1 || countThinking(t, out) != 0 {
		t.Fatalf("removed=%d remaining=%d, want 1 and 0", removed, countThinking(t, out))
	}
}

// TestRedactedThinkingIsStrippedToo — the docs say to strip both types together.
// Dropping only `thinking` would leave the same 400 in place.
func TestRedactedThinkingIsStrippedToo(t *testing.T) {
	req := map[string]any{"messages": []any{
		userMsg("hi"),
		assistantMsg(
			map[string]any{"type": "redacted_thinking", "data": "EroBCkYIBxgCIkD"},
			textBlock("Hi!"),
		),
		userMsg("again"),
	}}
	out, removed := stripPriorTurnThinking(req)
	if removed != 1 || countThinking(t, out) != 0 {
		t.Fatalf("redacted_thinking not stripped: removed=%d remaining=%d", removed, countThinking(t, out))
	}
}

// TestToolUseTurnKeepsItsThinkingBlocks pins the API's hard requirement: inside a
// tool-use turn the thinking blocks MUST be passed back unmodified. A tool_result
// user message continues the turn, it does not start a new one.
func TestToolUseTurnKeepsItsThinkingBlocks(t *testing.T) {
	toolUse := map[string]any{"type": "tool_use", "id": "toolu_1", "name": "ls", "input": map[string]any{}}
	req := map[string]any{"messages": []any{
		// A completed earlier turn — strippable.
		userMsg("hi"),
		assistantMsg(thinkingBlock("old", "sig-old"), textBlock("Hi!")),
		// The current turn starts here and is still running.
		userMsg("list the files"),
		assistantMsg(thinkingBlock("I should list them.", "sig-current"), toolUse),
		userMsg([]any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_1", "content": "a.txt"}}),
	}}

	out, removed := stripPriorTurnThinking(req)
	if removed != 1 {
		t.Fatalf("only the completed turn should be stripped, removed=%d", removed)
	}
	msgs := out["messages"].([]any)
	current := msgs[3].(map[string]any)["content"].([]any)
	if len(current) != 2 || current[0].(map[string]any)["signature"] != "sig-current" {
		t.Fatalf("the in-flight turn must be untouched, got %#v", current)
	}
}

// TestMultiRoundToolLoopKeepsTheWholeTurn: several tool rounds are still ONE
// assistant turn, so every thinking block after the user's instruction stays.
func TestMultiRoundToolLoopKeepsTheWholeTurn(t *testing.T) {
	toolResult := func(id string) any {
		return []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": "ok"}}
	}
	toolUse := func(id string) any {
		return map[string]any{"type": "tool_use", "id": id, "name": "ls", "input": map[string]any{}}
	}
	req := map[string]any{"messages": []any{
		userMsg("do the thing"),
		assistantMsg(thinkingBlock("step 1", "s1"), toolUse("t1")),
		userMsg(toolResult("t1")),
		assistantMsg(thinkingBlock("step 2", "s2"), toolUse("t2")),
		userMsg(toolResult("t2")),
	}}
	out, removed := stripPriorTurnThinking(req)
	if removed != 0 {
		t.Fatalf("nothing in the current turn may be dropped, removed=%d", removed)
	}
	if n := countThinking(t, out); n != 2 {
		t.Fatalf("both interleaved thinking blocks must survive, got %d", n)
	}
	if !reflect.DeepEqual(out, req) {
		t.Fatal("an unaffected request must be returned as-is (no reallocation)")
	}
}

// TestCallerMapIsNeverMutated: the server logs and settles billing against the
// original request, so the sanitiser must be copy-on-write.
func TestCallerMapIsNeverMutated(t *testing.T) {
	original := assistantMsg(thinkingBlock("keep me", "sig"), textBlock("Hi!"))
	req := map[string]any{"messages": []any{userMsg("hi"), original, userMsg("hi")}}
	before := countThinking(t, req)

	if _, removed := stripPriorTurnThinking(req); removed != 1 {
		t.Fatalf("removed=%d, want 1", removed)
	}
	if after := countThinking(t, req); after != before {
		t.Fatalf("caller's request was mutated: %d thinking blocks before, %d after", before, after)
	}
	if len(original["content"].([]any)) != 2 {
		t.Fatal("the caller's message content slice was mutated in place")
	}
}

// TestThinkingOnlyMessageIsDropped: a turn cut off mid-thought leaves nothing to
// send once the block is gone, so the message goes rather than being sent empty.
func TestThinkingOnlyMessageIsDropped(t *testing.T) {
	req := map[string]any{"messages": []any{
		userMsg("hi"),
		assistantMsg(thinkingBlock("cut off by max_tokens", "sig")),
		userMsg("continue"),
	}}
	out, removed := stripPriorTurnThinking(req)
	if removed != 1 {
		t.Fatalf("removed=%d, want 1", removed)
	}
	msgs := out["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("the empty assistant message should be dropped, got %d messages", len(msgs))
	}
	for _, m := range msgs {
		if m.(map[string]any)["role"] != "user" {
			t.Fatalf("unexpected surviving message %#v", m)
		}
	}
}

// TestNothingToStripIsAPassthrough guards the common case: no thinking anywhere
// means the exact same map comes back out.
func TestNothingToStripIsAPassthrough(t *testing.T) {
	req := map[string]any{"messages": []any{userMsg("hi"), assistantMsg(textBlock("Hi!")), userMsg("hi")}}
	out, removed := stripPriorTurnThinking(req)
	if removed != 0 {
		t.Fatalf("removed=%d, want 0", removed)
	}
	if !reflect.DeepEqual(out, req) {
		t.Fatal("expected the original map back")
	}
}

// TestMalformedHistoryIsLeftAlone: string content, a missing messages array and a
// history with no plain user message must not panic or corrupt the request.
func TestMalformedHistoryIsLeftAlone(t *testing.T) {
	cases := []map[string]any{
		{"model": "x"},
		{"messages": "not an array"},
		{"messages": []any{}},
		{"messages": []any{userMsg("hi"), map[string]any{"role": "assistant", "content": "plain string"}, userMsg("hi")}},
		// Tool results only: no turn boundary can be established.
		{"messages": []any{
			userMsg([]any{map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}}),
			assistantMsg(thinkingBlock("keep", "sig"), textBlock("hi")),
		}},
	}
	for i, req := range cases {
		out, removed := stripPriorTurnThinking(req)
		if removed != 0 {
			t.Fatalf("case %d: removed=%d, want 0", i, removed)
		}
		if !reflect.DeepEqual(out, req) {
			t.Fatalf("case %d: request was altered", i)
		}
	}
}

// TestBedrockBodyStripsForeignThinking checks the wire body Bedrock actually
// receives, i.e. that the sanitiser is really wired into the adapter and runs
// alongside the anthropic_version injection.
func TestBedrockBodyStripsForeignThinking(t *testing.T) {
	anth := map[string]any{
		"model":  "claude-sonnet-4-6",
		"stream": true,
		"messages": []any{
			userMsg("hi"),
			assistantMsg(thinkingBlock("from deepseek", "4fd2c917-979d-4e69-8a37-3ce63dbd1f9b"), textBlock("Hi!")),
			userMsg("hi"),
		},
	}
	body, err := bedrockBody(anth)
	if err != nil {
		t.Fatalf("bedrockBody: %v", err)
	}
	var sent map[string]any
	if err := json.Unmarshal(body, &sent); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if n := countThinking(t, sent); n != 0 {
		t.Fatalf("bedrock body still carries %d thinking block(s)", n)
	}
	if sent["anthropic_version"] != bedrockAPIVersion {
		t.Fatalf("anthropic_version missing: %#v", sent["anthropic_version"])
	}
	if _, ok := sent["model"]; ok {
		t.Fatal("model must not be sent to Bedrock")
	}
	if countThinking(t, anth) != 1 {
		t.Fatal("bedrockBody mutated the caller's request")
	}
}
