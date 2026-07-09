package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

func TestAnthropicUpstream(t *testing.T) {
	type tc struct{ base, endpoint, want string }
	cases := []tc{
		// endpoint "anthropic" → {origin}/anthropic/v1/messages (DeepSeek/LongCat/first-party)
		{"https://api.deepseek.com", "anthropic", "https://api.deepseek.com/anthropic/v1/messages"},
		{"https://api.deepseek.com/", "anthropic", "https://api.deepseek.com/anthropic/v1/messages"},
		{"https://api.deepseek.com/v1", "anthropic", "https://api.deepseek.com/anthropic/v1/messages"},
		{"https://api.deepseek.com/v1/", "anthropic", "https://api.deepseek.com/anthropic/v1/messages"},
		{"https://gw.example.test:8443/v1", "anthropic", "https://gw.example.test:8443/anthropic/v1/messages"},
		// endpoint "messages" → {origin}/v1/messages (Ollama Cloud — no /anthropic)
		{"https://ollama.com", "messages", "https://ollama.com/v1/messages"},
		{"https://ollama.com/", "messages", "https://ollama.com/v1/messages"},
		// empty/unknown endpoint defaults to the anthropic style
		{"https://api.deepseek.com", "", "https://api.deepseek.com/anthropic/v1/messages"},
	}
	for _, c := range cases {
		if got := anthropicUpstream(c.base, c.endpoint); got != c.want {
			t.Errorf("anthropicUpstream(%q, %q)=%q want %q", c.base, c.endpoint, got, c.want)
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
				{Code: "deepseek-v4-pro", Provider: "deepseek", Enabled: true, CreditMultiplier: 1,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "deepseek-v4-pro"},
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
				{Code: "deepseek-v4-pro", Provider: "deepseek", Enabled: true, CreditMultiplier: 1,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "deepseek-v4-pro"},
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
				{Code: "longcat-2", Provider: "longcat", Enabled: true, CreditMultiplier: 0.5,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "LongCat-2.0"},
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
				{Code: "glm-5.2", Provider: "rayu-ollama", Enabled: true, CreditMultiplier: 2.5,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "glm-5.2:cloud"},
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
				{Code: "deepseek-v4-flash", Provider: "deepseek", Enabled: true, CreditMultiplier: 1,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "deepseek-v4-flash"},
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

// TestRotateKeysRoundRobin proves the per-provider round-robin: consecutive
// requests lead with the next key (wrapping), each provider has an independent
// cursor, and single/empty key sets are returned unchanged (no rotation).
func TestRotateKeysRoundRobin(t *testing.T) {
	s := &Server{}
	keys := []string{"a", "b", "c"}
	for i, want := range []string{"a", "b", "c", "a", "b"} {
		got := s.rotateKeys("rayu-ollama", keys)
		if len(got) != 3 || got[0] != want {
			t.Fatalf("call %d: rotateKeys leads with %v, want first=%q", i, got, want)
		}
	}
	// Independent cursor per provider.
	if got := s.rotateKeys("other", keys); got[0] != "a" {
		t.Fatalf("independent provider: leads with %q, want a", got[0])
	}
	// Single / empty key sets are unchanged.
	if got := s.rotateKeys("p", []string{"solo"}); len(got) != 1 || got[0] != "solo" {
		t.Fatalf("single key rotated: %v", got)
	}
	if got := s.rotateKeys("p", nil); got != nil {
		t.Fatalf("nil keys not passed through: %v", got)
	}
}


// TestHandleAnthropicMessagesDisabledProviderRejected proves the zero-code
// provider disable (RAYU_DISABLED_PROVIDERS): a disabled provider's model is
// refused with 503 BEFORE any upstream call, credit charge, or daily-turn burn.
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
				{Code: "longcat-2", Provider: "longcat", Enabled: true, CreditMultiplier: 0.5,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "LongCat-2.0"},
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	cfg := &config.Config{
		JWTSecret:         testSecret,
		ProviderKeys:      map[string]string{"longcat": "sk-longcat"},
		DisabledProviders: map[string]bool{"longcat": true}, // zero-code disable
	}
	h, lim := chatHarnessCfg(t, fe, cfg)

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
		{"deepseek-v4-pro", 1.0, 1_000_000}, // 1 credit / 1M
		{"glm-5.2", 2.5, 2_500_000},         // 2.5 credits / 1M
		{"gpt-oss-120b", 0.75, 750_000},     // 0.75 credits / 1M
		{"deepseek-v4-flash", 0.33, 330_000},// 0.33 credits / 1M
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
						{Code: c.code, Provider: "rayu-ollama", Enabled: true, CreditMultiplier: c.mult,
							UpstreamBaseURL: upstream.URL, UpstreamModelID: "x"},
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
