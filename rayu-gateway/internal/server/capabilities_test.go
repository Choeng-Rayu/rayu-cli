package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// --- request inspection ------------------------------------------------------

func TestRequestHasImage(t *testing.T) {
	cases := map[string]struct {
		body string
		want bool
	}{
		"plain string content": {`{"messages":[{"role":"user","content":"hi"}]}`, false},
		"text block only":      {`{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`, false},
		"image block": {
			`{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBO"}}]}]}`,
			true,
		},
		"image after text": {
			`{"messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{}}]}]}`,
			true,
		},
		"image nested in tool_result": {
			`{"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"image","source":{}}]}]}]}`,
			true,
		},
		"no messages":  {`{"model":"x"}`, false},
		"empty object": {`{}`, false},
	}
	for name, c := range cases {
		var req map[string]any
		if err := json.Unmarshal([]byte(c.body), &req); err != nil {
			t.Fatalf("%s: bad fixture: %v", name, err)
		}
		if got := requestHasImage(req); got != c.want {
			t.Errorf("%s: requestHasImage=%v want %v", name, got, c.want)
		}
	}
}

func TestRequestWantsThinking(t *testing.T) {
	cases := map[string]struct {
		body string
		want bool
	}{
		"absent":            {`{"model":"x"}`, false},
		"explicitly off":    {`{"thinking":{"type":"disabled"}}`, false},
		"enabled":           {`{"thinking":{"type":"enabled","budget_tokens":2048}}`, true},
		"object no type":    {`{"thinking":{"budget_tokens":2048}}`, true},
		"non-object is off": {`{"thinking":true}`, false},
	}
	for name, c := range cases {
		var req map[string]any
		if err := json.Unmarshal([]byte(c.body), &req); err != nil {
			t.Fatalf("%s: bad fixture: %v", name, err)
		}
		if got := requestWantsThinking(req); got != c.want {
			t.Errorf("%s: requestWantsThinking=%v want %v", name, got, c.want)
		}
	}
}

// --- enforcement on the hosted path -----------------------------------------

// capabilityHarness builds a hosted model with the given capability flags,
// pointed at an upstream that MUST NOT be called.
func capabilityHarness(t *testing.T, userID int64, reasoning, image bool) (http.Handler, *credits.Limiter) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must NOT be called when the model lacks the capability")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)

	m := hostedModel("deepseek-v4-pro", deepseekProvider(upstream.URL), "deepseek-v4-pro", 1)
	m.SupportsReasoning = reasoning
	m.SupportsImage = image

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: userID, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{m},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, lim := chatHarness(t, fe)
	return h, lim
}

func TestImageOnNonImageModelRejectedBeforeBilling(t *testing.T) {
	h, lim := capabilityHarness(t, 101, true, false)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(
		`{"model":"deepseek-v4-pro","max_tokens":16,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBO"}}]}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 101))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400 (client-fixable, must not be retried)", rec.Code)
	}
	var body struct {
		Type  string `json:"type"`
		Error struct {
			Type     string `json:"type"`
			Message  string `json:"message"`
			RayuCode string `json:"rayu_code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, rec.Body.String())
	}
	// Anthropic-native envelope so the CLI's Anthropic client surfaces it.
	if body.Type != "error" || body.Error.Type != "invalid_request_error" {
		t.Errorf("envelope=%+v, want Anthropic error shape", body)
	}
	// Stable machine code — what the CLI matches on to warn + offer a switch.
	if body.Error.RayuCode != httpx.CodeNoImageSupport {
		t.Errorf("rayu_code=%q want %q", body.Error.RayuCode, httpx.CodeNoImageSupport)
	}
	if !strings.Contains(body.Error.Message, "deepseek-v4-pro") ||
		!strings.Contains(strings.ToLower(body.Error.Message), "image") {
		t.Errorf("message should name the model and the limitation, got %q", body.Error.Message)
	}
	st, err := lim.Status(context.Background(), 101)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d want 0 (a capability rejection must not charge credits)", st.UsedPeriod)
	}
	// The daily-turn counter must also be untouched: reserving against a cap of 1
	// still succeeds, which is only possible if the rejected request burned none.
	tr, err := lim.ReserveTurn(context.Background(), 101, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !tr.OK {
		t.Fatal("daily turn was consumed by a capability rejection")
	}
}

func TestThinkingOnNonReasoningModelRejectedBeforeBilling(t *testing.T) {
	h, lim := capabilityHarness(t, 102, false, true)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(
		`{"model":"deepseek-v4-pro","max_tokens":16,"thinking":{"type":"enabled","budget_tokens":1024},"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 102))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", rec.Code)
	}
	var body struct {
		Error struct {
			Message  string `json:"message"`
			RayuCode string `json:"rayu_code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error.RayuCode != httpx.CodeNoThinkingSupport {
		t.Errorf("rayu_code=%q want %q", body.Error.RayuCode, httpx.CodeNoThinkingSupport)
	}
	if !strings.Contains(strings.ToLower(body.Error.Message), "thinking") {
		t.Errorf("message should mention thinking, got %q", body.Error.Message)
	}
	st, err := lim.Status(context.Background(), 102)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d want 0 (a capability rejection must not charge credits)", st.UsedPeriod)
	}
	tr, err := lim.ReserveTurn(context.Background(), 102, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !tr.OK {
		t.Fatal("daily turn was consumed by a capability rejection")
	}
}

// A capable model must be unaffected by the gate.
func TestCapableModelServesImageAndThinking(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":5}}`))
	}))
	defer upstream.Close()

	m := hostedModel("llama-4", ollamaProvider(upstream.URL), "llama4:cloud", 1)
	m.SupportsImage = true
	m.SupportsReasoning = true

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 103, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{m},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(
		`{"model":"llama-4","max_tokens":16,"thinking":{"type":"enabled"},"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"iVBO"}}]}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 103))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s — a capable model must not be gated", rec.Code, rec.Body.String())
	}
}

// Capabilities must be visible to the client, so it can warn BEFORE sending.
func TestModelsEndpointExposesCapabilities(t *testing.T) {
	noImage := hostedModel("deepseek-v4-pro", deepseekProvider("https://api.deepseek.com"), "deepseek-v4-pro", 1)
	noImage.SupportsImage = false
	noImage.SupportsReasoning = true
	noImage.AllowedPlanCodes = []string{"pro"}
	oneMillion := 1_000_000
	noImage.ContextWindow = &oneMillion
	withImage := hostedModel("llama-4", ollamaProvider("https://ollama.com"), "llama4:cloud", 1)
	withImage.SupportsImage = true
	withImage.SupportsReasoning = false
	withImage.AllowedPlanCodes = []string{"pro"}

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 104, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{noImage, withImage},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 104))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Data []struct {
			ID                string `json:"id"`
			SupportsImage     bool   `json:"supportsImage"`
			SupportsReasoning bool   `json:"supportsReasoning"`
			ContextWindow     *int   `json:"contextWindow"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	got := map[string][2]bool{}
	for _, m := range out.Data {
		got[m.ID] = [2]bool{m.SupportsImage, m.SupportsReasoning}
	}
	if got["deepseek-v4-pro"] != [2]bool{false, true} {
		t.Errorf("deepseek-v4-pro capabilities=%v want image=false reasoning=true", got["deepseek-v4-pro"])
	}
	if got["llama-4"] != [2]bool{true, false} {
		t.Errorf("llama-4 capabilities=%v want image=true reasoning=false", got["llama-4"])
	}
	// The admin-set context window must reach the client (it drives compaction),
	// and an UNSET window must serialize as null rather than 0 — 0 would make a
	// client think the model has no usable context at all.
	for _, m := range out.Data {
		switch m.ID {
		case "deepseek-v4-pro":
			if m.ContextWindow == nil || *m.ContextWindow != 1_000_000 {
				t.Errorf("deepseek-v4-pro contextWindow=%v want 1000000", m.ContextWindow)
			}
		case "llama-4":
			if m.ContextWindow != nil {
				t.Errorf("llama-4 contextWindow=%v want null when unset", *m.ContextWindow)
			}
		}
	}
}
