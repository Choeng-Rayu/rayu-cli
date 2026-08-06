package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// TestProviderRouteEndpoint is the successor to the old anthropicUpstream()
// helper test: the upstream URL now comes from the provider REGISTRY row
// (baseUrl + endpointPath) instead of being derived in gateway code, so the same
// routing cases are asserted through providercfg.Route.
func TestProviderRouteEndpoint(t *testing.T) {
	cases := []struct{ base, path, want string }{
		// DeepSeek / LongCat / first-party: {origin}/anthropic/v1/messages
		{"https://api.deepseek.com", "/anthropic/v1/messages", "https://api.deepseek.com/anthropic/v1/messages"},
		{"https://api.deepseek.com/", "/anthropic/v1/messages", "https://api.deepseek.com/anthropic/v1/messages"},
		{"https://gw.example.test:8443", "/anthropic/v1/messages", "https://gw.example.test:8443/anthropic/v1/messages"},
		// Ollama Cloud: {origin}/v1/messages (no /anthropic segment)
		{"https://ollama.com", "/v1/messages", "https://ollama.com/v1/messages"},
		{"https://ollama.com/", "/v1/messages", "https://ollama.com/v1/messages"},
		// Blank path falls back to the format default.
		{"https://api.deepseek.com", "", "https://api.deepseek.com/anthropic/v1/messages"},
	}
	for _, c := range cases {
		r := providercfg.Route{
			Format:       providercfg.FormatAnthropicMessages,
			BaseURL:      c.base,
			EndpointPath: c.path,
		}
		if got := r.Endpoint(); got != c.want {
			t.Errorf("Endpoint(base=%q path=%q)=%q want %q", c.base, c.path, got, c.want)
		}
	}
}

// TestHandleAnthropicMessagesCacheAwareBilling is the token-count correctness
// proof for the rayu-hosted Anthropic path: a cache-heavy response (mostly
// cache_read_input_tokens, as every agentic follow-up turn is) must bill at the
// cache-read discount, not full input price — end to end through the real
// /anthropic/v1/messages endpoint, and it must forward to DeepSeek's Anthropic
// path with x-api-key auth.
func TestHandleAnthropicMessagesCacheAwareBilling(t *testing.T) {
	var gotPath, gotKey, gotVer string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-api-key")
		gotVer = r.Header.Get("anthropic-version")
		w.Header().Set("Content-Type", "application/json")
		// 10,000,000 tokens, ALL cache-read (0 fresh, 0 output) — the "24M" case.
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":10000000,"cache_creation_input_tokens":0}}`)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 51, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("deepseek-v4-pro", deepseekProvider(upstream.URL), "deepseek-v4-pro", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 10},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"deepseek-v4-pro","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 51))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/anthropic/v1/messages" {
		t.Errorf("upstream path=%q want /anthropic/v1/messages", gotPath)
	}
	if gotKey != "sk-test" {
		t.Errorf("upstream x-api-key=%q want sk-test", gotKey)
	}
	if gotVer == "" {
		t.Error("upstream anthropic-version header not set")
	}
	st, err := lim.Status(context.Background(), 51)
	if err != nil {
		t.Fatalf("lim.Status: %v", err)
	}
	// 10,000,000 all-cache-read tokens × 0.10 = 1,000,000 billable tokens
	// (≈10 credits at baseline 10). Full-price (no cache) would be 10,000,000.
	if st.UsedPeriod != 1_000_000 {
		t.Fatalf("usedPeriod=%d billable tokens, want 1_000_000 (cache-discounted)", st.UsedPeriod)
	}
}

// TestHandleAnthropicMessagesStreaming exercises the primary (streaming) path:
// the SSE is relayed verbatim to the client AND usage is metered from the
// Anthropic message_start (input + cache_read) + message_delta (final output).
func TestHandleAnthropicMessagesStreaming(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "event: message_start\n"+
			`data: {"type":"message_start","message":{"usage":{"input_tokens":100000,"cache_read_input_tokens":9000000,"output_tokens":1}}}`+"\n\n")
		_, _ = io.WriteString(w, "event: content_block_delta\n"+
			`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}`+"\n\n")
		_, _ = io.WriteString(w, "event: message_delta\n"+
			`data: {"type":"message_delta","usage":{"output_tokens":1000}}`+"\n\n")
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 52, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("deepseek-v4-pro", deepseekProvider(upstream.URL), "deepseek-v4-pro", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 10},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"deepseek-v4-pro","stream":true,"max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 52))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	// Relayed verbatim (client SDK parses this exact stream natively).
	body := rec.Body.String()
	if !strings.Contains(body, "message_start") || !strings.Contains(body, "text_delta") || !strings.Contains(body, "message_delta") {
		t.Fatalf("stream not relayed verbatim: %q", body)
	}
	st, err := lim.Status(context.Background(), 52)
	if err != nil {
		t.Fatalf("lim.Status: %v", err)
	}
	// fresh 100,000×1 + cache_read 9,000,000×0.10 + output 1,000×1 = 1,001,000
	// billable tokens (≈11 credits at baseline 10). Full price ≈ 9,101,000 billable.
	if st.UsedPeriod != 1_001_000 {
		t.Fatalf("usedPeriod=%d billable tokens, want 1_001_000 (cache-discounted streamed usage)", st.UsedPeriod)
	}
}

// TestHandleAnthropicMessagesLongCatBearerAuth verifies the LongCat provider is
// forwarded to its Anthropic endpoint with `Authorization: Bearer <key>` (NOT
// x-api-key), that the gateway swaps in its own provider key (not the caller's
// JWT), and that usage is metered.
func TestHandleAnthropicMessagesLongCatBearerAuth(t *testing.T) {
	var gotAuth, gotKey, gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotKey = r.Header.Get("x-api-key")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":200}}`)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 61, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("longcat-2", longcatProvider(upstream.URL), "LongCat-2.0", 0.5),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 10},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"longcat-2","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 61))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/anthropic/v1/messages" {
		t.Errorf("upstream path=%q want /anthropic/v1/messages", gotPath)
	}
	// LongCat auth is Bearer with the gateway's own provider key — never the
	// caller's Rayu JWT, and never x-api-key.
	if gotAuth != "Bearer sk-longcat" {
		t.Errorf("upstream Authorization=%q want 'Bearer sk-longcat'", gotAuth)
	}
	if gotKey != "" {
		t.Errorf("x-api-key must be empty for LongCat (Bearer scheme), got %q", gotKey)
	}
}

// TestHandleAnthropicMessagesOllamaCloudRouting proves the rayu-ollama
// provider: (1) forwards to Ollama's Anthropic endpoint at {host}/v1/messages
// (NO /anthropic segment, unlike DeepSeek/LongCat), (2) authenticates with
// `Authorization: Bearer <gateway key>` (never the caller JWT, never x-api-key),
// and (3) bills FLAT at the model's creditMultiplier credits per 1M tokens —
// input and output alike (Ollama does no prompt caching). 1,000,000 tokens at
// multiplier 2.5 = 2,500,000 billable tokens = 2.5 credits (baseline 1), i.e.
// the "GLM 1M tokens = 2.5 credits" spec.
func TestHandleAnthropicMessagesOllamaCloudRouting(t *testing.T) {
	var gotAuth, gotKey, gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotKey = r.Header.Get("x-api-key")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		// 800k input + 200k output = 1,000,000 tokens; Ollama reports no cache.
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":800000,"output_tokens":200000}}`)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 62, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("glm-5.2", ollamaProvider(upstream.URL), "glm-5.2:cloud", 2.5),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1}, // 1 credit = 1,000,000 tokens
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"glm-5.2","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 62))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/v1/messages" {
		t.Errorf("upstream path=%q want /v1/messages (Ollama has no /anthropic segment)", gotPath)
	}
	if gotAuth != "Bearer sk-ollama" {
		t.Errorf("upstream Authorization=%q want 'Bearer sk-ollama'", gotAuth)
	}
	if gotKey != "" {
		t.Errorf("x-api-key must be empty for Ollama (Bearer scheme), got %q", gotKey)
	}
	st, err := lim.Status(context.Background(), 62)
	if err != nil {
		t.Fatal(err)
	}
	// FLAT billing: (800,000 + 200,000) × 2.5 = 2,500,000 billable tokens = 2.5
	// credits at baseline 1. Output bills at the same rate as input.
	if st.UsedPeriod != 2_500_000 {
		t.Fatalf("usedPeriod=%d billable tokens, want 2_500_000 (1M tokens × 2.5)", st.UsedPeriod)
	}
}

// TestHandleAnthropicMessagesTinyTurnCostsLittle is the regression test for the
// reported "a 'hi' burned a whole credit / showed millions of tokens" bug: a
// trivial turn must cost only its true handful of BILLABLE TOKENS, not round up
// to a full 1M-token credit. Uses baseline=1 (1 credit = 1,000,000 tokens), the
// reported setup — where the old ceil-to-whole-credit charged 1,000,000 for a "hi".
func TestHandleAnthropicMessagesTinyTurnCostsLittle(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":20,"output_tokens":8}}`)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 71, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("deepseek-v4-flash", deepseekProvider(upstream.URL), "deepseek-v4-flash", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1}, // 1 credit = 1,000,000 tokens
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"deepseek-v4-flash","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 71))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	st, err := lim.Status(context.Background(), 71)
	if err != nil {
		t.Fatal(err)
	}
	// input 20 ×1 + output 8 ×1 = 28 billable tokens (≈0.000028 credit). The
	// pre-fix whole-credit ceil charged 1 credit = 1,000,000 tokens for this "hi".
	if st.UsedPeriod != 28 {
		t.Fatalf("usedPeriod=%d billable tokens, want 28 (a 'hi' must NOT cost a whole 1M-token credit)", st.UsedPeriod)
	}
}

// TestHostedRequestRotatesPastARateLimitedKey is the whole point of per-key
// rotation, asserted through the REAL request path: a provider with three keys
// whose first key is rate-limited still answers 200 on the SAME request (the
// client never sees the 429), the rate-limited key is put on cooldown, and the
// NEXT request skips it entirely.
func TestHostedRequestRotatesPastARateLimitedKey(t *testing.T) {
	var mu sync.Mutex
	var tried []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		mu.Lock()
		tried = append(tried, key)
		mu.Unlock()
		if key == "k1" {
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_1","content":[{"type":"text","text":"ok"}],`+
			`"usage":{"input_tokens":10,"output_tokens":5}}`)
	}))
	defer upstream.Close()

	prov := longcatProvider(upstream.URL)
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 94, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("longcat-2", prov, "LongCat-2.0", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{
			provIDLongCat: {
				{ID: 11, Secret: "k1", Masked: "k1***", Priority: 0, Enabled: true, Status: providerkeys.StatusActive},
				{ID: 12, Secret: "k2", Masked: "k2***", Priority: 1, Enabled: true, Status: providerkeys.StatusActive},
				{ID: 13, Secret: "k3", Masked: "k3***", Priority: 2, Enabled: true, Status: providerkeys.StatusActive},
			},
		},
	}
	h, _ := chatHarness(t, fe)

	send := func() int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
			strings.NewReader(`{"model":"longcat-2","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
		req.Header.Set("Authorization", "Bearer "+accessToken(t, 94))
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := send(); code != http.StatusOK {
		t.Fatalf("status=%d, want 200 — failover must be invisible to the client", code)
	}
	mu.Lock()
	first := append([]string(nil), tried...)
	mu.Unlock()
	if len(first) != 2 || first[0] != "k1" || first[1] != "k2" {
		t.Fatalf("keys tried = %v, want [k1 k2] (rate-limited key then the next by priority)", first)
	}

	// The 429 must have been attributed to k1 and only k1.
	snap := fe.Keys().SnapshotFor(provIDLongCat)
	byID := map[int64]providerkeys.Snapshot{}
	for _, k := range snap {
		byID[k.ID] = k
	}
	if got := byID[11].Status; got != providerkeys.StatusRateLimited {
		t.Errorf("key 11 status=%s, want %s", got, providerkeys.StatusRateLimited)
	}
	if byID[11].CooldownUntil.IsZero() {
		t.Error("key 11 has no cooldown deadline; the provider's Retry-After was ignored")
	}
	if got := byID[12].Status; got != providerkeys.StatusActive {
		t.Errorf("key 12 status=%s, want %s (it served the request)", got, providerkeys.StatusActive)
	}
	if got := fe.Keys().Usable(provIDLongCat); got != 2 {
		t.Errorf("usable keys=%d, want 2 (3 configured, 1 cooling down)", got)
	}

	// A cooling key is not retried: the second request must start at k2.
	mu.Lock()
	tried = nil
	mu.Unlock()
	if code := send(); code != http.StatusOK {
		t.Fatalf("second request status=%d, want 200", code)
	}
	mu.Lock()
	second := append([]string(nil), tried...)
	mu.Unlock()
	if len(second) != 1 || second[0] != "k2" {
		t.Fatalf("second request tried %v, want [k2] — a cooling key must be skipped, not retried", second)
	}
}

// TestHostedRequestUnavailableWhenEveryKeyIsUnusable: a provider WITH keys where
// none can serve (all invalid) is a temporary-unavailable condition, not a
// misconfiguration, and must cost the user nothing.
func TestHostedRequestUnavailableWhenEveryKeyIsUnusable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must NOT be called when no key is usable")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 95, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("longcat-2", longcatProvider(upstream.URL), "LongCat-2.0", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{
			provIDLongCat: {
				{ID: 21, Secret: "dead1", Masked: "de***", Enabled: true, Status: providerkeys.StatusInvalid},
				{ID: 22, Secret: "dead2", Masked: "de***", Enabled: false, Status: providerkeys.StatusActive},
			},
		},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"longcat-2","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 95))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503 (keys configured but none usable)", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After on a 503: the client cannot tell this is temporary")
	}
	if body := rec.Body.String(); strings.Contains(body, "dead1") || strings.Contains(body, "dead2") {
		t.Errorf("response leaks a provider key: %s", body)
	}
	st, err := lim.Status(context.Background(), 95)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d, want 0 (an unavailable provider must never charge credits)", st.UsedPeriod)
	}
}

// TestHandleAnthropicMessagesDisabledProviderRejected proves the admin kill
// switch (providers.enabled = false, which replaced RAYU_DISABLED_PROVIDERS): a
// disabled provider's model is refused with 503 BEFORE any upstream call, credit
// charge, or daily-turn burn.
func TestHandleAnthropicMessagesDisabledProviderRejected(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must NOT be called for a disabled provider")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 91, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("longcat-2", longcatProvider(upstream.URL), "LongCat-2.0", 0.5),
			},
		},
		settings:          store.AppSettings{BaselineCreditsPer1M: 1},
		disabledProviders: map[string]bool{"longcat": true}, // admin kill switch
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"longcat-2","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 91))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503 (provider disabled)", rec.Code)
	}
	st, err := lim.Status(context.Background(), 91)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d, want 0 (a disabled provider must never charge credits)", st.UsedPeriod)
	}
}

// TestHandleAnthropicMessagesMissingProviderKeyRejected proves a provider with NO
// API key rows is refused before any credit is charged — the operator-facing
// failure mode when a provider was added in the dashboard but no key was entered.
func TestHandleAnthropicMessagesMissingProviderKeyRejected(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must NOT be called when the provider key is missing")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 92, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("longcat-2", longcatProvider(upstream.URL), "LongCat-2.0", 0.5),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
		// No key rows for this provider at all.
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: {}},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"longcat-2","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 92))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500 (provider key not configured)", rec.Code)
	}
	// The response must not disclose provider internals.
	if body := rec.Body.String(); strings.Contains(body, "longcat") || strings.Contains(body, upstream.URL) {
		t.Errorf("response leaks provider config: %s", body)
	}
	st, err := lim.Status(context.Background(), 92)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d, want 0 (a keyless provider must never charge credits)", st.UsedPeriod)
	}
}

// TestHandleAnthropicMessagesUnsafeProviderRowRejected proves a provider ROW that
// fails validation is refused at request time — not just at the admin API. This
// is the defence against a row written directly to the database pointing the
// gateway (with a real provider key attached) at an internal address.
func TestHandleAnthropicMessagesUnsafeProviderRowRejected(t *testing.T) {
	for name, p := range map[string]store.Provider{
		"cloud metadata address": func() store.Provider {
			p := deepseekProvider("https://169.254.169.254")
			return p
		}(),
		"endpoint path escaping the origin": func() store.Provider {
			p := deepseekProvider("https://api.deepseek.com")
			p.EndpointPath = "https://evil.example.com/v1/messages"
			return p
		}(),
		"unknown wire format": func() store.Provider {
			p := deepseekProvider("https://api.deepseek.com")
			p.Format = "grpc_magic"
			return p
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			fe := &fakeEnt{
				ent: entitlements.Entitlement{
					UserID: 93, Status: "active",
					Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
					AllowedModels: []store.HostedModel{
						hostedModel("deepseek-v4-pro", p, "deepseek-v4-pro", 1),
					},
				},
				settings: store.AppSettings{BaselineCreditsPer1M: 1},
				// Resolve routes exactly as production does (no dev escape hatch),
				// which is the configuration these guards protect.
				strictRoutes: true,
			}
			h, lim := chatHarness(t, fe)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
				strings.NewReader(`{"model":"deepseek-v4-pro","max_tokens":16}`))
			req.Header.Set("Authorization", "Bearer "+accessToken(t, 93))
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status=%d, want 503 for an invalid provider row", rec.Code)
			}
			st, err := lim.Status(context.Background(), 93)
			if err != nil {
				t.Fatal(err)
			}
			if st.UsedPeriod != 0 {
				t.Fatalf("usedPeriod=%d, want 0", st.UsedPeriod)
			}
		})
	}
}

// TestHostedTokenBillingPerMultiplier proves the paid-path token count:
// credits = creditMultiplier × (tokens / 1M) at baseline 1. Flat billing (no
// per-bucket price → output rate == input rate == multiplier), matching the
// Ollama seed, so 1,000,000 tokens cost exactly `multiplier` credits.
func TestHostedTokenBillingPerMultiplier(t *testing.T) {
	cases := []struct {
		code string
		mult float64
		want int64 // billable tokens for 1,000,000 total (credits = want / 1e6)
	}{
		{"deepseek-v4-pro", 1.0, 1_000_000},  // 1 credit / 1M
		{"glm-5.2", 2.5, 2_500_000},          // 2.5 credits / 1M
		{"gpt-oss-120b", 0.75, 750_000},      // 0.75 credits / 1M
		{"deepseek-v4-flash", 0.33, 330_000}, // 0.33 credits / 1M
	}
	for _, c := range cases {
		t.Run(c.code, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				// 600k input + 400k output = 1,000,000 tokens (Ollama reports no cache).
				_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":600000,"output_tokens":400000}}`)
			}))
			defer upstream.Close()

			fe := &fakeEnt{
				ent: entitlements.Entitlement{
					UserID: 90, Status: "active",
					Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(1000)},
					AllowedModels: []store.HostedModel{
						hostedModel(c.code, ollamaProvider(upstream.URL), "x", c.mult),
					},
				},
				settings: store.AppSettings{BaselineCreditsPer1M: 1}, // 1 credit = 1,000,000 tokens
			}
			h, lim := chatHarness(t, fe)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
				strings.NewReader(`{"model":"`+c.code+`","max_tokens":16}`))
			req.Header.Set("Authorization", "Bearer "+accessToken(t, 90))
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			st, err := lim.Status(context.Background(), 90)
			if err != nil {
				t.Fatal(err)
			}
			if st.UsedPeriod != c.want {
				t.Fatalf("%s: usedPeriod=%d billable, want %d (mult %.2f × 1M tokens = %.2f credits)",
					c.code, st.UsedPeriod, c.want, c.mult, float64(c.want)/1e6)
			}
		})
	}
}

// TestHostedRequestDropsPriorTurnThinking is the end-to-end guard for the
// model-switch failure: a user asks Claude, switches to DeepSeek with /model,
// asks again, then switches back. The CLI replays history verbatim, so the
// DeepSeek turn's thinking block — whose signature is a plain UUID that no
// Anthropic endpoint can verify — would otherwise reach the upstream and kill
// the request with
// "messages.N.content.0: Invalid `signature` in `thinking` block".
//
// This asserts on the body the UPSTREAM receives, so it fails if the sanitiser
// is ever unwired from the adapter, not just if its logic regresses.
func TestHostedRequestDropsPriorTurnThinking(t *testing.T) {
	var forwarded map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &forwarded)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":5,"output_tokens":1}}`)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("deepseek-v4-pro", deepseekProvider(upstream.URL), "deepseek-v4-pro", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 10},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(`{
		"model":"deepseek-v4-pro","max_tokens":16,"messages":[
			{"role":"user","content":"hi"},
			{"role":"assistant","content":[
				{"type":"thinking","thinking":"from another model","signature":"4fd2c917-979d-4e69-8a37-3ce63dbd1f9b"},
				{"type":"text","text":"Hi!"}]},
			{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 77))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	msgs, ok := forwarded["messages"].([]any)
	if !ok || len(msgs) != 3 {
		t.Fatalf("upstream got %#v", forwarded["messages"])
	}
	blocks := msgs[1].(map[string]any)["content"].([]any)
	if len(blocks) != 1 || blocks[0].(map[string]any)["type"] != "text" {
		t.Fatalf("the foreign thinking block reached the upstream: %#v", blocks)
	}
}
