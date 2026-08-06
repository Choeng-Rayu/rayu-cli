package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// These tests prove the END-TO-END promise of the provider registry: an
// admin-registered provider that speaks a NON-Anthropic wire format is served
// through the same Anthropic ingress the CLI already uses, with billing metered
// off the translated usage. The CLI sends Anthropic Messages and receives
// Anthropic SSE; only the gateway knows the upstream was OpenAI-shaped.

// openAIChatProviderRow is an admin-registered OpenAI-compatible provider.
func openAIChatProviderRow(baseURL string) store.Provider {
	return store.Provider{
		ID: provIDOpenRouter, Name: "openrouter", Label: "OpenRouter",
		Format: providercfg.FormatOpenAIChat, BaseURL: baseURL,
		EndpointPath: "/v1/chat/completions", AuthScheme: providercfg.AuthBearer,
		Enabled: true,
	}
}

func TestHostedServesOpenAIChatProviderAsAnthropicStream(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, line := range []string{
			`data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}`,
			`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			// 900k cached + 100k fresh input, 1000 output.
			`data: {"choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":1000,"total_tokens":1001000,"prompt_tokens_details":{"cached_tokens":900000}}}`,
			"data: [DONE]",
		} {
			_, _ = io.WriteString(w, line+"\n\n")
		}
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 201, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(500)},
			AllowedModels: []store.HostedModel{
				hostedModel("gpt-oss-120b", openAIChatProviderRow(upstream.URL), "openai/gpt-oss-120b", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(
		`{"model":"gpt-oss-120b","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 201))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	// Routed per the provider ROW: its path + its auth scheme + its own key.
	if gotPath != "/v1/chat/completions" {
		t.Errorf("upstream path=%q want /v1/chat/completions", gotPath)
	}
	if gotAuth != "Bearer sk-or-test" {
		t.Errorf("upstream auth=%q want the provider's own key", gotAuth)
	}
	// Model fidelity: the upstream sees the provider's model id, not the Rayu code.
	if gotBody["model"] != "openai/gpt-oss-120b" {
		t.Errorf("upstream model=%v want openai/gpt-oss-120b", gotBody["model"])
	}
	// The CLI receives ANTHROPIC events even though the upstream was OpenAI.
	body := rec.Body.String()
	for _, want := range []string{"message_start", "content_block_delta", "text_delta", "message_delta", "message_stop"} {
		if !strings.Contains(body, want) {
			t.Fatalf("translated stream missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, "finish_reason") || strings.Contains(body, "choices") {
		t.Errorf("OpenAI wire shape leaked to the client: %s", body)
	}
	// Billing: fresh 100,000 ×1 + cached 900,000 ×0.10 + output 1,000 ×1 = 191,000
	// billable tokens. Ignoring the cache split would charge 1,001,000.
	st, err := lim.Status(context.Background(), 201)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 191_000 {
		t.Fatalf("usedPeriod=%d billable tokens, want 191_000 (cache-aware across translation)", st.UsedPeriod)
	}
}

func TestHostedServesOpenAIChatProviderNonStreaming(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28}}`)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 202, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(500)},
			AllowedModels: []store.HostedModel{
				hostedModel("gpt-oss-120b", openAIChatProviderRow(upstream.URL), "openai/gpt-oss-120b", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(
		`{"model":"gpt-oss-120b","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 202))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	// The client gets an Anthropic Messages object, not an OpenAI completion.
	var out struct {
		Type    string `json:"type"`
		Role    string `json:"role"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, rec.Body.String())
	}
	if out.Type != "message" || out.Role != "assistant" || out.StopReason != "end_turn" {
		t.Errorf("envelope=%+v want an Anthropic message", out)
	}
	if len(out.Content) != 1 || out.Content[0].Type != "text" || out.Content[0].Text != "pong" {
		t.Errorf("content=%+v", out.Content)
	}
	if out.Usage.InputTokens != 20 || out.Usage.OutputTokens != 8 {
		t.Errorf("usage=%+v want 20/8", out.Usage)
	}
	st, err := lim.Status(context.Background(), 202)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 28 {
		t.Fatalf("usedPeriod=%d want 28 billable tokens", st.UsedPeriod)
	}
}
