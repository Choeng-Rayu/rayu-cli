package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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

func TestCompleteAnthropicParsesUsageAndAuth(t *testing.T) {
	var gotKey, gotVer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		gotVer = r.Header.Get("anthropic-version")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","usage":{"input_tokens":40,"output_tokens":16,"cache_read_input_tokens":3968,"cache_creation_input_tokens":0}}`)
	}))
	defer srv.Close()

	usage, status, _, err := CompleteAnthropic(context.Background(), srv.URL, "sk-test-key", []byte(`{"model":"deepseek-v4-pro","max_tokens":16}`))
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK {
		t.Fatalf("status=%d", status)
	}
	if gotKey != "sk-test-key" {
		t.Errorf("x-api-key forwarded = %q, want sk-test-key", gotKey)
	}
	if gotVer == "" {
		t.Error("anthropic-version header not set")
	}
	if usage == nil || usage.PromptCacheHitTokens != 3968 || usage.PromptCacheMissTokens != 40 || usage.CompletionTokens != 16 {
		t.Errorf("usage=%+v", usage)
	}
}
