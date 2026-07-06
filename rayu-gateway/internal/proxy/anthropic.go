package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Anthropic Messages API forwarding for the rayu-hosted path. DeepSeek exposes
// an Anthropic-compatible endpoint (https://api.deepseek.com/anthropic) that
// speaks the native Anthropic wire format AND reports cache usage natively as
// `cache_read_input_tokens` — so the CLI (which is Anthropic-native) talks to it
// with no OpenAI translation, and the gateway meters straight off the Anthropic
// usage. Auth is `x-api-key` (the docs mark it Fully Supported).

// newAnthropicReq builds an upstream request authenticated the Anthropic way.
func newAnthropicReq(ctx context.Context, url, apiKey string, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	return req, nil
}

// anthropicUsageJSON is the Anthropic `usage` object. input_tokens is the FRESH
// (uncached) input; cache_read/creation are separate — the same convention the
// CLI already uses. (DeepSeek reports cache_creation_input_tokens = 0 today.)
type anthropicUsageJSON struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
}

// toUsage maps the Anthropic usage buckets onto the internal Usage billing
// struct so the existing cache-aware credit path (actualCredits → ForUsage)
// prices them correctly: fresh input → cache-miss bucket (full input rate),
// cache_read → cache-hit bucket (discounted). cache_creation is folded into the
// miss bucket — it bills at the input rate, which equals the default cache-write
// rate, and DeepSeek reports it as 0 regardless.
func (a anthropicUsageJSON) toUsage() *Usage {
	prompt := a.InputTokens + a.CacheReadInputTokens + a.CacheCreationInputTokens
	return &Usage{
		PromptTokens:          prompt,
		CompletionTokens:      a.OutputTokens,
		TotalTokens:           prompt + a.OutputTokens,
		PromptCacheHitTokens:  a.CacheReadInputTokens,
		PromptCacheMissTokens: a.InputTokens + a.CacheCreationInputTokens,
	}
}

// parseAnthropicUsageLine extracts usage from one SSE `data:` line. Anthropic
// splits usage across events: `message_start` carries input + cache_read +
// cache_creation (and an initial output_tokens), while `message_delta` carries
// the final cumulative output_tokens. Returns which fields it found.
func parseAnthropicUsageLine(line []byte) (u anthropicUsageJSON, hasInput, hasOutput bool) {
	s := bytes.TrimSpace(line)
	if !bytes.HasPrefix(s, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(s[len("data:"):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return
	}
	var ev struct {
		Type    string `json:"type"`
		Message *struct {
			Usage *anthropicUsageJSON `json:"usage"`
		} `json:"message"`
		Usage *anthropicUsageJSON `json:"usage"`
	}
	if json.Unmarshal(payload, &ev) != nil {
		return
	}
	switch ev.Type {
	case "message_start":
		if ev.Message != nil && ev.Message.Usage != nil {
			return *ev.Message.Usage, true, true
		}
	case "message_delta":
		if ev.Usage != nil {
			return *ev.Usage, false, true
		}
	}
	return
}

// StreamAnthropic proxies a streaming Anthropic Messages completion, relaying the
// SSE bytes verbatim while capturing usage for billing. Mirrors Stream but for
// the Anthropic wire format + x-api-key auth.
func StreamAnthropic(ctx context.Context, w http.ResponseWriter, upstreamURL, apiKey string, body []byte) (usage *Usage, wrote bool, err error) {
	resp, err := doWithRetry(ctx, func() (*http.Request, error) {
		req, err := newAnthropicReq(ctx, upstreamURL, apiKey, body)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "text/event-stream")
		return req, nil
	})
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()

	flusher, _ := w.(http.Flusher)
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(b)
		return nil, true, fmt.Errorf("upstream status %d: %s", resp.StatusCode, errSnippet(b))
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}

	var acc anthropicUsageJSON
	seen := false
	reader := bufio.NewReader(resp.Body)
	for {
		line, rerr := reader.ReadBytes('\n')
		if len(line) > 0 {
			if _, werr := w.Write(line); werr != nil {
				if seen {
					usage = acc.toUsage()
				}
				return usage, true, werr // client disconnected
			}
			if flusher != nil {
				flusher.Flush()
			}
			if u, hasIn, hasOut := parseAnthropicUsageLine(line); hasIn || hasOut {
				seen = true
				if hasIn {
					acc.InputTokens = u.InputTokens
					acc.CacheReadInputTokens = u.CacheReadInputTokens
					acc.CacheCreationInputTokens = u.CacheCreationInputTokens
				}
				if hasOut {
					acc.OutputTokens = u.OutputTokens // cumulative; latest wins
				}
			}
		}
		if rerr != nil {
			break
		}
	}
	if seen {
		usage = acc.toUsage()
	}
	return usage, true, nil
}

// CompleteAnthropic proxies a non-streaming Anthropic Messages completion,
// returning the upstream status, raw body, and parsed usage for the caller.
func CompleteAnthropic(ctx context.Context, upstreamURL, apiKey string, body []byte) (usage *Usage, status int, respBody []byte, err error) {
	resp, err := doWithRetry(ctx, func() (*http.Request, error) {
		return newAnthropicReq(ctx, upstreamURL, apiKey, body)
	})
	if err != nil {
		return nil, 0, nil, err
	}
	defer resp.Body.Close()
	respBody, _ = io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusOK {
		var parsed struct {
			Usage *anthropicUsageJSON `json:"usage"`
		}
		if json.Unmarshal(respBody, &parsed) == nil && parsed.Usage != nil {
			usage = parsed.Usage.toUsage()
		}
	}
	return usage, resp.StatusCode, respBody, nil
}
