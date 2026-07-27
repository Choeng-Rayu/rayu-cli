// Package proxy forwards chat-completion requests to an upstream OpenAI-compatible
// provider, streaming the SSE response back to the client while capturing the
// token usage the provider reports (the authoritative basis for credit billing).
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/circuitbreaker"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

// Client is the shared HTTP client. No overall timeout — long streams rely on
// the request context for cancellation; only the dial/idle/header phases are
// bounded. ResponseHeaderTimeout is the important one for reliability: it bounds
// the time from finishing the request to receiving the upstream's RESPONSE
// HEADERS, WITHOUT limiting how long the (SSE) body then streams. So when an
// upstream is overloaded/at its limit and stalls before answering (e.g. Ollama
// Cloud under quota pressure), the gateway fails FAST and returns a clean
// provider_unavailable 502 — instead of hanging until Cloudflare gives up and
// substitutes its own "origin_bad_gateway" page (which the customer would then
// see raw). Streaming is unaffected: providers send 200 + SSE headers within a
// second, long before any token generation.
//
// 30s is deliberate: a multi-key provider (e.g. OLLAMA_API_KEY="k1,k2,k3") can
// fail over across N keys, and each key's request gets its own header timeout,
// so the WORST case for a full hang is N×30s. With 3 keys that is 90s — still
// under Cloudflare's ~100s origin timeout, so the gateway wins the race and
// returns the clean 502 first. (The circuit breaker then trips and later
// requests fail fast, so the slow path is only the first hit of an outage.)
// UpstreamResponseHeaderTimeout bounds how long the gateway waits for an upstream
// to send RESPONSE HEADERS before failing the request (see Client below). Logged
// at startup so operators can confirm which build is deployed.
const UpstreamResponseHeaderTimeout = 30 * time.Second

var Client = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: UpstreamResponseHeaderTimeout,
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

// APIKey is one credential to try, carrying its database id so a failure can be
// attributed to the KEY that caused it. Without the id, a provider's keys are an
// anonymous blob and "key 2 is rate limited" is unknowable.
type APIKey struct {
	ID     int64
	Secret string
}

// KeyFailure describes why a specific key could not serve a request, so the
// caller can put it on cooldown (429) or take it out of rotation (401/403).
type KeyFailure struct {
	KeyID  int64
	Status int
	// RetryAfter is the provider's requested wait, when it sent one.
	RetryAfter time.Duration
}

// RateLimited reports whether this failure means "try again later" rather than
// "this credential is wrong".
func (f KeyFailure) RateLimited() bool {
	return f.Status == http.StatusTooManyRequests || f.Status == http.StatusPaymentRequired
}

// SendWithFailover sends an upstream request, trying each API key IN ORDER and
// failing over to the next when a key returns a rotatable status (rate limit,
// quota exhausted, or auth/permission — see isRotatableStatus). build is called
// fresh per attempt because a request body can only be read once.
//
// This is the single place adapters get the gateway's upstream resilience from:
// per-host circuit breaker, transient-status retry (via doWithRetry), and
// multi-key rotation. Every wire format therefore behaves identically under
// provider failure, and a new adapter cannot accidentally opt out.
//
// onFailure (optional) is called for EVERY key that failed with a rotatable
// status — including the last one — so per-key health reflects reality even when
// no key succeeded.
//
// Failover happens BEFORE anything is written to the client, so it is invisible:
// the returned response is either a success or the last key's error.
func SendWithFailover(
	ctx context.Context,
	keys []APIKey,
	build func(secret string) (*http.Request, error),
	onFailure func(KeyFailure),
) (resp *http.Response, usedKey APIKey, err error) {
	if len(keys) == 0 {
		keys = []APIKey{{}}
	}
	var lastErr error
	for i, apiKey := range keys {
		key := apiKey
		r, e := doWithRetry(ctx, func() (*http.Request, error) { return build(key.Secret) })
		if e != nil {
			lastErr = e
			if i < len(keys)-1 {
				continue // transport error — try the next key
			}
			return nil, APIKey{}, e
		}
		if isRotatableStatus(r.StatusCode) {
			if onFailure != nil {
				onFailure(KeyFailure{
					KeyID:      key.ID,
					Status:     r.StatusCode,
					RetryAfter: retryAfterFrom(r.Header),
				})
			}
			// Another key remains → close this response and fail over to it.
			if i < len(keys)-1 {
				_, _ = io.Copy(io.Discard, r.Body)
				_ = r.Body.Close()
				continue
			}
		}
		return r, key, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no api keys configured")
	}
	return nil, APIKey{}, lastErr
}

// retryAfterFrom reads an integer-seconds Retry-After header, if present.
func retryAfterFrom(h http.Header) time.Duration {
	if ra := h.Get("Retry-After"); ra != "" {
		if secs, err := strconv.Atoi(ra); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return 0
}

// ParseOpenAIUsageLine extracts a usage object from one OpenAI-style SSE `data:`
// line, or nil when the line carries no usage. Exported for the openai_chat
// adapter in internal/translate: keeping ONE parser next to the Usage type it
// fills is what guarantees both cache conventions (DeepSeek's explicit
// prompt_cache_hit_tokens and OpenAI's prompt_tokens_details.cached_tokens) stay
// handled identically for billing, whichever format the request came in as.
func ParseOpenAIUsageLine(line []byte) *Usage {
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

// ErrSnippet is errSnippet for adapters in internal/translate: a capped, log-safe
// rendering of an upstream error body.
func ErrSnippet(b []byte) string { return errSnippet(b) }

// RelayUpstreamError is the Anthropic-facing relay policy for adapters in
// internal/translate: a client-fixable request error (400/413/422) keeps its real
// status and message so the CLI shows the cause and does not retry; anything else
// becomes the sanitized provider-unavailable 502, so a provider's raw body (which
// may name the provider or carry upgrade URLs) never reaches a customer.
//
// Every translating adapter must route pre-stream failures through this, so the
// error contract does not vary by wire format.
func RelayUpstreamError(w http.ResponseWriter, status int, body []byte) {
	relayUpstreamError(w, status, body, httpx.WriteAnthropicError)
}

// IsUpstreamRequestError reports whether an upstream 4xx means the REQUEST
// itself was bad (client-fixable and PERMANENT) rather than a provider-side or
// transient failure. These are relayed to the client with their real status +
// message so the CLI shows the actual cause (e.g. "this model does not support
// image input") and does NOT retry a request that can never succeed — instead
// of being masked as a retryable 502.
//
// Auth/quota (401/403/429) and 5xx are deliberately EXCLUDED: those are
// provider-side (the gateway's key/capacity), may leak provider internals
// (subscription/upgrade URLs), and/or are legitimately retryable, so they keep
// the sanitized provider-unavailable mapping.
func IsUpstreamRequestError(status int) bool {
	switch status {
	case http.StatusBadRequest, // 400 — malformed / unsupported feature (image, tool, param)
		http.StatusRequestEntityTooLarge, // 413 — context/image too large
		http.StatusUnprocessableEntity:   // 422 — semantically invalid params
		return true
	}
	return false
}

// UpstreamErrorMessage best-effort extracts a human-readable message from an
// upstream error body. Anthropic and OpenAI both use {"error":{"message":...}};
// some providers use a top-level {"message":...}. Capped for safe relay. Only
// ever called for a request-content 4xx (see IsUpstreamRequestError), whose
// message describes the REQUEST (safe to surface), never provider secrets.
// Returns "" if no message is found.
func UpstreamErrorMessage(body []byte) string {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil {
		if m := strings.TrimSpace(e.Error.Message); m != "" {
			return capErrMsg(m)
		}
		if m := strings.TrimSpace(e.Message); m != "" {
			return capErrMsg(m)
		}
	}
	return ""
}

func capErrMsg(s string) string {
	const max = 300
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

// relayUpstreamError writes the appropriate client response for a non-200
// upstream status on a rayu-hosted (pre-stream) failure. A client-fixable
// request error (400/413/422) is relayed with its real status + message (via
// writeErr, which selects the wire format — Anthropic vs OpenAI) so the CLI
// surfaces the cause and doesn't retry; everything else keeps the sanitized,
// upstream-agnostic 502.
func relayUpstreamError(
	w http.ResponseWriter,
	status int,
	body []byte,
	writeErr func(w http.ResponseWriter, status int, msg string),
) {
	if IsUpstreamRequestError(status) {
		msg := UpstreamErrorMessage(body)
		if msg == "" {
			msg = "The request was rejected by the model provider."
		}
		writeErr(w, status, msg)
		return
	}
	httpx.WriteProviderUnavailable(w, http.StatusBadGateway)
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
