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

// newAnthropicReq builds an upstream request authenticated per the provider's
// scheme: bearer=true → `Authorization: Bearer <key>` (LongCat); bearer=false →
// `x-api-key: <key>` (Anthropic-standard / DeepSeek).
func newAnthropicReq(ctx context.Context, url, apiKey string, bearer bool, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	} else {
		req.Header.Set("x-api-key", apiKey)
	}
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

// isRotatableStatus reports whether an upstream status means "try the next API
// key": rate-limit (429), quota exhausted (402), or auth/permission (401/403) —
// the per-key failure classes multi-key rotation is meant to route around.
func isRotatableStatus(status int) bool {
	switch status {
	case http.StatusTooManyRequests, // 429 — rate limit
		http.StatusPaymentRequired, // 402 — quota exhausted
		http.StatusUnauthorized,    // 401 — invalid/expired key
		http.StatusForbidden:       // 403 — permission / quota
		return true
	}
	return false
}

// StreamAnthropic proxies a streaming Anthropic Messages completion, relaying the
// SSE bytes verbatim while capturing usage for billing. Mirrors Stream but for
// the Anthropic wire format + x-api-key/Bearer auth.
//
// apiKeys may hold MULTIPLE keys (e.g. a comma-separated OLLAMA_API_KEY): they
// are tried IN ORDER and, if a key returns a rotatable status (rate-limit/quota/
// auth), the gateway fails over to the next key — all before any bytes are
// written to the client, so failover is invisible. The final response (a success
// or the last key's error) is what gets relayed.
func StreamAnthropic(ctx context.Context, w http.ResponseWriter, upstreamURL string, apiKeys []string, bearer bool, body []byte) (usage *Usage, wrote bool, err error) {
	if len(apiKeys) == 0 {
		apiKeys = []string{""}
	}
	var resp *http.Response
	var usedKey string
	var lastErr error
	for i, apiKey := range apiKeys {
		r, e := doWithRetry(ctx, func() (*http.Request, error) {
			req, err := newAnthropicReq(ctx, upstreamURL, apiKey, bearer, body)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Accept", "text/event-stream")
			return req, nil
		})
		if e != nil {
			lastErr = e
			if i < len(apiKeys)-1 {
				continue // network error — try the next key
			}
			return nil, false, e
		}
		// Rate-limited / quota / auth failure AND another key remains → close and
		// fail over to it. Nothing has been written to the client yet.
		if isRotatableStatus(r.StatusCode) && i < len(apiKeys)-1 {
			_ = r.Body.Close()
			continue
		}
		resp, usedKey = r, apiKey
		break
	}
	if resp == nil {
		if lastErr == nil {
			lastErr = fmt.Errorf("no api keys configured")
		}
		return nil, false, lastErr
	}
	defer resp.Body.Close()

	flusher, _ := w.(http.Flusher)
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		status := resp.StatusCode
		// Some providers (e.g. LongCat) return a BODYLESS error on the streaming
		// endpoint for conditions the non-streaming endpoint reports properly
		// (out-of-credits → an empty HTTP 500 when streaming, but a clean HTTP
		// 402 + message non-streaming). Re-probe in non-streaming mode to recover
		// the real status + reason so the client sees "402 out of credits" instead
		// of an opaque empty 500. Best-effort; keeps the original on any failure.
		if len(bytes.TrimSpace(b)) == 0 {
			if pb, ps := probeNonStreamError(ctx, upstreamURL, usedKey, bearer, body); len(pb) > 0 {
				b, status = pb, ps
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(b)
		return nil, true, fmt.Errorf("upstream status %d: %s", status, errSnippet(b))
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
//
// apiKeys may hold MULTIPLE keys: they are tried in order, failing over to the
// next on a rotatable status (rate-limit/quota/auth). The returned status/body
// is the final response (a success, or the last key's error).
func CompleteAnthropic(ctx context.Context, upstreamURL string, apiKeys []string, bearer bool, body []byte) (usage *Usage, status int, respBody []byte, err error) {
	if len(apiKeys) == 0 {
		apiKeys = []string{""}
	}
	var lastErr error
	for i, apiKey := range apiKeys {
		resp, e := doWithRetry(ctx, func() (*http.Request, error) {
			return newAnthropicReq(ctx, upstreamURL, apiKey, bearer, body)
		})
		if e != nil {
			lastErr = e
			if i < len(apiKeys)-1 {
				continue // network error — try the next key
			}
			return nil, 0, nil, e
		}
		respBody, _ = io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		// Rate-limited / quota / auth failure AND another key remains → fail over.
		if isRotatableStatus(resp.StatusCode) && i < len(apiKeys)-1 {
			continue
		}
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
	if lastErr == nil {
		lastErr = fmt.Errorf("no api keys configured")
	}
	return nil, 0, nil, lastErr
}


// probeNonStreamError re-issues an errored request in NON-streaming mode to
// recover a real error body. Some providers return a bodyless error on their
// streaming endpoint for conditions their non-streaming endpoint reports
// properly (e.g. LongCat: out-of-credits → an empty HTTP 500 when streaming, but
// HTTP 402 + a clear message non-streaming). Best-effort: returns (nil, 0) on any
// failure so the caller keeps the original response. Only invoked on a pre-flight
// streaming error (nothing written to the client yet), so the extra request is safe.
func probeNonStreamError(ctx context.Context, url, apiKey string, bearer bool, streamBody []byte) ([]byte, int) {
	var m map[string]any
	if json.Unmarshal(streamBody, &m) != nil {
		return nil, 0
	}
	m["stream"] = false
	nb, err := json.Marshal(m)
	if err != nil {
		return nil, 0
	}
	req, err := newAnthropicReq(ctx, url, apiKey, bearer, nb)
	if err != nil {
		return nil, 0
	}
	resp, err := Client.Do(req)
	if err != nil {
		return nil, 0
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if len(bytes.TrimSpace(b)) == 0 {
		return nil, 0
	}
	return b, resp.StatusCode
}
