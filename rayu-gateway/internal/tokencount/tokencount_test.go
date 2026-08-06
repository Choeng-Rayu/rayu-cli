package tokencount

import (
	"encoding/json"
	"strings"
	"testing"
)

// The estimate is a heuristic, so these tests pin the properties callers rely on
// rather than exact numbers: it is stable, it grows with the payload, it counts
// every part of the request that occupies context, and it never returns 0 for a
// non-empty conversation (a 0 would make a client believe the window is empty).

func estimateJSON(t *testing.T, body string) int {
	t.Helper()
	n, ok := EstimateBody([]byte(body))
	if !ok {
		t.Fatalf("EstimateBody rejected %s", body)
	}
	return n
}

func TestEmptyAndTinyRequests(t *testing.T) {
	if n := estimateJSON(t, `{"model":"m","messages":[]}`); n != 0 {
		t.Errorf("no messages = %d tokens, want 0", n)
	}
	// A one-word message must cost something, or a client concludes the context is
	// empty and never compacts.
	if n := estimateJSON(t, `{"messages":[{"role":"user","content":"hi"}]}`); n < 1 {
		t.Errorf("tiny message = %d tokens, want >=1", n)
	}
}

func TestEstimateIsStable(t *testing.T) {
	body := `{"messages":[{"role":"user","content":"count these tokens please"}]}`
	first := estimateJSON(t, body)
	for i := 0; i < 5; i++ {
		if got := estimateJSON(t, body); got != first {
			t.Fatalf("estimate is not stable: %d then %d", first, got)
		}
	}
}

func TestEstimateGrowsWithContent(t *testing.T) {
	short := estimateJSON(t, `{"messages":[{"role":"user","content":"hello"}]}`)
	long := estimateJSON(t, `{"messages":[{"role":"user","content":"`+
		strings.Repeat("hello world ", 200)+`"}]}`)
	if long <= short*10 {
		t.Fatalf("long=%d short=%d — the estimate must scale with content", long, short)
	}
}

// Roughly 4 characters per token for prose: a 400-character message should land
// in the low hundreds, not the thousands or the single digits.
func TestProseIsAboutFourCharsPerToken(t *testing.T) {
	text := strings.Repeat("the quick brown fox jumps over the lazy dog ", 10) // 440 chars
	n := estimateJSON(t, `{"messages":[{"role":"user","content":"`+text+`"}]}`)
	if n < 80 || n > 160 {
		t.Fatalf("estimate=%d for %d chars of prose, want ~110", n, len(text))
	}
}

// Tool definitions ride along on EVERY agent request and are often the biggest
// fixed cost in the window, so omitting them would understate usage badly.
func TestToolsAreCounted(t *testing.T) {
	withoutTools := estimateJSON(t, `{"messages":[{"role":"user","content":"hi"}]}`)
	withTools := estimateJSON(t, `{"messages":[{"role":"user","content":"hi"}],
		"tools":[{"name":"read_file","description":"Read a file from disk and return its contents",
		"input_schema":{"type":"object","properties":{"path":{"type":"string","description":"absolute path"}}}}]}`)
	if withTools <= withoutTools+10 {
		t.Fatalf("tools added only %d tokens (%d → %d)", withTools-withoutTools, withoutTools, withTools)
	}
}

func TestSystemPromptIsCounted(t *testing.T) {
	plain := estimateJSON(t, `{"messages":[{"role":"user","content":"hi"}]}`)
	// system as a string…
	asString := estimateJSON(t, `{"system":"You are a careful engineer.","messages":[{"role":"user","content":"hi"}]}`)
	if asString <= plain {
		t.Fatalf("string system prompt not counted (%d vs %d)", asString, plain)
	}
	// …and as content blocks (what the CLI sends when it caches the prompt).
	asBlocks := estimateJSON(t, `{"system":[{"type":"text","text":"You are a careful engineer."}],
		"messages":[{"role":"user","content":"hi"}]}`)
	if asBlocks <= plain {
		t.Fatalf("block system prompt not counted (%d vs %d)", asBlocks, plain)
	}
}

// Every block type that occupies context must contribute, including ones added
// after this code was written.
func TestAllContentBlockKindsContribute(t *testing.T) {
	base := estimateJSON(t, `{"messages":[{"role":"user","content":[]}]}`)
	cases := map[string]string{
		"text":         `{"type":"text","text":"some words here"}`,
		"thinking":     `{"type":"thinking","thinking":"let me reason about this"}`,
		"tool_use":     `{"type":"tool_use","id":"t1","name":"bash","input":{"command":"ls -la /tmp"}}`,
		"tool_result":  `{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"file listing output"}]}`,
		"image":        `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR"}}`,
		"unknown_kind": `{"type":"some_future_block","payload":"with content inside it"}`,
	}
	for name, block := range cases {
		got := estimateJSON(t, `{"messages":[{"role":"user","content":[`+block+`]}]}`)
		if got <= base {
			t.Errorf("%s block contributed nothing (%d vs base %d)", name, got, base)
		}
	}
}

// An image is worth far more than its base64 length suggests, so it gets a flat
// per-image cost instead of being counted as text.
func TestImageCostsAFlatEstimate(t *testing.T) {
	n := estimateJSON(t, `{"messages":[{"role":"user","content":[
		{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo"}}]}]}`)
	if n < imageTokens {
		t.Fatalf("image estimate=%d, want at least %d", n, imageTokens)
	}
}

func TestRejectsUnparseableBody(t *testing.T) {
	if _, ok := EstimateBody([]byte(`not json`)); ok {
		t.Error("EstimateBody accepted a non-JSON body")
	}
}

// The real shape a CLI sends: system blocks + a multi-turn conversation with tool
// traffic + tools. It must produce one plausible number.
func TestRealisticConversation(t *testing.T) {
	body, err := json.Marshal(map[string]any{
		"model":      "deepseek-v4-flash",
		"max_tokens": 1,
		"system": []any{
			map[string]any{"type": "text", "text": strings.Repeat("You are Rayu, a coding agent. ", 20)},
		},
		"messages": []any{
			map[string]any{"role": "user", "content": "refactor the parser"},
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": "Reading the file first."},
				map[string]any{"type": "tool_use", "id": "t1", "name": "read_file",
					"input": map[string]any{"path": "/repo/src/parser.go"}},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "t1",
					"content": strings.Repeat("package parser\n", 100)},
			}},
		},
		"tools": []any{
			map[string]any{"name": "read_file", "description": "Read a file",
				"input_schema": map[string]any{"type": "object"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	n, ok := EstimateBody(body)
	if !ok {
		t.Fatal("EstimateBody rejected a realistic request")
	}
	// Sanity band: hundreds, not tens and not tens of thousands.
	if n < 200 || n > 5000 {
		t.Fatalf("estimate=%d for a realistic conversation, want a few hundred", n)
	}
}
