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

// decode is a small helper for asserting on translated request bodies.
func decode(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("bad JSON: %v (%s)", err, b)
	}
	return m
}

func buildChat(t *testing.T, anth map[string]any, model string, stream bool) map[string]any {
	t.Helper()
	body, err := buildOpenAIChatBody(anth, model, stream)
	if err != nil {
		t.Fatalf("buildOpenAIChatBody: %v", err)
	}
	return decode(t, body)
}

// --- request translation -----------------------------------------------------

func TestOpenAIChatBodyBasics(t *testing.T) {
	got := buildChat(t, map[string]any{
		"model":       "should-be-ignored",
		"max_tokens":  float64(512),
		"temperature": float64(0.3),
		"top_p":       float64(0.9),
		"system":      "be brief",
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
		},
	}, "deepseek-chat", true)

	// Model fidelity: the PROVIDER's model id is what goes upstream.
	if got["model"] != "deepseek-chat" {
		t.Errorf("model=%v want deepseek-chat", got["model"])
	}
	if got["max_tokens"] != float64(512) {
		t.Errorf("max_tokens=%v want 512", got["max_tokens"])
	}
	if got["temperature"] != 0.3 || got["top_p"] != 0.9 {
		t.Errorf("sampling params not forwarded: %v / %v", got["temperature"], got["top_p"])
	}
	if got["stream"] != true {
		t.Error("stream not set")
	}
	// Usage must be requested explicitly or the turn cannot be billed accurately.
	so, ok := got["stream_options"].(map[string]any)
	if !ok || so["include_usage"] != true {
		t.Errorf("stream_options=%v want include_usage:true", got["stream_options"])
	}
	msgs, _ := got["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages=%d want 2 (system + user)", len(msgs))
	}
	sys := msgs[0].(map[string]any)
	if sys["role"] != "system" || sys["content"] != "be brief" {
		t.Errorf("system message=%v", sys)
	}
}

// Reasoning families reject max_tokens and a custom temperature.
func TestOpenAIChatReasoningModelParams(t *testing.T) {
	anth := map[string]any{"max_tokens": float64(1000), "temperature": float64(0.7),
		"messages": []any{map[string]any{"role": "user", "content": "hi"}}}

	for _, model := range []string{"gpt-5.5", "o3-mini", "openai/o4-mini"} {
		got := buildChat(t, anth, model, false)
		if _, has := got["max_tokens"]; has {
			t.Errorf("%s: max_tokens must not be sent", model)
		}
		if got["max_completion_tokens"] != float64(1000) {
			t.Errorf("%s: max_completion_tokens=%v want 1000", model, got["max_completion_tokens"])
		}
		if _, has := got["temperature"]; has {
			t.Errorf("%s: temperature must be omitted for reasoning models", model)
		}
	}
	// A normal model keeps both.
	got := buildChat(t, anth, "gpt-4o", false)
	if got["max_tokens"] != float64(1000) || got["temperature"] != 0.7 {
		t.Errorf("gpt-4o: max_tokens=%v temperature=%v", got["max_tokens"], got["temperature"])
	}
}

func TestOpenAIChatThinkingMapsToReasoningEffort(t *testing.T) {
	cases := map[float64]string{1024: "low", 4096: "medium", 20000: "high"}
	for budget, want := range cases {
		got := buildChat(t, map[string]any{
			"thinking": map[string]any{"type": "enabled", "budget_tokens": budget},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}, "deepseek-reasoner", false)
		if got["reasoning_effort"] != want {
			t.Errorf("budget %v → reasoning_effort=%v want %v", budget, got["reasoning_effort"], want)
		}
	}
	// Explicitly disabled thinking must NOT request reasoning.
	got := buildChat(t, map[string]any{
		"thinking": map[string]any{"type": "disabled"},
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "deepseek-chat", false)
	if _, has := got["reasoning_effort"]; has {
		t.Error("reasoning_effort must be absent when thinking is disabled")
	}
}

func TestOpenAIChatToolsAndToolChoice(t *testing.T) {
	got := buildChat(t, map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{
			map[string]any{
				"name": "read_file", "description": "Read a file",
				"input_schema": map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}},
			},
			// Anthropic SERVER tool: versioned type, no input_schema → must be dropped
			// rather than sent as a phantom empty function.
			map[string]any{"type": "web_search_20260301", "name": "web_search"},
		},
		"tool_choice": map[string]any{"type": "any"},
	}, "deepseek-chat", false)

	tools, _ := got["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools=%d want 1 (server tool dropped): %v", len(tools), tools)
	}
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "read_file" || fn["description"] != "Read a file" {
		t.Errorf("function=%v", fn)
	}
	if fn["parameters"] == nil {
		t.Error("parameters (input_schema) missing")
	}
	if got["tool_choice"] != "required" {
		t.Errorf("tool_choice=%v want required (Anthropic 'any')", got["tool_choice"])
	}
}

// An assistant turn that only made tool calls must send content "" (never null):
// Gemini's OpenAI-compatibility layer 400s on null content for every later turn.
func TestOpenAIChatAssistantToolCallsUseEmptyStringContent(t *testing.T) {
	got := buildChat(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "read it"},
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": "toolu_1", "name": "read_file",
					"input": map[string]any{"path": "a.txt"}},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "toolu_1",
					"content": []any{map[string]any{"type": "text", "text": "file body"}}},
			}},
		},
	}, "deepseek-chat", false)

	msgs, _ := got["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages=%d want 3: %v", len(msgs), msgs)
	}
	assistant := msgs[1].(map[string]any)
	if assistant["content"] != "" {
		t.Errorf("assistant content=%v want empty string (never null)", assistant["content"])
	}
	calls, _ := assistant["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls=%v", assistant["tool_calls"])
	}
	call := calls[0].(map[string]any)
	if call["id"] != "toolu_1" {
		t.Errorf("tool call id=%v (must be echoed so the result can be paired)", call["id"])
	}
	if fn := call["function"].(map[string]any); fn["name"] != "read_file" ||
		!strings.Contains(fn["arguments"].(string), "a.txt") {
		t.Errorf("function=%v", fn)
	}
	// The tool result must come immediately after the assistant turn.
	toolMsg := msgs[2].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "toolu_1" || toolMsg["content"] != "file body" {
		t.Errorf("tool message=%v", toolMsg)
	}
}

func TestOpenAIChatImagesBecomeImageURLParts(t *testing.T) {
	got := buildChat(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "what is this?"},
				map[string]any{"type": "image", "source": map[string]any{
					"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}},
				map[string]any{"type": "image", "source": map[string]any{
					"type": "url", "url": "https://example.com/x.png"}},
			}},
		},
	}, "gpt-4o", false)

	msgs, _ := got["messages"].([]any)
	parts, ok := msgs[0].(map[string]any)["content"].([]any)
	if !ok {
		t.Fatalf("expected multimodal parts, got %#v", msgs[0])
	}
	if len(parts) != 3 {
		t.Fatalf("parts=%d want 3 (text + 2 images)", len(parts))
	}
	first := parts[1].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	if first != "data:image/jpeg;base64,AAAA" {
		t.Errorf("base64 image url=%q", first)
	}
	second := parts[2].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	if second != "https://example.com/x.png" {
		t.Errorf("url image=%q", second)
	}
}

// A tool result containing an image cannot stay in the `tool` message (its content
// must be a string), so it is re-sent as a following user message.
func TestOpenAIChatToolResultImagesBecomeFollowUpUserMessage(t *testing.T) {
	got := buildChat(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "toolu_9", "content": []any{
					map[string]any{"type": "text", "text": "screenshot taken"},
					map[string]any{"type": "image", "source": map[string]any{
						"type": "base64", "media_type": "image/png", "data": "BBBB"}},
				}},
			}},
		},
	}, "gpt-4o", false)

	msgs, _ := got["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages=%d want 2 (tool + image carrier): %v", len(msgs), msgs)
	}
	toolMsg := msgs[0].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["content"] != "screenshot taken" {
		t.Errorf("tool message=%v (content must be a plain string)", toolMsg)
	}
	carrier := msgs[1].(map[string]any)
	if carrier["role"] != "user" {
		t.Fatalf("image carrier role=%v want user", carrier["role"])
	}
	parts := carrier["content"].([]any)
	if len(parts) != 2 || parts[1].(map[string]any)["type"] != "image_url" {
		t.Errorf("carrier parts=%v", parts)
	}
}

// --- streaming translation ---------------------------------------------------

// sseEvents parses a translated Anthropic SSE stream into (event, payload) pairs.
func sseEvents(t *testing.T, raw string) []struct {
	Name string
	Data map[string]any
} {
	t.Helper()
	var out []struct {
		Name string
		Data map[string]any
	}
	for _, blockRaw := range strings.Split(raw, "\n\n") {
		block := strings.TrimSpace(blockRaw)
		if block == "" {
			continue
		}
		var name, data string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		if name == "" {
			continue
		}
		var payload map[string]any
		if data != "" {
			if err := json.Unmarshal([]byte(data), &payload); err != nil {
				t.Fatalf("event %s has bad JSON: %v (%s)", name, err, data)
			}
		}
		out = append(out, struct {
			Name string
			Data map[string]any
		}{name, payload})
	}
	return out
}

func eventNames(events []struct {
	Name string
	Data map[string]any
}) []string {
	names := make([]string, 0, len(events))
	for _, e := range events {
		names = append(names, e.Name)
	}
	return names
}

// streamOpenAIChat runs the adapter against an upstream that replays the given
// OpenAI SSE body, returning the translated Anthropic stream.
func streamOpenAIChat(t *testing.T, upstreamSSE string) (string, *testUsage) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, upstreamSSE)
	}))
	defer upstream.Close()

	a, err := For(providercfg.FormatOpenAIChat)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	usage, wrote, err := a.Stream(context.Background(), rec, Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIChat, providercfg.AuthBearer, "/v1/chat/completions"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "deepseek-chat",
		Anthropic: map[string]any{
			"model": "deepseek-chat", "max_tokens": float64(64), "stream": true,
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		},
		Stream: true,
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !wrote {
		t.Fatal("wrote=false")
	}
	tu := &testUsage{}
	if usage != nil {
		tu.prompt, tu.completion = usage.PromptTokens, usage.CompletionTokens
		tu.cacheRead, tu.fresh = usage.CacheReadTokens(), usage.FreshInputTokens()
	}
	return rec.Body.String(), tu
}

type testUsage struct{ prompt, completion, cacheRead, fresh int }

func TestOpenAIChatStreamTextTranslation(t *testing.T) {
	body, usage := streamOpenAIChat(t, strings.Join([]string{
		`data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"total_tokens":107,"prompt_tokens_details":{"cached_tokens":40}}}`,
		"data: [DONE]",
	}, "\n\n")+"\n\n")

	events := sseEvents(t, body)
	names := eventNames(events)
	want := []string{
		"message_start", "content_block_start", "content_block_delta",
		"content_block_delta", "content_block_stop", "message_delta", "message_stop",
	}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("event sequence=%v\nwant %v", names, want)
	}
	// Text deltas must carry Anthropic's text_delta shape.
	d := events[2].Data["delta"].(map[string]any)
	if d["type"] != "text_delta" || d["text"] != "Hello" {
		t.Errorf("first delta=%v", d)
	}
	md := events[5].Data
	if md["delta"].(map[string]any)["stop_reason"] != "end_turn" {
		t.Errorf("stop_reason=%v want end_turn", md["delta"])
	}
	// Usage on message_delta must be split into Anthropic's buckets.
	u := md["usage"].(map[string]any)
	if u["input_tokens"] != float64(60) || u["cache_read_input_tokens"] != float64(40) ||
		u["output_tokens"] != float64(7) {
		t.Errorf("usage=%v want fresh 60 / cached 40 / output 7", u)
	}
	// And the adapter must report the same numbers for billing.
	if usage.prompt != 100 || usage.completion != 7 || usage.cacheRead != 40 || usage.fresh != 60 {
		t.Errorf("billing usage=%+v want prompt100/completion7/cached40/fresh60", usage)
	}
}

func TestOpenAIChatStreamMaxTokensStopReason(t *testing.T) {
	body, _ := streamOpenAIChat(t, strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"tru"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"length"}]}`,
		"data: [DONE]",
	}, "\n\n")+"\n\n")
	events := sseEvents(t, body)
	last := events[len(events)-2] // message_delta
	if got := last.Data["delta"].(map[string]any)["stop_reason"]; got != "max_tokens" {
		t.Errorf("stop_reason=%v want max_tokens", got)
	}
}

func TestOpenAIChatStreamMultipleToolCalls(t *testing.T) {
	body, _ := streamOpenAIChat(t, strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"list_dir","arguments":"{}"}}]},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		"data: [DONE]",
	}, "\n\n")+"\n\n")

	events := sseEvents(t, body)
	// Two separate tool_use blocks, each with its own index.
	var starts []map[string]any
	var argDeltas []string
	var indices []float64
	for _, e := range events {
		switch e.Name {
		case "content_block_start":
			starts = append(starts, e.Data["content_block"].(map[string]any))
			indices = append(indices, e.Data["index"].(float64))
		case "content_block_delta":
			d := e.Data["delta"].(map[string]any)
			if d["type"] == "input_json_delta" {
				argDeltas = append(argDeltas, d["partial_json"].(string))
			}
		}
	}
	if len(starts) != 2 {
		t.Fatalf("tool_use blocks=%d want 2: %v", len(starts), starts)
	}
	if starts[0]["type"] != "tool_use" || starts[0]["id"] != "call_a" || starts[0]["name"] != "read_file" {
		t.Errorf("first tool block=%v", starts[0])
	}
	if starts[1]["id"] != "call_b" || starts[1]["name"] != "list_dir" {
		t.Errorf("second tool block=%v", starts[1])
	}
	if indices[0] == indices[1] {
		t.Errorf("parallel tool calls must use distinct block indices, got %v", indices)
	}
	// Argument fragments are streamed incrementally, in order.
	if strings.Join(argDeltas[:2], "") != `{"path":"a.txt"}` {
		t.Errorf("tool argument fragments=%v", argDeltas)
	}
	last := events[len(events)-2]
	if got := last.Data["delta"].(map[string]any)["stop_reason"]; got != "tool_use" {
		t.Errorf("stop_reason=%v want tool_use", got)
	}
}

func TestOpenAIChatStreamReasoningBecomesThinkingBlock(t *testing.T) {
	body, _ := streamOpenAIChat(t, strings.Join([]string{
		`data: {"choices":[{"delta":{"reasoning_content":"let me think"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}`,
		"data: [DONE]",
	}, "\n\n")+"\n\n")

	events := sseEvents(t, body)
	var kinds []string
	var thinkingText, text string
	for _, e := range events {
		switch e.Name {
		case "content_block_start":
			kinds = append(kinds, e.Data["content_block"].(map[string]any)["type"].(string))
		case "content_block_delta":
			d := e.Data["delta"].(map[string]any)
			if d["type"] == "thinking_delta" {
				thinkingText += d["thinking"].(string)
			}
			if d["type"] == "text_delta" {
				text += d["text"].(string)
			}
		}
	}
	if len(kinds) != 2 || kinds[0] != "thinking" || kinds[1] != "text" {
		t.Fatalf("block kinds=%v want [thinking text]", kinds)
	}
	if thinkingText != "let me think" || text != "answer" {
		t.Errorf("thinking=%q text=%q", thinkingText, text)
	}
}

// Alternate reasoning shapes (OpenRouter/Qwen) must be normalized too.
func TestReasoningTextShapes(t *testing.T) {
	cases := []struct {
		direct any
		field  string
		want   string
	}{
		{nil, "deepseek style", "deepseek style"},
		{"qwen style", "", "qwen style"},
		{map[string]any{"text": "object style"}, "", "object style"},
		{map[string]any{"content": "object content"}, "", "object content"},
		{[]any{"a", map[string]any{"text": "b"}, map[string]any{"content": "c"}}, "", "abc"},
		{nil, "", ""},
		{float64(7), "", ""},
	}
	for _, c := range cases {
		if got := reasoningText(c.direct, c.field); got != c.want {
			t.Errorf("reasoningText(%#v,%q)=%q want %q", c.direct, c.field, got, c.want)
		}
	}
}

// A stream that dies mid-flight must tell the client and still return the usage
// seen so far, so the caller settles what was actually consumed.
func TestOpenAIChatStreamMidStreamFailureReportsError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}`+"\n\n")
		_, _ = io.WriteString(w, `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`+"\n\n")
		// A line that never terminates, then the handler returns → truncated stream.
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"tial")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatOpenAIChat)
	rec := httptest.NewRecorder()
	usage, wrote, _ := a.Stream(context.Background(), rec, Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIChat, providercfg.AuthBearer, "/v1/chat/completions"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "deepseek-chat",
		Anthropic:       map[string]any{"model": "deepseek-chat", "stream": true},
		Stream:          true,
	})
	if !wrote {
		t.Fatal("wrote=false, want true (events were already sent)")
	}
	// Usage seen before the break must still be reported for settlement.
	if usage == nil || usage.PromptTokens != 10 {
		t.Errorf("usage=%+v want the pre-break usage", usage)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "message_stop") {
		t.Errorf("stream not properly closed: %s", body)
	}
}

// A pre-stream upstream failure must follow the shared relay policy: a
// client-fixable 400 keeps its cause, a provider 403 is masked as 502.
func TestOpenAIChatStreamPreflightErrorRelay(t *testing.T) {
	cases := []struct {
		upstreamStatus int
		upstreamBody   string
		wantStatus     int
		wantContains   string
		wantAbsent     string
	}{
		{http.StatusBadRequest, `{"error":{"message":"context length exceeded"}}`,
			http.StatusBadRequest, "context length exceeded", ""},
		{http.StatusForbidden, `{"error":{"message":"upgrade at https://provider.example/upgrade"}}`,
			http.StatusBadGateway, "", "provider.example"},
	}
	for _, c := range cases {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(c.upstreamStatus)
			_, _ = io.WriteString(w, c.upstreamBody)
		}))
		a, _ := For(providercfg.FormatOpenAIChat)
		rec := httptest.NewRecorder()
		_, wrote, err := a.Stream(context.Background(), rec, Request{
			Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIChat, providercfg.AuthBearer, "/v1/chat/completions"),
			Keys:            testKeys("sk-test"),
			UpstreamModelID: "deepseek-chat",
			Anthropic:       map[string]any{"model": "deepseek-chat", "stream": true},
			Stream:          true,
		})
		upstream.Close()
		if err == nil {
			t.Errorf("status %d: expected an error", c.upstreamStatus)
		}
		if !wrote {
			t.Errorf("status %d: wrote=false, want true (the adapter answered the client)", c.upstreamStatus)
		}
		if rec.Code != c.wantStatus {
			t.Errorf("upstream %d → client %d, want %d", c.upstreamStatus, rec.Code, c.wantStatus)
		}
		if c.wantContains != "" && !strings.Contains(rec.Body.String(), c.wantContains) {
			t.Errorf("client body should contain %q: %s", c.wantContains, rec.Body.String())
		}
		if c.wantAbsent != "" && strings.Contains(rec.Body.String(), c.wantAbsent) {
			t.Errorf("client body leaked provider detail %q: %s", c.wantAbsent, rec.Body.String())
		}
	}
}

// --- non-streaming translation ----------------------------------------------

func TestOpenAIChatCompleteTranslation(t *testing.T) {
	var gotBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"done","reasoning_content":"thought","tool_calls":[{"id":"call_x","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":9,"total_tokens":59,"prompt_cache_hit_tokens":30,"prompt_cache_miss_tokens":20}}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatOpenAIChat)
	usage, status, body, err := a.Complete(context.Background(), Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIChat, providercfg.AuthBearer, "/v1/chat/completions"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "deepseek-chat",
		Anthropic: map[string]any{
			"model": "deepseek-chat", "max_tokens": float64(32),
			"messages": []any{map[string]any{"role": "user", "content": "go"}},
		},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("status=%d", status)
	}
	// The upstream must not receive a stream flag on the non-streaming path.
	sent := decode(t, gotBody)
	if _, has := sent["stream"]; has {
		t.Error("non-streaming request must not set stream")
	}

	out := decode(t, body)
	if out["type"] != "message" || out["role"] != "assistant" {
		t.Errorf("envelope=%v", out)
	}
	if out["stop_reason"] != "tool_use" {
		t.Errorf("stop_reason=%v want tool_use", out["stop_reason"])
	}
	blocks := out["content"].([]any)
	if len(blocks) != 3 {
		t.Fatalf("content blocks=%d want 3 (thinking, text, tool_use): %v", len(blocks), blocks)
	}
	if blocks[0].(map[string]any)["type"] != "thinking" ||
		blocks[0].(map[string]any)["thinking"] != "thought" {
		t.Errorf("thinking block=%v", blocks[0])
	}
	if blocks[1].(map[string]any)["text"] != "done" {
		t.Errorf("text block=%v", blocks[1])
	}
	tool := blocks[2].(map[string]any)
	if tool["type"] != "tool_use" || tool["id"] != "call_x" || tool["name"] != "read_file" {
		t.Errorf("tool block=%v", tool)
	}
	// Arguments must be decoded into a real object, not left as a JSON string.
	if input, ok := tool["input"].(map[string]any); !ok || input["path"] != "a.txt" {
		t.Errorf("tool input=%#v want decoded object", tool["input"])
	}
	// DeepSeek-convention cache split must survive into both the body and billing.
	u := out["usage"].(map[string]any)
	if u["input_tokens"] != float64(20) || u["cache_read_input_tokens"] != float64(30) {
		t.Errorf("usage=%v want fresh 20 / cached 30", u)
	}
	if usage == nil || usage.CacheReadTokens() != 30 || usage.FreshInputTokens() != 20 {
		t.Errorf("billing usage=%+v", usage)
	}
}

func TestOpenAIChatCompleteReturnsUpstreamErrorUntranslated(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"bad tool schema"}}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatOpenAIChat)
	_, status, body, err := a.Complete(context.Background(), Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatOpenAIChat, providercfg.AuthBearer, "/v1/chat/completions"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "deepseek-chat",
		Anthropic:       map[string]any{"model": "deepseek-chat"},
	})
	if err != nil {
		t.Fatalf("Complete should not error on an upstream 4xx: %v", err)
	}
	if status != http.StatusBadRequest {
		t.Errorf("status=%d want 400 passed through for the caller to relay", status)
	}
	if !strings.Contains(string(body), "bad tool schema") {
		t.Errorf("upstream error body should be returned as-is: %s", body)
	}
}
