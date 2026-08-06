package proxy

import (
	"encoding/json"
	"testing"
)

// ParseOpenAIUsageLine is what the openai_chat adapter meters off, so both cache
// conventions and the "no usage here" cases must be handled per line.
func TestParseOpenAIUsageLine(t *testing.T) {
	cases := map[string]struct {
		line   string
		want   bool // expect usage
		prompt int
		cached int
	}{
		"deepseek convention": {
			`data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}`,
			true, 100, 80,
		},
		"openai convention": {
			`data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":60}}}`,
			true, 100, 60,
		},
		"no cache reported": {
			`data: {"usage":{"prompt_tokens":7,"completion_tokens":1,"total_tokens":8}}`,
			true, 7, 0,
		},
		"content delta only": {`data: {"choices":[{"delta":{"content":"hi"}}]}`, false, 0, 0},
		"done sentinel":      {`data: [DONE]`, false, 0, 0},
		"not a data line":    {`event: message`, false, 0, 0},
		"malformed json":     {`data: {`, false, 0, 0},
		"zero total usage":   {`data: {"usage":{"prompt_tokens":0,"total_tokens":0}}`, false, 0, 0},
	}
	for name, c := range cases {
		got := ParseOpenAIUsageLine([]byte(c.line))
		if c.want != (got != nil) {
			t.Errorf("%s: usage present=%v want %v", name, got != nil, c.want)
			continue
		}
		if got == nil {
			continue
		}
		if got.PromptTokens != c.prompt {
			t.Errorf("%s: prompt=%d want %d", name, got.PromptTokens, c.prompt)
		}
		if got.CacheReadTokens() != c.cached {
			t.Errorf("%s: cacheRead=%d want %d", name, got.CacheReadTokens(), c.cached)
		}
	}
}

func TestUsageCacheSplit(t *testing.T) {
	cases := []struct {
		name          string
		u             Usage
		wantRead      int
		wantFresh     int
		reconcilesTo  int // fresh+read should equal this (the provider's prompt total)
		checkReconcil bool
	}{
		{
			name:          "DeepSeek native hit/miss",
			u:             Usage{PromptTokens: 2000, PromptCacheHitTokens: 1536, PromptCacheMissTokens: 464},
			wantRead:      1536,
			wantFresh:     464,
			reconcilesTo:  2000,
			checkReconcil: true,
		},
		{
			name:          "OpenAI-style prompt_tokens_details.cached_tokens",
			u:             Usage{PromptTokens: 2000, PromptTokensDetails: PromptTokensDetails{CachedTokens: 1500}},
			wantRead:      1500,
			wantFresh:     500,
			reconcilesTo:  2000,
			checkReconcil: true,
		},
		{
			name:      "no cache reported → full prompt is fresh",
			u:         Usage{PromptTokens: 800},
			wantRead:  0,
			wantFresh: 800,
		},
		{
			name:      "all cached (hit present, miss absent) → fresh 0",
			u:         Usage{PromptTokens: 1000, PromptCacheHitTokens: 1000},
			wantRead:  1000,
			wantFresh: 0,
		},
		{
			name:      "native fields win over details",
			u:         Usage{PromptTokens: 3000, PromptCacheHitTokens: 2000, PromptCacheMissTokens: 1000, PromptTokensDetails: PromptTokensDetails{CachedTokens: 999}},
			wantRead:  2000,
			wantFresh: 1000,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.u.CacheReadTokens(); got != c.wantRead {
				t.Errorf("CacheReadTokens()=%d want %d", got, c.wantRead)
			}
			if got := c.u.FreshInputTokens(); got != c.wantFresh {
				t.Errorf("FreshInputTokens()=%d want %d", got, c.wantFresh)
			}
			if c.checkReconcil {
				if sum := c.u.FreshInputTokens() + c.u.CacheReadTokens(); sum != c.reconcilesTo {
					t.Errorf("fresh+read=%d want %d (must equal prompt_tokens)", sum, c.reconcilesTo)
				}
			}
		})
	}
}

func TestUsageJSONParsesBothCacheConventions(t *testing.T) {
	// DeepSeek native shape.
	var ds Usage
	if err := json.Unmarshal([]byte(`{"prompt_tokens":2000,"completion_tokens":100,"total_tokens":2100,"prompt_cache_hit_tokens":1536,"prompt_cache_miss_tokens":464}`), &ds); err != nil {
		t.Fatal(err)
	}
	if ds.CacheReadTokens() != 1536 || ds.FreshInputTokens() != 464 {
		t.Errorf("deepseek: read=%d fresh=%d", ds.CacheReadTokens(), ds.FreshInputTokens())
	}

	// OpenAI-style shape (cached_tokens nested in prompt_tokens_details).
	var oa Usage
	if err := json.Unmarshal([]byte(`{"prompt_tokens":2000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":1500}}`), &oa); err != nil {
		t.Fatal(err)
	}
	if oa.CacheReadTokens() != 1500 || oa.FreshInputTokens() != 500 {
		t.Errorf("openai: read=%d fresh=%d", oa.CacheReadTokens(), oa.FreshInputTokens())
	}
}
