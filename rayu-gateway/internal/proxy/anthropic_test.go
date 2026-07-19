package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

func TestAnthropicUsageToUsage(t *testing.T) {
	// Cache hit: fresh input 40 + cached 3968. Maps to miss=40, hit=3968.
	u := anthropicUsageJSON{InputTokens: 40, OutputTokens: 16, CacheReadInputTokens: 3968}.toUsage()
	if u.PromptCacheMissTokens != 40 || u.PromptCacheHitTokens != 3968 || u.CompletionTokens != 16 {
		t.Fatalf("miss/hit/out = %d/%d/%d", u.PromptCacheMissTokens, u.PromptCacheHitTokens, u.CompletionTokens)
	}
	if u.PromptTokens != 4008 || u.TotalTokens != 4024 {
		t.Fatalf("prompt=%d total=%d", u.PromptTokens, u.TotalTokens)
	}
	// The reconciliation helpers used by billing agree with the split.
	if u.CacheReadTokens() != 3968 || u.FreshInputTokens() != 40 {
		t.Fatalf("read=%d fresh=%d", u.CacheReadTokens(), u.FreshInputTokens())
	}

	// cache_creation is folded into the fresh/miss bucket (bills at input≈write rate).
	u2 := anthropicUsageJSON{InputTokens: 100, CacheCreationInputTokens: 20, OutputTokens: 5}.toUsage()
	if u2.PromptCacheMissTokens != 120 || u2.PromptTokens != 120 {
		t.Fatalf("miss=%d prompt=%d", u2.PromptCacheMissTokens, u2.PromptTokens)
	}
}

func TestParseAnthropicUsageLine(t *testing.T) {
	// message_start carries input + cache_read (+ initial output).
	u, hasIn, hasOut := parseAnthropicUsageLine([]byte(`data: {"type":"message_start","message":{"usage":{"input_tokens":40,"cache_read_input_tokens":3968,"output_tokens":1}}}`))
	if !hasIn || !hasOut || u.InputTokens != 40 || u.CacheReadInputTokens != 3968 {
		t.Fatalf("message_start: hasIn=%v hasOut=%v u=%+v", hasIn, hasOut, u)
	}
	// message_delta carries the final cumulative output only.
	u, hasIn, hasOut = parseAnthropicUsageLine([]byte(`data: {"type":"message_delta","usage":{"output_tokens":128}}`))
	if hasIn || !hasOut || u.OutputTokens != 128 {
		t.Fatalf("message_delta: hasIn=%v hasOut=%v u=%+v", hasIn, hasOut, u)
	}
	// non-usage / non-data lines are ignored.
	if _, hi, ho := parseAnthropicUsageLine([]byte(`event: ping`)); hi || ho {
		t.Fatal("event line should not parse")
	}
	if _, hi, ho := parseAnthropicUsageLine([]byte(`data: {"type":"content_block_delta"}`)); hi || ho {
		t.Fatal("content_block_delta should not parse usage")
	}
}

func TestCompleteAnthropicAuthSchemes(t *testing.T) {
	newUpstream := func(gotKey, gotAuth *string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*gotKey = r.Header.Get("x-api-key")
			*gotAuth = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"type":"message","role":"assistant","usage":{"input_tokens":40,"output_tokens":16,"cache_read_input_tokens":3968,"cache_creation_input_tokens":0}}`)
		}))
	}

	// bearer=false → Anthropic-standard x-api-key (Anthropic, DeepSeek).
	t.Run("x-api-key (deepseek/anthropic)", func(t *testing.T) {
		var gotKey, gotAuth string
		srv := newUpstream(&gotKey, &gotAuth)
		defer srv.Close()
		usage, status, _, err := CompleteAnthropic(context.Background(), srv.URL, []string{"sk-test-key"}, false, []byte(`{"model":"deepseek-v4-pro","max_tokens":16}`))
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK {
			t.Fatalf("status=%d", status)
		}
		if gotKey != "sk-test-key" {
			t.Errorf("x-api-key = %q, want sk-test-key", gotKey)
		}
		if gotAuth != "" {
			t.Errorf("Authorization should be empty for x-api-key scheme, got %q", gotAuth)
		}
		if usage == nil || usage.PromptCacheHitTokens != 3968 || usage.PromptCacheMissTokens != 40 || usage.CompletionTokens != 16 {
			t.Errorf("usage=%+v", usage)
		}
	})

	// bearer=true → Authorization: Bearer (LongCat).
	t.Run("bearer (longcat)", func(t *testing.T) {
		var gotKey, gotAuth string
		srv := newUpstream(&gotKey, &gotAuth)
		defer srv.Close()
		_, status, _, err := CompleteAnthropic(context.Background(), srv.URL, []string{"lc-secret"}, true, []byte(`{"model":"LongCat-2.0","max_tokens":16}`))
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK {
			t.Fatalf("status=%d", status)
		}
		if gotAuth != "Bearer lc-secret" {
			t.Errorf("Authorization = %q, want 'Bearer lc-secret'", gotAuth)
		}
		if gotKey != "" {
			t.Errorf("x-api-key should be empty for bearer scheme, got %q", gotKey)
		}
	})
}


// TestStreamAnthropicSanitizesBodylessError covers the LongCat quirk (a bodyless
// streaming 500 whose real reason is only visible via a non-streaming re-probe):
// the re-probe still runs so the SERVER LOG shows the true cause, but the CLIENT
// is sent a clean, upstream-agnostic 502 provider_unavailable — the upstream
// reason ("out of credits") must NEVER reach the customer.
func TestStreamAnthropicSanitizesBodylessError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") == "text/event-stream" {
			// LongCat streaming quirk: bodyless 500 on error.
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		// Non-streaming re-probe returns the real reason (server-log only now).
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error","message":"Token 额度不足 (out of credits)"}}`)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	_, wrote, _ := StreamAnthropic(context.Background(), rec, upstream.URL, []string{"lc-key"}, true,
		[]byte(`{"model":"LongCat-2.0","stream":true,"messages":[{"role":"user","content":"hi"}]}`))

	if !wrote {
		t.Fatal("expected wrote=true")
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("client status=%d, want sanitized 502", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, httpx.ProviderUnavailableType) {
		t.Fatalf("client body missing provider_unavailable marker: %q", body)
	}
	if strings.Contains(body, "out of credits") || strings.Contains(body, "额度不足") {
		t.Fatalf("upstream reason leaked to client: %q", body)
	}
}

// TestStreamAnthropicDoesNotLeakSubscriptionError is the exact reported scenario:
// an Ollama-hosted model returns 403 "requires a subscription … ollama.com". The
// customer must NEVER see that upstream body — only the clean provider_unavailable
// (which the CLI renders as "try a smaller model or try again later").
func TestStreamAnthropicDoesNotLeakSubscriptionError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"type":"error","error":{"type":"permission_error","message":"this model requires a subscription, upgrade for access: https://ollama.com/upgrade"}}`)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	_, wrote, err := StreamAnthropic(context.Background(), rec, upstream.URL, []string{"k"}, true, []byte(`{"model":"kimi-k2.7","stream":true}`))
	if err == nil || !wrote {
		t.Fatalf("expected a surfaced upstream error, got wrote=%v err=%v", wrote, err)
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("client status=%d, want sanitized 502", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "ollama.com") || strings.Contains(body, "subscription") || strings.Contains(body, "permission_error") {
		t.Fatalf("upstream error leaked to client: %q", body)
	}
	if !strings.Contains(body, httpx.ProviderUnavailableType) {
		t.Fatalf("client body missing provider_unavailable marker: %q", body)
	}
}

// TestCompleteAnthropicKeyFailover proves multi-key rotation: a rate-limited
// (429) first key fails over to the second, which succeeds — and the caller
// sees the SUCCESS (200 + usage), not the 429.
func TestCompleteAnthropicKeyFailover(t *testing.T) {
	var tried []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		tried = append(tried, key)
		if key == "key1" {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"type":"message","usage":{"input_tokens":10,"output_tokens":5}}`)
	}))
	defer upstream.Close()

	usage, status, _, err := CompleteAnthropic(context.Background(), upstream.URL, []string{"key1", "key2"}, true, []byte(`{"model":"m","max_tokens":16}`))
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK {
		t.Fatalf("status=%d, want 200 (failed over from key1's 429 to key2)", status)
	}
	if len(tried) != 2 || tried[0] != "key1" || tried[1] != "key2" {
		t.Fatalf("tried=%v, want [key1 key2]", tried)
	}
	if usage == nil || usage.CompletionTokens != 5 {
		t.Fatalf("usage=%+v, want the successful key2 response", usage)
	}
}

// TestCompleteAnthropicAllKeysRateLimited: when EVERY key is rate-limited, the
// final 429 is surfaced (rotation doesn't mask a genuine exhaustion).
func TestCompleteAnthropicAllKeysRateLimited(t *testing.T) {
	var n int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error"}}`)
	}))
	defer upstream.Close()

	_, status, _, err := CompleteAnthropic(context.Background(), upstream.URL, []string{"k1", "k2"}, true, []byte(`{"model":"m","max_tokens":16}`))
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusTooManyRequests {
		t.Fatalf("status=%d, want 429 (all keys exhausted)", status)
	}
	if n != 2 {
		t.Fatalf("upstream calls=%d, want 2 (tried both keys)", n)
	}
}

// TestStreamAnthropicKeyFailover proves STREAMING failover: key1 → 429, key2 →
// 200 SSE, and the client receives the stream (never the 429), with usage
// captured from key2's response.
func TestStreamAnthropicKeyFailover(t *testing.T) {
	var tried []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		tried = append(tried, key)
		if key == "key1" {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n")
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	usage, wrote, err := StreamAnthropic(context.Background(), rec, upstream.URL, []string{"key1", "key2"}, true, []byte(`{"model":"m","stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if !wrote {
		t.Fatal("expected wrote=true")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("client status=%d, want 200 (failed over to key2)", rec.Code)
	}
	if len(tried) != 2 || tried[1] != "key2" {
		t.Fatalf("tried=%v, want failover to key2", tried)
	}
	if usage == nil || usage.CompletionTokens != 7 {
		t.Fatalf("usage=%+v, want key2's streamed usage", usage)
	}
}
