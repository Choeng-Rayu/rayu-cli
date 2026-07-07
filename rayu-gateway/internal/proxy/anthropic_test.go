package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		usage, status, _, err := CompleteAnthropic(context.Background(), srv.URL, "sk-test-key", false, []byte(`{"model":"deepseek-v4-pro","max_tokens":16}`))
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
		_, status, _, err := CompleteAnthropic(context.Background(), srv.URL, "lc-secret", true, []byte(`{"model":"LongCat-2.0","max_tokens":16}`))
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


// TestStreamAnthropicReprobesBodylessError covers the LongCat quirk: a streaming
// request that fails with an EMPTY body (out-of-credits → bodyless 500) is
// re-probed non-streaming to surface the real status + reason (402 + message).
func TestStreamAnthropicReprobesBodylessError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") == "text/event-stream" {
			// LongCat streaming quirk: bodyless 500 on error.
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		// Non-streaming re-probe returns the real reason.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error","message":"Token 额度不足 (out of credits)"}}`)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	_, wrote, _ := StreamAnthropic(context.Background(), rec, upstream.URL, "lc-key", true,
		[]byte(`{"model":"LongCat-2.0","stream":true,"messages":[{"role":"user","content":"hi"}]}`))

	if !wrote {
		t.Fatal("expected wrote=true")
	}
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("client status=%d, want 402 (recovered from the bodyless 500)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "out of credits") {
		t.Fatalf("client body should carry the real reason, got %q", rec.Body.String())
	}
}
