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

func buildGenAI(t *testing.T, anth map[string]any) map[string]any {
	t.Helper()
	body, err := buildGenAIBody(anth)
	if err != nil {
		t.Fatalf("buildGenAIBody: %v", err)
	}
	return decode(t, body)
}

func genaiRoute(t *testing.T, baseURL string) providercfg.Route {
	t.Helper()
	// endpointPath is blank for genai: the adapter builds a model-specific URL.
	return testRoute(t, baseURL, providercfg.FormatGenAI, providercfg.AuthXGoogAPIKey, "")
}

// --- URL + auth --------------------------------------------------------------

// The model id and streaming mode live in the URL for this API.
func TestGenAIEndpointURL(t *testing.T) {
	r := providercfg.Route{Format: providercfg.FormatGenAI, BaseURL: "https://generativelanguage.googleapis.com"}
	if got, want := genAIEndpoint(r, "gemini-3-pro", true),
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse"; got != want {
		t.Errorf("stream URL=%q want %q", got, want)
	}
	if got, want := genAIEndpoint(r, "gemini-3-pro", false),
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent"; got != want {
		t.Errorf("non-stream URL=%q want %q", got, want)
	}
	// A "models/" prefix on the stored model id must not be doubled.
	if got := genAIEndpoint(r, "models/gemini-3-pro", false); strings.Contains(got, "models/models/") {
		t.Errorf("model prefix doubled: %q", got)
	}
	// An admin override may template the model/method.
	r.EndpointPath = "/v1/custom/{model}:{method}"
	if got, want := genAIEndpoint(r, "gemini-x", true),
		"https://generativelanguage.googleapis.com/v1/custom/gemini-x:streamGenerateContent?alt=sse"; got != want {
		t.Errorf("override URL=%q want %q", got, want)
	}
}

func TestGenAIUsesGoogleAPIKeyHeader(t *testing.T) {
	var gotKeyHeader, gotAuth, gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKeyHeader = r.Header.Get("x-goog-api-key")
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path + "?" + r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],
			"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}`)
	}))
	defer upstream.Close()

	a, err := For(providercfg.FormatGenAI)
	if err != nil {
		t.Fatal(err)
	}
	if _, status, _, err := a.Complete(context.Background(), Request{
		Route:           genaiRoute(t, upstream.URL),
		Keys:            testKeys("AIza-test"),
		UpstreamModelID: "gemini-3-pro",
		Anthropic:       map[string]any{"model": "gemini-3-pro"},
	}); err != nil || status != http.StatusOK {
		t.Fatalf("Complete err=%v status=%d", err, status)
	}
	if gotKeyHeader != "AIza-test" {
		t.Errorf("x-goog-api-key=%q want AIza-test", gotKeyHeader)
	}
	if gotAuth != "" {
		t.Errorf("Authorization must not be set for x_goog_api_key auth, got %q", gotAuth)
	}
	if !strings.Contains(gotPath, "/v1beta/models/gemini-3-pro:generateContent") {
		t.Errorf("upstream path=%q", gotPath)
	}
}

// --- request translation -----------------------------------------------------

func TestGenAIBodyRolesAndSystemInstruction(t *testing.T) {
	got := buildGenAI(t, map[string]any{
		"system":      "be brief",
		"max_tokens":  float64(128),
		"temperature": float64(0.2),
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "assistant", "content": "hello"},
		},
	})
	si, _ := got["systemInstruction"].(map[string]any)
	if si == nil || si["parts"].([]any)[0].(map[string]any)["text"] != "be brief" {
		t.Errorf("systemInstruction=%v", got["systemInstruction"])
	}
	cfg, _ := got["generationConfig"].(map[string]any)
	if cfg["maxOutputTokens"] != float64(128) || cfg["temperature"] != 0.2 {
		t.Errorf("generationConfig=%v", cfg)
	}
	contents, _ := got["contents"].([]any)
	if len(contents) != 2 {
		t.Fatalf("contents=%v", contents)
	}
	// Gemini's assistant role is "model", not "assistant".
	if contents[0].(map[string]any)["role"] != "user" ||
		contents[1].(map[string]any)["role"] != "model" {
		t.Errorf("roles=%v/%v want user/model",
			contents[0].(map[string]any)["role"], contents[1].(map[string]any)["role"])
	}
}

// Gemini keys a tool RESULT by function NAME, so the adapter must resolve
// tool_use_id → name from the conversation.
func TestGenAIToolResultIsKeyedByFunctionName(t *testing.T) {
	got := buildGenAI(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": "toolu_42", "name": "read_file",
					"input": map[string]any{"path": "a.txt"}},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "toolu_42",
					"content": []any{map[string]any{"type": "text", "text": "body"}}},
			}},
		},
	})
	contents, _ := got["contents"].([]any)
	if len(contents) != 2 {
		t.Fatalf("contents=%v", contents)
	}
	call := contents[0].(map[string]any)["parts"].([]any)[0].(map[string]any)
	fc, _ := call["functionCall"].(map[string]any)
	if fc == nil || fc["name"] != "read_file" {
		t.Fatalf("functionCall=%v", call)
	}
	resp := contents[1].(map[string]any)["parts"].([]any)[0].(map[string]any)
	fr, _ := resp["functionResponse"].(map[string]any)
	if fr == nil || fr["name"] != "read_file" {
		t.Fatalf("functionResponse=%v want name read_file (NOT the tool id)", resp)
	}
	if fr["response"].(map[string]any)["result"] != "body" {
		t.Errorf("functionResponse response=%v", fr["response"])
	}
}

// Gemini 3 rejects a follow-up turn whose functionCall lost its thoughtSignature,
// so a signature replayed by the client must be echoed back.
func TestGenAIEchoesThoughtSignatureFromClientBlock(t *testing.T) {
	got := buildGenAI(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": "toolu_sig", "name": "read_file",
					"input": map[string]any{}, "thought_signature": "SIG-FROM-CLIENT"},
			}},
		},
	})
	part := got["contents"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)
	if part["thoughtSignature"] != "SIG-FROM-CLIENT" {
		t.Errorf("thoughtSignature=%v want the client's replayed value", part["thoughtSignature"])
	}
}

// When the client stripped the field, the gateway's bounded cache supplies it.
func TestGenAIEchoesThoughtSignatureFromCache(t *testing.T) {
	rememberThoughtSignature("toolu_cached", "SIG-FROM-CACHE")
	got := buildGenAI(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": "toolu_cached", "name": "x", "input": map[string]any{}},
			}},
		},
	})
	part := got["contents"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)
	if part["thoughtSignature"] != "SIG-FROM-CACHE" {
		t.Errorf("thoughtSignature=%v want the cached value", part["thoughtSignature"])
	}
}

func TestThoughtSignatureCacheIsBounded(t *testing.T) {
	for i := 0; i < maxThoughtSignatures+50; i++ {
		rememberThoughtSignature("id-"+string(rune('a'+i%26))+itoa(i), "sig")
	}
	thoughtSigs.mu.Lock()
	size := len(thoughtSigs.byID)
	thoughtSigs.mu.Unlock()
	if size > maxThoughtSignatures {
		t.Fatalf("cache grew to %d, must stay <= %d", size, maxThoughtSignatures)
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func TestGenAIImagesBecomeInlineData(t *testing.T) {
	got := buildGenAI(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "see"},
				map[string]any{"type": "image", "source": map[string]any{
					"type": "base64", "media_type": "image/webp", "data": "ZZZZ"}},
				// Gemini has no URL image part: this must be dropped, not sent in a
				// shape the API would reject.
				map[string]any{"type": "image", "source": map[string]any{
					"type": "url", "url": "https://example.com/a.png"}},
			}},
		},
	})
	parts := got["contents"].([]any)[0].(map[string]any)["parts"].([]any)
	if len(parts) != 2 {
		t.Fatalf("parts=%v want text + one inlineData", parts)
	}
	inline, _ := parts[1].(map[string]any)["inlineData"].(map[string]any)
	if inline == nil || inline["mimeType"] != "image/webp" || inline["data"] != "ZZZZ" {
		t.Errorf("inlineData=%v", parts[1])
	}
}

func TestGenAIToolsAndThinkingConfig(t *testing.T) {
	got := buildGenAI(t, map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"thinking": map[string]any{"type": "enabled", "budget_tokens": float64(4096)},
		"tools": []any{
			map[string]any{"name": "read_file", "description": "Read",
				"input_schema": map[string]any{
					"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}},
					// Not in Gemini's accepted subset — must be stripped or Gemini 400s.
					"additionalProperties": false,
					"$schema":              "http://json-schema.org/draft-07/schema#",
				}},
			map[string]any{"type": "web_search_20260301", "name": "web_search"}, // server tool → dropped
		},
		"tool_choice": map[string]any{"type": "tool", "name": "read_file"},
	})
	tools, _ := got["tools"].([]any)
	decls := tools[0].(map[string]any)["functionDeclarations"].([]any)
	if len(decls) != 1 {
		t.Fatalf("functionDeclarations=%d want 1 (server tool dropped)", len(decls))
	}
	params := decls[0].(map[string]any)["parameters"].(map[string]any)
	if _, has := params["additionalProperties"]; has {
		t.Error("additionalProperties must be stripped from a Gemini schema")
	}
	if _, has := params["$schema"]; has {
		t.Error("$schema must be stripped from a Gemini schema")
	}
	if params["properties"] == nil {
		t.Error("properties must survive sanitization")
	}
	tc := got["toolConfig"].(map[string]any)["functionCallingConfig"].(map[string]any)
	if tc["mode"] != "ANY" || tc["allowedFunctionNames"].([]any)[0] != "read_file" {
		t.Errorf("toolConfig=%v", tc)
	}
	think := got["generationConfig"].(map[string]any)["thinkingConfig"].(map[string]any)
	// includeThoughts is required for Gemini to return thought summaries at all.
	if think["includeThoughts"] != true || think["thinkingBudget"] != float64(4096) {
		t.Errorf("thinkingConfig=%v", think)
	}
}

func TestSanitizeGeminiSchemaCollapsesNullableUnions(t *testing.T) {
	in := map[string]any{
		"type":        []any{"string", "null"},
		"description": "x",
		"$ref":        "#/defs/y",
	}
	out := sanitizeGeminiSchema(in).(map[string]any)
	if out["type"] != "string" || out["nullable"] != true {
		t.Errorf("out=%v want type string + nullable true", out)
	}
	if _, has := out["$ref"]; has {
		t.Error("$ref must be stripped")
	}
}

// --- usage mapping -----------------------------------------------------------

// promptTokenCount ALREADY INCLUDES cachedContentTokenCount (double-billing
// hazard), and thoughtsTokenCount is output the provider charges for.
func TestGenAIUsageMapping(t *testing.T) {
	var u genAIUsage
	if err := json.Unmarshal([]byte(`{"promptTokenCount":1000,"candidatesTokenCount":40,
		"cachedContentTokenCount":900,"thoughtsTokenCount":60,"totalTokenCount":1100}`), &u); err != nil {
		t.Fatal(err)
	}
	got := u.toUsage()
	if got.FreshInputTokens() != 100 {
		t.Errorf("fresh=%d want 100 (1000 prompt − 900 cached)", got.FreshInputTokens())
	}
	if got.CacheReadTokens() != 900 {
		t.Errorf("cacheRead=%d want 900", got.CacheReadTokens())
	}
	if got.CompletionTokens != 100 {
		t.Errorf("completion=%d want 100 (40 candidates + 60 thoughts, both billed as output)", got.CompletionTokens)
	}
	if got.CompletionTokensDetails.ReasoningTokens != 60 {
		t.Errorf("reasoning=%d want 60", got.CompletionTokensDetails.ReasoningTokens)
	}
	if got.TotalTokens != 1100 {
		t.Errorf("total=%d want 1100", got.TotalTokens)
	}
	var nilUsage *genAIUsage
	if nilUsage.toUsage() != nil {
		t.Error("nil usage must map to nil")
	}
}

func TestGenAIStopReasonMapping(t *testing.T) {
	cases := []struct {
		finish string
		tool   bool
		want   string
	}{
		{"STOP", false, "end_turn"},
		{"MAX_TOKENS", false, "max_tokens"},
		{"", false, "end_turn"},
		{"SAFETY", false, "end_turn"},
		{"STOP", true, "tool_use"},
		{"MAX_TOKENS", true, "tool_use"},
	}
	for _, c := range cases {
		if got := genAIStopReason(c.finish, c.tool); got != c.want {
			t.Errorf("genAIStopReason(%q,%v)=%q want %q", c.finish, c.tool, got, c.want)
		}
	}
}

// --- streaming translation ---------------------------------------------------

func streamGenAI(t *testing.T, upstreamSSE string) (string, *testUsage, error) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, upstreamSSE)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatGenAI)
	rec := httptest.NewRecorder()
	usage, _, serr := a.Stream(context.Background(), rec, Request{
		Route:           genaiRoute(t, upstream.URL),
		Keys:            testKeys("AIza-test"),
		UpstreamModelID: "gemini-3-pro",
		Anthropic: map[string]any{
			"model": "gemini-3-pro", "max_tokens": float64(64), "stream": true,
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

func TestGenAIStreamTextAndUsage(t *testing.T) {
	body, usage, err := streamGenAI(t, strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}`,
		`data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":500,"candidatesTokenCount":10,"cachedContentTokenCount":400,"totalTokenCount":510}}`,
	}, "\n\n")+"\n\n")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	events := sseEvents(t, body)
	want := []string{"message_start", "content_block_start", "content_block_delta",
		"content_block_delta", "content_block_stop", "message_delta", "message_stop"}
	if got := strings.Join(eventNames(events), ","); got != strings.Join(want, ",") {
		t.Fatalf("event sequence=%v want %v", eventNames(events), want)
	}
	var text string
	for _, e := range events {
		if e.Name == "content_block_delta" {
			text += e.Data["delta"].(map[string]any)["text"].(string)
		}
	}
	if text != "Hello" {
		t.Errorf("text=%q", text)
	}
	u := events[len(events)-2].Data["usage"].(map[string]any)
	if u["input_tokens"] != float64(100) || u["cache_read_input_tokens"] != float64(400) {
		t.Errorf("usage=%v want fresh 100 / cached 400", u)
	}
	if usage.fresh != 100 || usage.cacheRead != 400 || usage.completion != 10 {
		t.Errorf("billing usage=%+v", usage)
	}
}

// A thought part also carries `text`, so it must be recognised as thinking and
// not leak the chain-of-thought into the visible answer.
func TestGenAIStreamThoughtPartsBecomeThinking(t *testing.T) {
	body, _, err := streamGenAI(t, strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"considering","thought":true}]}}]}`,
		`data: {"candidates":[{"content":{"parts":[{"text":"final"}]},"finishReason":"STOP"}]}`,
	}, "\n\n")+"\n\n")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	events := sseEvents(t, body)
	var kinds []string
	var thinking, text string
	for _, e := range events {
		switch e.Name {
		case "content_block_start":
			kinds = append(kinds, e.Data["content_block"].(map[string]any)["type"].(string))
		case "content_block_delta":
			d := e.Data["delta"].(map[string]any)
			switch d["type"] {
			case "thinking_delta":
				thinking += d["thinking"].(string)
			case "text_delta":
				text += d["text"].(string)
			}
		}
	}
	if len(kinds) != 2 || kinds[0] != "thinking" || kinds[1] != "text" {
		t.Fatalf("kinds=%v want [thinking text]", kinds)
	}
	if thinking != "considering" || text != "final" {
		t.Errorf("thinking=%q text=%q (a thought part must not become visible text)", thinking, text)
	}
}

func TestGenAIStreamFunctionCall(t *testing.T) {
	body, _, err := streamGenAI(t, strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}},"thoughtSignature":"SIG-1"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3,"totalTokenCount":12}}`,
	}, "\n\n")+"\n\n")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	events := sseEvents(t, body)
	var block map[string]any
	var args, sig string
	for _, e := range events {
		switch e.Name {
		case "content_block_start":
			block = e.Data["content_block"].(map[string]any)
		case "content_block_delta":
			d := e.Data["delta"].(map[string]any)
			switch d["type"] {
			case "input_json_delta":
				args += d["partial_json"].(string)
			case "signature_delta":
				sig = d["signature"].(string)
			}
		}
	}
	if block == nil || block["type"] != "tool_use" || block["name"] != "read_file" {
		t.Fatalf("tool block=%v", block)
	}
	if args != `{"path":"a.txt"}` {
		t.Errorf("args=%q", args)
	}
	// The thought signature is relayed so the next turn can replay it.
	if sig != "SIG-1" {
		t.Errorf("signature_delta=%q want SIG-1", sig)
	}
	// And cached under the id the client will echo back.
	if id, _ := block["id"].(string); thoughtSignature(id) != "SIG-1" {
		t.Errorf("signature not cached for id %q", block["id"])
	}
	if got := events[len(events)-2].Data["delta"].(map[string]any)["stop_reason"]; got != "tool_use" {
		t.Errorf("stop_reason=%v want tool_use", got)
	}
}

func TestGenAIStreamMaxTokensAndSafetyStops(t *testing.T) {
	for finish, want := range map[string]string{"MAX_TOKENS": "max_tokens", "SAFETY": "end_turn"} {
		body, _, err := streamGenAI(t, `data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"`+finish+`"}]}`+"\n\n")
		if err != nil {
			t.Fatalf("%s: %v", finish, err)
		}
		events := sseEvents(t, body)
		if got := events[len(events)-2].Data["delta"].(map[string]any)["stop_reason"]; got != want {
			t.Errorf("finishReason %s → stop_reason %v, want %v", finish, got, want)
		}
	}
}

func TestGenAIStreamPreflightErrorIsMasked(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"message":"API key not valid for project secret-project-123"}}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatGenAI)
	rec := httptest.NewRecorder()
	_, wrote, err := a.Stream(context.Background(), rec, Request{
		Route:           genaiRoute(t, upstream.URL),
		Keys:            testKeys("AIza-bad"),
		UpstreamModelID: "gemini-3-pro",
		Anthropic:       map[string]any{"model": "gemini-3-pro", "stream": true},
		Stream:          true,
	})
	if err == nil || !wrote {
		t.Fatalf("err=%v wrote=%v want an error that answered the client", err, wrote)
	}
	if rec.Code != http.StatusBadGateway {
		t.Errorf("client status=%d want 502 (provider auth failure is masked)", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "secret-project-123") {
		t.Errorf("provider detail leaked: %s", rec.Body.String())
	}
}

// --- non-streaming translation ----------------------------------------------

func TestGenAICompleteTranslation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[
			{"text":"weighing","thought":true},
			{"text":"answer"},
			{"functionCall":{"name":"list_dir","args":{"path":"."}},"thoughtSignature":"SIG-2"}
		]},"finishReason":"STOP"}],
		"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":8,"cachedContentTokenCount":60,"thoughtsTokenCount":4,"totalTokenCount":112}}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatGenAI)
	usage, status, body, err := a.Complete(context.Background(), Request{
		Route:           genaiRoute(t, upstream.URL),
		Keys:            testKeys("AIza-test"),
		UpstreamModelID: "gemini-3-pro",
		Anthropic:       map[string]any{"model": "gemini-3-pro"},
	})
	if err != nil || status != http.StatusOK {
		t.Fatalf("err=%v status=%d", err, status)
	}
	out := decode(t, body)
	if out["type"] != "message" || out["stop_reason"] != "tool_use" {
		t.Errorf("envelope=%v", out)
	}
	blocks := out["content"].([]any)
	if len(blocks) != 3 {
		t.Fatalf("blocks=%d want 3: %v", len(blocks), blocks)
	}
	if blocks[0].(map[string]any)["type"] != "thinking" ||
		blocks[0].(map[string]any)["thinking"] != "weighing" {
		t.Errorf("thinking block=%v", blocks[0])
	}
	if blocks[1].(map[string]any)["text"] != "answer" {
		t.Errorf("text block=%v", blocks[1])
	}
	tool := blocks[2].(map[string]any)
	if tool["name"] != "list_dir" || tool["input"].(map[string]any)["path"] != "." {
		t.Errorf("tool block=%v", tool)
	}
	// The signature travels back on the block so the next turn can replay it.
	if tool["thought_signature"] != "SIG-2" {
		t.Errorf("tool block missing thought_signature: %v", tool)
	}
	if usage.FreshInputTokens() != 40 || usage.CacheReadTokens() != 60 || usage.CompletionTokens != 12 {
		t.Errorf("usage fresh=%d cached=%d completion=%d want 40/60/12",
			usage.FreshInputTokens(), usage.CacheReadTokens(), usage.CompletionTokens)
	}
}
