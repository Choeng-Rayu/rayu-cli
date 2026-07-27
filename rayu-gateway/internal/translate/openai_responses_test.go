package translate

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
)

func buildResponses(t *testing.T, anth map[string]any, model string, stream bool) map[string]any {
	t.Helper()
	body, err := buildResponsesBody(anth, model, stream)
	if err != nil {
		t.Fatalf("buildResponsesBody: %v", err)
	}
	return decode(t, body)
}

// --- request translation -----------------------------------------------------

func TestResponsesBodyBasics(t *testing.T) {
	got := buildResponses(t, map[string]any{
		"system":      "be brief",
		"max_tokens":  float64(256),
		"temperature": float64(0.4),
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
		},
	}, "gpt-5.5-mini", true)

	if got["model"] != "gpt-5.5-mini" {
		t.Errorf("model=%v", got["model"])
	}
	// The system prompt is `instructions` on this API, not a message.
	if got["instructions"] != "be brief" {
		t.Errorf("instructions=%v", got["instructions"])
	}
	// The token cap is max_output_tokens.
	if got["max_output_tokens"] != float64(256) {
		t.Errorf("max_output_tokens=%v want 256", got["max_output_tokens"])
	}
	if _, has := got["max_tokens"]; has {
		t.Error("max_tokens must not be sent to the Responses API")
	}
	// gpt-5 is a reasoning family: temperature must be omitted.
	if _, has := got["temperature"]; has {
		t.Error("temperature must be omitted for a reasoning model")
	}
	if got["stream"] != true {
		t.Error("stream not set")
	}
	// Obfuscation padding is pure overhead for a server-to-server relay.
	if got["include_obfuscation"] != false {
		t.Errorf("include_obfuscation=%v want false", got["include_obfuscation"])
	}
	input, _ := got["input"].([]any)
	if len(input) != 1 {
		t.Fatalf("input items=%d want 1: %v", len(input), input)
	}
	first := input[0].(map[string]any)
	parts := first["content"].([]any)
	if first["role"] != "user" || parts[0].(map[string]any)["type"] != "input_text" {
		t.Errorf("user item=%v (text parts must be input_text)", first)
	}
}

// Tool calls and their results are separate ITEMS paired by call_id — not
// position-dependent messages as in chat-completions.
func TestResponsesToolCallRoundTripBecomesItems(t *testing.T) {
	got := buildResponses(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "read it"},
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": "sure"},
				map[string]any{"type": "tool_use", "id": "call_1", "name": "read_file",
					"input": map[string]any{"path": "a.txt"}},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "call_1",
					"content": []any{map[string]any{"type": "text", "text": "contents"}}},
			}},
		},
	}, "gpt-5.5", false)

	input, _ := got["input"].([]any)
	types := make([]string, 0, len(input))
	for _, raw := range input {
		item := raw.(map[string]any)
		if t, ok := item["type"].(string); ok {
			types = append(types, t)
		} else {
			types = append(types, "message:"+item["role"].(string))
		}
	}
	want := []string{"message:user", "function_call", "message:assistant", "function_call_output"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Fatalf("item types=%v want %v", types, want)
	}
	call := input[1].(map[string]any)
	if call["call_id"] != "call_1" || call["name"] != "read_file" ||
		!strings.Contains(call["arguments"].(string), "a.txt") {
		t.Errorf("function_call item=%v", call)
	}
	// The result must reference the SAME call_id, which is how they pair up.
	out := input[3].(map[string]any)
	if out["call_id"] != "call_1" || out["output"] != "contents" {
		t.Errorf("function_call_output item=%v", out)
	}
	// Assistant text uses output_text.
	assistant := input[2].(map[string]any)
	if assistant["content"].([]any)[0].(map[string]any)["type"] != "output_text" {
		t.Errorf("assistant content=%v want output_text", assistant["content"])
	}
}

func TestResponsesToolsAreFlatAndImagesAreInputImage(t *testing.T) {
	got := buildResponses(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "see"},
				map[string]any{"type": "image", "source": map[string]any{
					"type": "base64", "media_type": "image/png", "data": "AAAA"}},
			}},
		},
		"tools": []any{
			map[string]any{"name": "read_file", "description": "Read",
				"input_schema": map[string]any{"type": "object"}},
			map[string]any{"type": "web_search_20260301", "name": "web_search"}, // server tool → dropped
		},
		"tool_choice": map[string]any{"type": "tool", "name": "read_file"},
	}, "gpt-4.1", false)

	tools, _ := got["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools=%d want 1 (server tool dropped)", len(tools))
	}
	tool := tools[0].(map[string]any)
	// FLAT shape: no nested "function" object on this API.
	if tool["type"] != "function" || tool["name"] != "read_file" || tool["parameters"] == nil {
		t.Errorf("tool=%v want flat {type,name,parameters}", tool)
	}
	if _, nested := tool["function"]; nested {
		t.Error("Responses tools must not nest under `function`")
	}
	tc, _ := got["tool_choice"].(map[string]any)
	if tc["type"] != "function" || tc["name"] != "read_file" {
		t.Errorf("tool_choice=%v want {type:function,name:read_file}", got["tool_choice"])
	}
	parts := got["input"].([]any)[0].(map[string]any)["content"].([]any)
	if len(parts) != 2 {
		t.Fatalf("content parts=%v", parts)
	}
	img := parts[1].(map[string]any)
	if img["type"] != "input_image" || img["image_url"] != "data:image/png;base64,AAAA" {
		t.Errorf("image part=%v want input_image with a data URL", img)
	}
}

func TestResponsesThinkingMapsToReasoningEffort(t *testing.T) {
	got := buildResponses(t, map[string]any{
		"thinking": map[string]any{"type": "enabled", "budget_tokens": float64(20000)},
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "gpt-5.5", false)
	r, _ := got["reasoning"].(map[string]any)
	if r["effort"] != "high" {
		t.Errorf("reasoning=%v want effort high", got["reasoning"])
	}

	off := buildResponses(t, map[string]any{
		"thinking": map[string]any{"type": "disabled"},
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "gpt-5.5", false)
	if _, has := off["reasoning"]; has {
		t.Error("reasoning must be absent when thinking is disabled")
	}
}

// --- usage mapping -----------------------------------------------------------

// input_tokens INCLUDES cached tokens, so fresh must be derived by subtraction —
// otherwise the cached prefix is billed twice.
func TestResponsesUsageCacheSubtraction(t *testing.T) {
	var u responsesUsage
	if err := json.Unmarshal([]byte(`{"input_tokens":1000,"output_tokens":50,"total_tokens":1050,
		"input_tokens_details":{"cached_tokens":900},
		"output_tokens_details":{"reasoning_tokens":30}}`), &u); err != nil {
		t.Fatal(err)
	}
	got := u.toUsage()
	if got.PromptTokens != 1000 || got.CompletionTokens != 50 || got.TotalTokens != 1050 {
		t.Errorf("usage=%+v", got)
	}
	if got.CacheReadTokens() != 900 {
		t.Errorf("cacheRead=%d want 900", got.CacheReadTokens())
	}
	if got.FreshInputTokens() != 100 {
		t.Errorf("fresh=%d want 100 (1000 total − 900 cached)", got.FreshInputTokens())
	}
	if got.CompletionTokensDetails.ReasoningTokens != 30 {
		t.Errorf("reasoning tokens=%d want 30", got.CompletionTokensDetails.ReasoningTokens)
	}
}

// The documented usage example has NO input_tokens_details, so it must be
// optional: absent means no cache discount.
func TestResponsesUsageWithoutCacheDetails(t *testing.T) {
	var u responsesUsage
	if err := json.Unmarshal([]byte(`{"input_tokens":40,"output_tokens":5,"total_tokens":45}`), &u); err != nil {
		t.Fatal(err)
	}
	got := u.toUsage()
	if got.CacheReadTokens() != 0 || got.FreshInputTokens() != 40 {
		t.Errorf("cacheRead=%d fresh=%d want 0/40", got.CacheReadTokens(), got.FreshInputTokens())
	}
	// A nil usage (event with no usage) must not panic or invent numbers.
	var nilUsage *responsesUsage
	if nilUsage.toUsage() != nil {
		t.Error("nil usage must map to nil")
	}
}

// --- streaming translation ---------------------------------------------------

func streamResponses(t *testing.T, upstreamSSE string) (string, *testUsage, error) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, upstreamSSE)
	}))
	defer upstream.Close()

	a, err := For(providercfg.FormatOpenAIResponses)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	usage, _, serr := a.Stream(context.Background(), rec, Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIResponses, providercfg.AuthBearer, "/v1/responses"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "gpt-5.5",
		Anthropic: map[string]any{
			"model": "gpt-5.5", "max_tokens": float64(64), "stream": true,
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		},
		Stream: true,
	})
	tu := &testUsage{}
	if usage != nil {
		tu.prompt, tu.completion = usage.PromptTokens, usage.CompletionTokens
		tu.cacheRead, tu.fresh = usage.CacheReadTokens(), usage.FreshInputTokens()
	}
	return rec.Body.String(), tu, serr
}

func TestResponsesStreamTextAndUsage(t *testing.T) {
	body, usage, err := streamResponses(t, strings.Join([]string{
		`data: {"type":"response.created","response":{"status":"in_progress"}}`,
		`data: {"type":"response.in_progress","response":{"status":"in_progress"}}`,
		`data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1"}}`,
		`data: {"type":"response.content_part.added","part":{"type":"output_text"}}`,
		`data: {"type":"response.output_text.delta","delta":"Hel","obfuscation":"xxxxx"}`,
		`data: {"type":"response.output_text.delta","delta":"lo","obfuscation":"yyyy"}`,
		`data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1"}}`,
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":500,"output_tokens":12,"total_tokens":512,"input_tokens_details":{"cached_tokens":400}}}}`,
	}, "\n\n")+"\n\n")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	events := sseEvents(t, body)
	names := eventNames(events)
	want := []string{"message_start", "content_block_start", "content_block_delta",
		"content_block_delta", "content_block_stop", "message_delta", "message_stop"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("event sequence=%v want %v", names, want)
	}
	var text string
	for _, e := range events {
		if e.Name == "content_block_delta" {
			text += e.Data["delta"].(map[string]any)["text"].(string)
		}
	}
	if text != "Hello" {
		t.Errorf("text=%q want Hello", text)
	}
	md := events[len(events)-2].Data
	if md["delta"].(map[string]any)["stop_reason"] != "end_turn" {
		t.Errorf("stop_reason=%v", md["delta"])
	}
	u := md["usage"].(map[string]any)
	if u["input_tokens"] != float64(100) || u["cache_read_input_tokens"] != float64(400) {
		t.Errorf("usage=%v want fresh 100 / cached 400", u)
	}
	if usage.prompt != 500 || usage.fresh != 100 || usage.cacheRead != 400 || usage.completion != 12 {
		t.Errorf("billing usage=%+v", usage)
	}
}

func TestResponsesStreamFunctionCall(t *testing.T) {
	body, _, err := streamResponses(t, strings.Join([]string{
		`data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_9","name":"read_file","arguments":""}}`,
		`data: {"type":"response.function_call_arguments.delta","delta":"{\"path\":"}`,
		`data: {"type":"response.function_call_arguments.delta","delta":"\"a.txt\"}"}`,
		`data: {"type":"response.function_call_arguments.done","arguments":"{\"path\":\"a.txt\"}"}`,
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28}}}`,
	}, "\n\n")+"\n\n")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	events := sseEvents(t, body)
	var block map[string]any
	var args string
	for _, e := range events {
		switch e.Name {
		case "content_block_start":
			block = e.Data["content_block"].(map[string]any)
		case "content_block_delta":
			d := e.Data["delta"].(map[string]any)
			if d["type"] == "input_json_delta" {
				args += d["partial_json"].(string)
			}
		}
	}
	if block == nil || block["type"] != "tool_use" || block["id"] != "call_9" || block["name"] != "read_file" {
		t.Fatalf("tool block=%v (id must be the call_id so the result pairs)", block)
	}
	if args != `{"path":"a.txt"}` {
		t.Errorf("streamed arguments=%q", args)
	}
	if got := events[len(events)-2].Data["delta"].(map[string]any)["stop_reason"]; got != "tool_use" {
		t.Errorf("stop_reason=%v want tool_use", got)
	}
}

func TestResponsesStreamReasoningBecomesThinking(t *testing.T) {
	body, _, err := streamResponses(t, strings.Join([]string{
		`data: {"type":"response.reasoning_summary_text.delta","delta":"weighing options"}`,
		`data: {"type":"response.output_text.delta","delta":"answer"}`,
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7,"output_tokens_details":{"reasoning_tokens":1}}}}`,
	}, "\n\n")+"\n\n")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	events := sseEvents(t, body)
	var kinds []string
	for _, e := range events {
		if e.Name == "content_block_start" {
			kinds = append(kinds, e.Data["content_block"].(map[string]any)["type"].(string))
		}
	}
	if len(kinds) != 2 || kinds[0] != "thinking" || kinds[1] != "text" {
		t.Errorf("block kinds=%v want [thinking text]", kinds)
	}
}

// response.incomplete is a TERMINAL EVENT ON A 200 STREAM: max_tokens truncation
// must become Anthropic's max_tokens stop reason, and usage must still settle.
func TestResponsesStreamIncompleteBecomesMaxTokensStop(t *testing.T) {
	body, usage, err := streamResponses(t, strings.Join([]string{
		`data: {"type":"response.output_text.delta","delta":"trunca"}`,
		`data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_tokens"},"usage":{"input_tokens":30,"output_tokens":64,"total_tokens":94}}}`,
	}, "\n\n")+"\n\n")
	if err != nil {
		t.Fatalf("an incomplete response is not a transport error: %v", err)
	}
	events := sseEvents(t, body)
	md := events[len(events)-2].Data
	if got := md["delta"].(map[string]any)["stop_reason"]; got != "max_tokens" {
		t.Fatalf("stop_reason=%v want max_tokens", got)
	}
	if usage.prompt != 30 || usage.completion != 64 {
		t.Errorf("usage=%+v want 30/64 (truncated turns are still billed)", usage)
	}
}

// response.failed is also terminal on a 200 stream: the client must be told, the
// stream must close cleanly, and the error must surface for logging/settlement.
func TestResponsesStreamFailedEventIsReported(t *testing.T) {
	body, usage, err := streamResponses(t, strings.Join([]string{
		`data: {"type":"response.output_text.delta","delta":"partial"}`,
		`data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response."},"usage":{"input_tokens":11,"output_tokens":3,"total_tokens":14}}}`,
	}, "\n\n")+"\n\n")
	if err == nil {
		t.Fatal("a response.failed event must be reported as an error")
	}
	if !strings.Contains(err.Error(), "server_error") {
		t.Errorf("error should carry the provider's code: %v", err)
	}
	if usage.prompt != 11 {
		t.Errorf("usage=%+v want the reported usage even on failure", usage)
	}
	// The client learns about it AND the stream is closed properly.
	if !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, "message_stop") {
		t.Errorf("client stream should carry an error event and close: %s", body)
	}
	// The provider's raw message must not be forwarded verbatim mid-stream.
	if strings.Contains(body, "The model failed to generate a response.") {
		t.Errorf("provider error text leaked to the client: %s", body)
	}
}

// --- non-streaming translation ----------------------------------------------

func TestResponsesCompleteTranslation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"status":"completed",
			"output":[
			  {"type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]},
			  {"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]},
			  {"type":"function_call","call_id":"call_7","name":"read_file","arguments":"{\"path\":\"b.txt\"}"}
			],
			"usage":{"input_tokens":80,"output_tokens":10,"total_tokens":90,"input_tokens_details":{"cached_tokens":60}}
		}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatOpenAIResponses)
	usage, status, body, err := a.Complete(context.Background(), Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIResponses, providercfg.AuthBearer, "/v1/responses"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "gpt-5.5",
		Anthropic:       map[string]any{"model": "gpt-5.5", "max_tokens": float64(32)},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("status=%d", status)
	}
	out := decode(t, body)
	if out["type"] != "message" || out["stop_reason"] != "tool_use" {
		t.Errorf("envelope=%v want message/tool_use", out)
	}
	blocks := out["content"].([]any)
	if len(blocks) != 3 {
		t.Fatalf("blocks=%d want 3: %v", len(blocks), blocks)
	}
	if blocks[0].(map[string]any)["thinking"] != "thought" {
		t.Errorf("thinking block=%v", blocks[0])
	}
	if blocks[1].(map[string]any)["text"] != "done" {
		t.Errorf("text block=%v", blocks[1])
	}
	tool := blocks[2].(map[string]any)
	if tool["id"] != "call_7" || tool["input"].(map[string]any)["path"] != "b.txt" {
		t.Errorf("tool block=%v", tool)
	}
	if usage.FreshInputTokens() != 20 || usage.CacheReadTokens() != 60 {
		t.Errorf("usage fresh=%d cached=%d want 20/60", usage.FreshInputTokens(), usage.CacheReadTokens())
	}
}

// A 200 whose body says status:"failed" must not be presented as success.
func TestResponsesCompleteFailedStatusIsAnError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"failed","error":{"code":"server_error","message":"boom"},"output":[],"usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatOpenAIResponses)
	usage, status, _, err := a.Complete(context.Background(), Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIResponses, providercfg.AuthBearer, "/v1/responses"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "gpt-5.5",
		Anthropic:       map[string]any{"model": "gpt-5.5"},
	})
	if err == nil {
		t.Fatal("status:failed must be surfaced as an error")
	}
	if status != http.StatusBadGateway {
		t.Errorf("status=%d want 502 so the caller masks it", status)
	}
	if usage == nil || usage.PromptTokens != 3 {
		t.Errorf("usage=%+v should still be reported", usage)
	}
}

func TestResponsesCompleteMaxTokensStop(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"status":"incomplete","incomplete_details":{"reason":"max_tokens"},
			"output":[{"type":"message","content":[{"type":"output_text","text":"trunc"}]}],
			"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatOpenAIResponses)
	_, status, body, err := a.Complete(context.Background(), Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIResponses, providercfg.AuthBearer, "/v1/responses"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "gpt-5.5",
		Anthropic:       map[string]any{"model": "gpt-5.5"},
	})
	if err != nil || status != http.StatusOK {
		t.Fatalf("err=%v status=%d — truncation is a normal outcome", err, status)
	}
	if got := decode(t, body)["stop_reason"]; got != "max_tokens" {
		t.Errorf("stop_reason=%v want max_tokens", got)
	}
}
