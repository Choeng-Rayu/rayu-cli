// Package proxy forwards chat-completion requests to an upstream OpenAI-compatible
// provider, streaming the SSE response back to the client while capturing the
// token usage the provider reports (the authoritative basis for credit billing).
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/circuitbreaker"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

// Client is the shared HTTP client. No overall timeout — long streams rely on
// the request context for cancellation; only the dial/idle are bounded.
var Client = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	},
}

// Breakers is a per-upstream-host circuit breaker shared by Stream, Complete,
// and Forward (via doWithRetry). Under a sustained outage at one provider
// (DeepSeek, DeepInfra, or a BYO-key upstream on the /v1/proxy path), this
// stops every concurrent in-flight request from independently paying the
// full request timeout + maxUpstreamRetries against a host that is not
// recovering — after FailureThreshold consecutive failures the breaker opens
// and subsequent calls fail immediately with circuitbreaker.ErrOpen for the
// Cooldown window, instead of queuing behind a doomed upstream call. This is
// deliberately package-level (not per-Server) since the underlying problem —
// an upstream host being down — is process-wide, not per-request-instance.
var Breakers = circuitbreaker.New(circuitbreaker.Config{})

// CompletionTokensDetails breaks CompletionTokens down further. ReasoningTokens
// (DeepSeek "thinking mode", OpenAI o1-style models, ...) is a SUBSET of
// CompletionTokens, not additional to it — providers that report it are just
// showing how much of the completion was chain-of-thought vs. the final
// answer. It exists here purely for observability (so "why did this cost so
// much" can distinguish a huge-context call from a long-reasoning call); it
// does not change billing, since CompletionTokens already includes it.
type CompletionTokensDetails struct {
	ReasoningTokens int `json:"reasoning_tokens"`
}

// Usage is the token accounting returned by the provider. PromptCacheHitTokens/
// PromptCacheMissTokens are DeepSeek's (and DeepSeek-compatible providers')
// context-cache breakdown of PromptTokens: a cache hit is billed by the
// provider at a small fraction of a cache miss (DeepSeek: ~1-8% depending on
// model) because it reuses a previously-processed prefix instead of
// reprocessing it. They are 0 for providers that don't report caching, and
// PromptCacheHitTokens+PromptCacheMissTokens == PromptTokens when they do.
type Usage struct {
	PromptTokens            int                     `json:"prompt_tokens"`
	CompletionTokens        int                     `json:"completion_tokens"`
	TotalTokens             int                     `json:"total_tokens"`
	PromptCacheHitTokens    int                     `json:"prompt_cache_hit_tokens"`
	PromptCacheMissTokens   int                     `json:"prompt_cache_miss_tokens"`
	PromptTokensDetails     PromptTokensDetails     `json:"prompt_tokens_details"`
	CompletionTokensDetails CompletionTokensDetails `json:"completion_tokens_details"`
}

// PromptTokensDetails is the OpenAI-style prompt-token breakdown. `cached_tokens`
// is how OpenAI (and some DeepSeek-compatible upstreams / proxies) report the
// cached prefix — the alternative to DeepSeek's native prompt_cache_hit_tokens.
// Capturing both conventions is what keeps billing aligned with the provider
// regardless of which shape a given upstream uses.
type PromptTokensDetails struct {
	CachedTokens int `json:"cached_tokens"`
}

// CacheReadTokens is the cached (cache-hit) prompt-token count, normalized
// across the two provider conventions: DeepSeek's explicit
// `prompt_cache_hit_tokens` and OpenAI's `prompt_tokens_details.cached_tokens`.
// 0 when the provider reports no caching. Priced at the cheap cache-read rate.
func (u *Usage) CacheReadTokens() int {
	if u.PromptCacheHitTokens > 0 {
		return u.PromptCacheHitTokens
	}
	if u.PromptTokensDetails.CachedTokens > 0 {
		return u.PromptTokensDetails.CachedTokens
	}
	return 0
}

// FreshInputTokens is the uncached (cache-miss) prompt-token count — the tokens
// the provider actually re-processed and charges full price for. It prefers the
// provider's explicit `prompt_cache_miss_tokens`, else derives it as
// prompt_tokens - CacheReadTokens so fresh + cached ALWAYS reconciles to the
// provider's authoritative `prompt_tokens` (never billing more or fewer input
// tokens than the provider reported). Falls back to the full prompt when no
// cache is reported at all — correct, since the provider gave no discount.
func (u *Usage) FreshInputTokens() int {
	if u.PromptCacheMissTokens > 0 {
		return u.PromptCacheMissTokens
	}
	read := u.CacheReadTokens()
	if fresh := u.PromptTokens - read; fresh > 0 {
		return fresh
	}
	if read > 0 {
		return 0
	}
	return u.PromptTokens
}

func newReq(ctx context.Context, url, apiKey string, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	return req, nil
}

// --- Transient-upstream retry -----------------------------------------------
//
// Providers (DeepSeek, DeepInfra, AWS Bedrock, ...) occasionally answer a
// pre-flight request with a brief capacity blip — 502/503/504 — that is
// unrelated to the request's content, so a same-provider retry a moment later
// commonly succeeds (this is AWS's own documented advice for Bedrock's
// "ServiceUnavailableException"/"too many connections" responses, and
// DeepSeek's documented behavior for 503 "server overloaded"). This is safe to
// do transparently here because Stream/Complete/Forward all inspect the
// upstream's status line before writing anything to the client — nothing has
// been sent yet, so a retry is invisible to the caller either way.
//
// This is intentionally small: it smooths over sub-second blips so one flaky
// upstream reply doesn't fail an entire agent turn. A sustained outage still
// surfaces to the caller (and from there to the CLI's own, more patient
// retry-with-backoff) after maxUpstreamRetries attempts.
const (
	maxUpstreamRetries = 2
	retryBaseDelay     = 250 * time.Millisecond
	retryMaxDelay      = 2 * time.Second
)

// isRetryableStatus reports whether an upstream status is worth an automatic
// same-request retry. 429 is deliberately excluded: it usually reflects a real
// per-key/account rate limit that a couple of sub-second retries won't clear,
// and the response's Retry-After is forwarded to the client, which has its own
// (longer) backoff loop for exactly that case.
func isRetryableStatus(code int) bool {
	switch code {
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

// retryDelay computes the backoff before the next attempt, honoring an
// integer-seconds Retry-After header when present (capped at retryMaxDelay so
// a large provider-suggested wait doesn't stall the gateway request itself —
// the CLI's own retry loop is the right place for longer backoffs).
func retryDelay(attempt int, header http.Header) time.Duration {
	if ra := header.Get("Retry-After"); ra != "" {
		if secs, err := strconv.Atoi(ra); err == nil && secs > 0 {
			d := time.Duration(secs) * time.Second
			if d > retryMaxDelay {
				return retryMaxDelay
			}
			return d
		}
	}
	d := retryBaseDelay * time.Duration(uint(1)<<uint(attempt))
	if d > retryMaxDelay {
		return retryMaxDelay
	}
	return d
}

// doWithRetry sends the request built by buildReq — called fresh for every
// attempt, since an *http.Request's body can only be read once — retrying up
// to maxUpstreamRetries times when the upstream responds with a transient
// status. A transport-level error (dial/TLS/timeout failure — no response at
// all) is returned immediately without retrying: Stream/Complete/Forward all
// treat that as "upstream unreachable", which is the caller's cue to fail the
// request rather than keep the client waiting on a dead upstream.
//
// Before dialing, checks Breakers for the target host: if the breaker is
// open (host has failed repeatedly and is in its cooldown), returns
// circuitbreaker.ErrOpen immediately instead of paying a dial/TLS/read
// timeout against a host that recent history says is down. A transport
// error or exhausting all retries against a still-retryable status reports a
// breaker Failure; a response that didn't need every retry (success, or a
// non-retryable 4xx that isn't the breaker's concern) reports Success — a
// clean 4xx is the upstream working correctly and rejecting the request, not
// the upstream being down.
func doWithRetry(ctx context.Context, buildReq func() (*http.Request, error)) (*http.Response, error) {
	// Build once up front purely to learn the target host for the breaker
	// check; buildReq is cheap (no I/O) and is called again fresh per
	// attempt below since a request body can only be read once.
	probe, err := buildReq()
	if err != nil {
		return nil, err
	}
	host := probe.URL.Host

	if !Breakers.Allow(host) {
		return nil, circuitbreaker.ErrOpen
	}

	for attempt := 0; ; attempt++ {
		req, err := buildReq()
		if err != nil {
			return nil, err
		}
		resp, err := Client.Do(req)
		if err != nil {
			Breakers.Failure(host)
			return nil, err
		}
		if attempt >= maxUpstreamRetries || !isRetryableStatus(resp.StatusCode) {
			if attempt >= maxUpstreamRetries && isRetryableStatus(resp.StatusCode) {
				// Retries exhausted and the upstream is STILL answering
				// 502/503/504 — that's the breaker's signal, distinct from a
				// single blip the retry already absorbed.
				Breakers.Failure(host)
			} else {
				Breakers.Success(host)
			}
			return resp, nil
		}
		delay := retryDelay(attempt, resp.Header)
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
}

// parseUsageLine extracts a non-empty usage object from a single SSE `data:` line.
func parseUsageLine(line []byte) *Usage {
	s := bytes.TrimSpace(line)
	if !bytes.HasPrefix(s, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(s[len("data:"):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil
	}
	var chunk struct {
		Usage *Usage `json:"usage"`
	}
	if json.Unmarshal(payload, &chunk) != nil {
		return nil
	}
	if chunk.Usage != nil && chunk.Usage.TotalTokens > 0 {
		return chunk.Usage
	}
	return nil
}

// errSnippet caps an upstream error body for safe/readable logging.
func errSnippet(b []byte) string {
	const max = 300
	s := bytes.TrimSpace(b)
	if len(s) > max {
		return string(s[:max]) + "…"
	}
	return string(s)
}

// Stream proxies a streaming completion. It owns the response once it starts
// writing; `wrote` reports whether any bytes/headers were sent to the client.
// On a pre-flight failure (wrote=false) the caller should write an error.
func Stream(ctx context.Context, w http.ResponseWriter, upstreamURL, apiKey string, body []byte) (usage *Usage, wrote bool, err error) {
	resp, err := doWithRetry(ctx, func() (*http.Request, error) {
		req, err := newReq(ctx, upstreamURL, apiKey, body)
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

	// rayu-hosted path: never leak the upstream provider's raw error body to the
	// customer (e.g. an Ollama "requires a subscription" 403). Read it only for
	// the server-side error log; reply with a clean, upstream-agnostic 502 that
	// the CLI turns into "try a smaller model or try again later".
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		httpx.WriteProviderUnavailable(w, http.StatusBadGateway)
		return nil, true, fmt.Errorf("upstream status %d: %s", resp.StatusCode, errSnippet(b))
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}

	reader := bufio.NewReader(resp.Body)
	for {
		line, rerr := reader.ReadBytes('\n')
		if len(line) > 0 {
			if _, werr := w.Write(line); werr != nil {
				return usage, true, werr // client disconnected
			}
			if flusher != nil {
				flusher.Flush()
			}
			if u := parseUsageLine(line); u != nil {
				usage = u
			}
		}
		if rerr != nil {
			break // EOF or upstream/ctx error ends the stream
		}
	}
	return usage, true, nil
}

// Complete proxies a non-streaming completion, returning the upstream status,
// raw body, and parsed usage for the caller to write + meter.
func Complete(ctx context.Context, upstreamURL, apiKey string, body []byte) (usage *Usage, status int, respBody []byte, err error) {
	resp, err := doWithRetry(ctx, func() (*http.Request, error) {
		return newReq(ctx, upstreamURL, apiKey, body)
	})
	if err != nil {
		return nil, 0, nil, err
	}
	defer resp.Body.Close()
	respBody, _ = io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusOK {
		var parsed struct {
			Usage *Usage `json:"usage"`
		}
		if json.Unmarshal(respBody, &parsed) == nil && parsed.Usage != nil {
			usage = parsed.Usage
		}
	}
	return usage, resp.StatusCode, respBody, nil
}

// Forward is a transparent reverse-proxy for BYO-key provider requests routed
// through the gateway purely for usage tracking. It replays the caller's
// method/body/headers to upstreamURL — the provider's own auth header (e.g.
// "Authorization: Bearer <userKey>" or "x-api-key") is among the forwarded
// headers, so the gateway never needs its own key for this path — then streams
// the upstream response back verbatim.
//
// `status` is the upstream's HTTP status (0 if the upstream was never reached)
// so the caller can log/observe what was actually relayed. `wrote` reports
// whether any response status/bytes were sent to the client. It is false only
// on a pre-flight failure (bad request build or the upstream being
// unreachable after retries), which lets the caller emit a gateway-origin
// error the CLI can use to fail safe to a direct call. Once the upstream
// responds (even with a 4xx/5xx that retries didn't resolve), the response is
// forwarded as-is and `wrote` is true.
func Forward(ctx context.Context, w http.ResponseWriter, method, upstreamURL string, reqHeaders http.Header, body []byte) (status int, wrote bool, err error) {
	resp, err := doWithRetry(ctx, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, method, upstreamURL, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		for k, vs := range reqHeaders {
			for _, v := range vs {
				req.Header.Add(k, v)
			}
		}
		return req, nil
	})
	if err != nil {
		return 0, false, err // upstream unreachable: caller writes a gateway error
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	wrote = true
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	buf := make([]byte, 32*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return resp.StatusCode, true, werr // client disconnected
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			if rerr != io.EOF {
				return resp.StatusCode, true, rerr
			}
			break
		}
	}
	return resp.StatusCode, true, nil
}
