// Package server wires the gateway HTTP routes.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/choeng-rayu/rayu-gateway/internal/auth"
	"github.com/choeng-rayu/rayu-gateway/internal/circuitbreaker"
	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/eventqueue"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

const (
	maxRequestBytes  = 8 << 20 // 8 MiB
	defaultMaxTokens = 2048    // estimate fallback when max_tokens is unset
)

// entSource resolves per-user entitlements and exposes cached app settings. It
// is backed by *entitlements.Cache in production and a fake in tests (so the
// chat/proxy handlers can be exercised without a live MySQL).
type entSource interface {
	Resolve(ctx context.Context, userID int64) (entitlements.Entitlement, error)
	Settings() store.AppSettings
	Invalidate(userID int64)
}

// Server holds the gateway dependencies shared across handlers.
type Server struct {
	cfg *config.Config
	ent entSource
	lim *credits.Limiter
	st  *store.Store
	wq  *eventqueue.Queue
}

// New builds the gateway HTTP handler. /healthz is public; everything under
// /v1 requires a valid Rayu access token.
func New(cfg *config.Config, ent entSource, lim *credits.Limiter, st *store.Store) http.Handler {
	// wq replaces the old per-write safeGo(...) goroutines for the credit
	// ledger + usage-event writes: a single bounded, serialized queue so
	// those best-effort durable writes can never open more MySQL
	// connections than eventqueue.DefaultWorkers, regardless of how many
	// concurrent chat/proxy requests are scheduling them. See
	// internal/eventqueue for why (pool starvation under concurrent load).
	wq := eventqueue.New(eventqueue.Config{
		OnDrop: func(item eventqueue.Item, reason string, err error) {
			log.Printf("eventqueue: dropped item %q (reason=%s): %v", item.Name, reason, err)
		},
	})
	s := &Server{cfg: cfg, ent: ent, lim: lim, st: st, wq: wq}

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware(cfg.CorsOrigins))
	r.Use(logRequests)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	r.Group(func(pr chi.Router) {
		pr.Use(auth.Middleware(cfg.JWTSecret))
		pr.Get("/v1/models", s.handleModels)
		pr.Post("/v1/chat/completions", s.handleChat)
		pr.Post("/anthropic/v1/messages", s.handleAnthropicMessages)
		pr.Get("/v1/credits", s.handleCredits)

		pr.Get("/v1/_whoami", s.handleWhoami)
		pr.Get("/v1/_entitlements", s.handleEntitlements)
	})

	// Transparent tracking proxy for BYO-key providers. Identity comes from the
	// X-Rayu-Token header (NOT Authorization, which carries the user's upstream
	// provider key to be forwarded), so it lives outside the Bearer-auth group.
	r.HandleFunc("/v1/proxy", s.handleProxy)

	return r
}

func (s *Server) handleWhoami(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"userId": claims.UserID, "role": claims.Role})
}

// Shutdown drains the background write queue (credit ledger + usage-event
// writes) so a process restart doesn't silently lose whatever was still
// pending. It waits up to timeout for the queue to empty, then closes it
// regardless — a slow/stuck MySQL at shutdown must not hang the process
// past its own termination deadline. Callers (main.go) discover this via a
// type assertion on the http.Handler returned by New, since New's public
// contract deliberately stays http.Handler for callers (including tests)
// that only need to serve requests.
func (s *Server) Shutdown(timeout time.Duration) {
	if s.wq == nil {
		return
	}
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for s.wq.Pending() > 0 && time.Now().Before(deadline) {
		<-ticker.C
	}
	if pending := s.wq.Pending(); pending > 0 {
		log.Printf("eventqueue: shutdown timeout with %d item(s) still pending", pending)
	}
	s.wq.Close()
}

// writeEntitlementError classifies an entitlements.Resolve failure. A
// context.DeadlineExceeded means the resolveDeadline guard tripped — almost
// always the MySQL pool is saturated under load — so it is reported as a
// fast, retryable 503 (with Retry-After) rather than an opaque 500. This is
// the fail-fast behavior: the gateway answers in ~resolveDeadline instead of
// hanging until the reverse proxy in front of it times out and the client
// sees a 502 with no indication of why.
func writeEntitlementError(w http.ResponseWriter, err error) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		w.Header().Set("Retry-After", "1")
		httpx.WriteError(w, http.StatusServiceUnavailable, "gateway busy, please retry")
		return
	}
	httpx.WriteError(w, http.StatusInternalServerError, "entitlement lookup failed")
}

func (s *Server) handleEntitlements(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		writeEntitlementError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"userId": ent.UserID, "status": ent.Status, "plan": ent.Plan,
		"allowedModels": ent.AllowedModels, "topupBalance": ent.TopupBalance,
	})
}

// handleModels returns the caller's plan-allowed hosted models in OpenAI list shape.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		writeEntitlementError(w, err)
		return
	}
	if !ent.Active() {
		httpx.WriteError(w, http.StatusForbidden, "account is "+statusOrUnknown(ent.Status))
		return
	}
	data := make([]map[string]any, 0, len(ent.AllowedModels))
	for _, m := range ent.AllowedModels {
		data = append(data, map[string]any{
			"id": m.Code, "object": "model", "created": 1700000000, "owned_by": "rayu", "label": m.Label,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

// handleCredits returns the caller's live per-period credit usage, remaining
// allowance (credits + token equivalents), top-up balance, and reset time.
func (s *Server) handleCredits(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		writeEntitlementError(w, err)
		return
	}
	st, err := s.lim.Status(r.Context(), claims.UserID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "status lookup failed")
		return
	}
	topup := st.TopupBalance
	if topup < 0 {
		topup = ent.TopupBalance
	}
	settings := s.ent.Settings()
	var tokensPerCredit int64
	if settings.BaselineCreditsPer1M > 0 {
		tokensPerCredit = int64(math.Round(1_000_000 / float64(settings.BaselineCreditsPer1M)))
	}
	used := st.UsedPeriod
	remainingCredits := remaining(capOrUnlimited(ent.Plan.CreditsPerPeriod), used)
	var allowanceTokens, usedTokens, remainingTokens *int64
	if ent.Plan.CreditsPerPeriod != nil {
		at := *ent.Plan.CreditsPerPeriod * tokensPerCredit
		ut := used * tokensPerCredit
		rt := at - ut
		if rt < 0 {
			rt = 0
		}
		allowanceTokens, usedTokens, remainingTokens = &at, &ut, &rt
	}
	turnsUsed, turnsReset, _ := s.lim.TurnsToday(r.Context(), claims.UserID)
	var turnsRemaining *int64
	if ent.Plan.MaxDailyTurns != nil && *ent.Plan.MaxDailyTurns > 0 {
		rem := *ent.Plan.MaxDailyTurns - turnsUsed
		if rem < 0 {
			rem = 0
		}
		turnsRemaining = &rem
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"plan":             ent.Plan.Code,
		"planName":         ent.Plan.Name,
		"priceCents":       ent.Plan.PriceCents,
		"creditsPerPeriod": ent.Plan.CreditsPerPeriod,
		"usedCredits":      used,
		"remainingCredits": remainingCredits,
		"tokensPerCredit":  tokensPerCredit,
		"allowanceTokens":  allowanceTokens,
		"usedTokens":       usedTokens,
		"remainingTokens":  remainingTokens,
		"resetSeconds":     st.ResetPeriod,
		"periodEnd":        isoTime(ent.PeriodEnd),
		"topupBalance":     topup,
		"topUpEnabled":     ent.Plan.TopUpEnabled,
		// Per-day turn cap (maxDailyTurns). turnsRemaining is null when unlimited.
		"maxDailyTurns":     ent.Plan.MaxDailyTurns,
		"turnsUsedToday":    turnsUsed,
		"turnsRemaining":    turnsRemaining,
		"turnsResetSeconds": turnsReset,
	})
}

// hostedReserve carries everything the shared preamble produced for a hosted
// request: the parsed body, resolved model + provider key, the reserved-credit
// bookkeeping, and a settle closure that reconciles credits to actual usage and
// records the ledger. Built by reserveHosted; consumed by both hosted endpoints.
type hostedReserve struct {
	userID     int64
	req        map[string]any
	hm         *store.HostedModel
	apiKey     string
	estCredits int64
	usedPeriod int64
	capPeriod  int64
	topupBal   int64
	settle     func(usage *proxy.Usage) int64
}

// reserveHosted runs the shared hosted-request preamble — auth, entitlement,
// model lookup, max_tokens guard, provider key, daily-turn cap, and the credit
// reserve — identically for the OpenAI (/v1/chat/completions) and Anthropic
// (/anthropic/v1/messages) endpoints. On success it returns a *hostedReserve
// (whose settle closure reconciles credits + records the ledger) and ok=true; on
// any failure it writes the HTTP error itself and returns ok=false.
func (s *Server) reserveHosted(w http.ResponseWriter, r *http.Request) (*hostedReserve, bool) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		writeEntitlementError(w, err)
		return nil, false
	}
	if !ent.Active() {
		httpx.WriteError(w, http.StatusForbidden, "account is "+statusOrUnknown(ent.Status))
		return nil, false
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "request body too large or unreadable")
		return nil, false
	}
	var req map[string]any
	if json.Unmarshal(body, &req) != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid JSON body")
		return nil, false
	}

	modelCode, _ := req["model"].(string)
	var hm *store.HostedModel
	for i := range ent.AllowedModels {
		if ent.AllowedModels[i].Code == modelCode {
			hm = &ent.AllowedModels[i]
			break
		}
	}
	if hm == nil {
		log.Printf("reject: user=%d model=%q not allowed for plan=%s (allowed=%d)",
			claims.UserID, modelCode, ent.Plan.Code, len(ent.AllowedModels))
		httpx.WriteError(w, http.StatusForbidden, "model not available on your plan: "+modelCode)
		return nil, false
	}

	settings := s.ent.Settings()
	if settings.MaxTokensPerRequest > 0 {
		if mt, ok := req["max_tokens"].(float64); ok && int(mt) > settings.MaxTokensPerRequest {
			httpx.WriteError(w, http.StatusBadRequest, "max_tokens exceeds the per-request limit")
			return nil, false
		}
	}

	apiKey := s.cfg.KeyForProvider(hm.Provider)
	if apiKey == "" {
		httpx.WriteError(w, http.StatusInternalServerError, "provider key not configured")
		return nil, false
	}

	// --- Daily turn cap (maxDailyTurns) — HARD limit on the hosted path ---
	// Counted per user per UTC day; nil/0 cap = unlimited. Checked before the
	// credit reserve so a denial neither charges credits nor calls upstream.
	turnCap := dailyTurnCap(ent.Plan.MaxDailyTurns)
	tr, terr := s.lim.ReserveTurn(r.Context(), claims.UserID, turnCap)
	if terr != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "rate limiter unavailable")
		return nil, false
	}
	if !tr.OK {
		if tr.ResetSeconds > 0 {
			w.Header().Set("Retry-After", strconv.FormatInt(tr.ResetSeconds, 10))
		}
		log.Printf("reject: user=%d daily turn limit reached (%d/%d)", claims.UserID, tr.UsedToday, turnCap)
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        map[string]any{"message": "daily turn limit reached", "type": "rate_limit_exceeded"},
			"reason":       "daily_turn_limit",
			"resetSeconds": tr.ResetSeconds,
		})
		return nil, false
	}

	// --- Credit reserve (pre-flight) ---
	baseline := settings.BaselineCreditsPer1M
	mult := hm.CreditMultiplier
	// rates prices each usage bucket (input/output/cache-read/cache-write)
	// independently for the ACTUAL charge (see credits.DeriveModelRates); the
	// pre-flight estimate above still uses the flat mult since the real
	// input/output/cache split isn't known until the upstream responds.
	rates := credits.DeriveModelRates(hm.CreditMultiplier, hm.InputPricePer1MCents, hm.OutputPricePer1MCents, hm.CacheReadCreditMultiplier, hm.CacheWriteCreditMultiplier)
	capPeriod := capOrUnlimited(ent.Plan.CreditsPerPeriod)
	estCredits := credits.ForTokens(credits.EstimateTokens(req, defaultMaxTokens), baseline, mult)
	if estCredits < 1 {
		estCredits = 1
	}
	topUpAvailable := ent.Plan.TopUpEnabled && ent.TopupBalance > 0
	if topUpAvailable {
		_ = s.lim.EnsureTopup(r.Context(), claims.UserID, ent.TopupBalance)
	}
	rr, rerr := s.lim.Reserve(r.Context(), credits.ReserveParams{
		UserID:        claims.UserID,
		EstCredits:    estCredits,
		CapPeriod:     capPeriod,
		PeriodTTLSec:  periodTTLSeconds(ent.PeriodEnd),
		MaxConcurrent: settings.MaxConcurrentStreams,
		MaxReq5h:      settings.MaxRequestsPer5h,
		TopUpEnabled:  topUpAvailable,
	})
	if rerr != nil {
		s.releaseTurnBG(claims.UserID) // refund the turn; the request didn't proceed
		httpx.WriteError(w, http.StatusInternalServerError, "rate limiter unavailable")
		return nil, false
	}
	if !rr.OK {
		s.releaseTurnBG(claims.UserID) // credit denial: don't also burn a daily turn
		reset := rr.ResetPeriod
		if reset > 0 {
			w.Header().Set("Retry-After", strconv.FormatInt(reset, 10))
		}
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        map[string]any{"message": "credit limit reached: " + rr.Reason, "type": "rate_limit_exceeded"},
			"reason":       rr.Reason,
			"resetSeconds": reset,
		})
		return nil, false
	}

	source := rr.Source
	settled := false
	settle := func(usage *proxy.Usage) int64 {
		actual := actualCredits(usage, baseline, rates)
		if !settled {
			settled = true
			bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = s.lim.Settle(bg, claims.UserID, source, estCredits, actual)
			s.ent.Invalidate(claims.UserID)
			if usage != nil {
				// Token/cache/reasoning breakdown logged on every hosted request
				// so a "why did this cost so much" report can be answered from
				// gateway logs alone instead of guessing — cacheHit tokens are
				// billed at rates.CacheRead, output at rates.Output, everything
				// else (including reasoning, a subset of completion) at rates.Input.
				log.Printf("hosted done: user=%d model=%s charged=%d (est %d) via=%s tokens(total=%d prompt=%d completion=%d reasoning=%d cacheHit=%d cacheMiss=%d)",
					claims.UserID, hm.Code, actual, estCredits, source,
					usage.TotalTokens, usage.PromptTokens, usage.CompletionTokens, usage.CompletionTokensDetails.ReasoningTokens,
					usage.PromptCacheHitTokens, usage.PromptCacheMissTokens)
				s.recordLedger(claims.UserID, *hm, usage, actual, source, rates)
			} else {
				log.Printf("hosted done: user=%d model=%s charged=%d (est %d) via=%s (no usage reported)",
					claims.UserID, hm.Code, actual, estCredits, source)
			}
		}
		return actual
	}

	return &hostedReserve{
		userID:     claims.UserID,
		req:        req,
		hm:         hm,
		apiKey:     apiKey,
		estCredits: estCredits,
		usedPeriod: rr.UsedPeriod,
		capPeriod:  capPeriod,
		topupBal:   ent.TopupBalance,
		settle:     settle,
	}, true
}

// handleChat reserves credits (via reserveHosted), proxies the (streaming)
// OpenAI-compatible completion to the model's upstream, settles to actual usage,
// and records the ledger.
func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	hr, ok := s.reserveHosted(w, r)
	if !ok {
		return
	}
	req := hr.req
	stream, _ := req["stream"].(bool)
	log.Printf("chat: user=%d model=%s stream=%v reserved=%d", hr.userID, hr.hm.Code, stream, hr.estCredits)
	req["model"] = hr.hm.UpstreamModelID
	if stream {
		req["stream_options"] = map[string]any{"include_usage": true}
	}
	newBody, _ := json.Marshal(req)
	upstreamURL := strings.TrimRight(hr.hm.UpstreamBaseURL, "/") + "/chat/completions"

	if stream {
		// Best-effort headers before the stream starts (exact figures via /v1/credits).
		setCreditHeaders(w, hr.usedPeriod, hr.capPeriod, hr.topupBal)
		usage, wrote, serr := proxy.Stream(r.Context(), w, upstreamURL, hr.apiKey, newBody)
		hr.settle(usage)
		if serr != nil {
			log.Printf("chat: upstream error user=%d model=%s wrote=%v: %v", hr.userID, hr.hm.Code, wrote, serr)
		}
		if serr != nil && !wrote {
			writeUpstreamError(w, serr, "upstream error")
		}
		return
	}

	usage, status, respBody, cerr := proxy.Complete(r.Context(), upstreamURL, hr.apiKey, newBody)
	if cerr != nil {
		hr.settle(nil)
		log.Printf("chat: upstream unreachable user=%d model=%s: %v", hr.userID, hr.hm.Code, cerr)
		writeUpstreamError(w, cerr, "upstream error")
		return
	}
	if status != http.StatusOK {
		log.Printf("chat: upstream non-200 user=%d model=%s status=%d", hr.userID, hr.hm.Code, status)
	}
	actual := hr.settle(usage)
	setCreditHeaders(w, hr.usedPeriod-hr.estCredits+actual, hr.capPeriod, hr.topupBal)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(respBody)
}

// handleAnthropicMessages is the rayu-hosted Anthropic Messages endpoint. It
// shares reserveHosted with handleChat, then forwards to the model's Anthropic-
// compatible upstream (DeepSeek: https://api.deepseek.com/anthropic/v1/messages)
// with x-api-key, relaying the native Anthropic stream and metering off the
// Anthropic usage (input_tokens = fresh input, cache_read_input_tokens = cached).
func (s *Server) handleAnthropicMessages(w http.ResponseWriter, r *http.Request) {
	hr, ok := s.reserveHosted(w, r)
	if !ok {
		return
	}
	req := hr.req
	stream, _ := req["stream"].(bool)
	log.Printf("anthropic: user=%d model=%s stream=%v reserved=%d", hr.userID, hr.hm.Code, stream, hr.estCredits)
	req["model"] = hr.hm.UpstreamModelID
	newBody, _ := json.Marshal(req)
	upstreamURL := anthropicUpstream(hr.hm.UpstreamBaseURL)

	if stream {
		setCreditHeaders(w, hr.usedPeriod, hr.capPeriod, hr.topupBal)
		usage, wrote, serr := proxy.StreamAnthropic(r.Context(), w, upstreamURL, hr.apiKey, newBody)
		hr.settle(usage)
		if serr != nil {
			log.Printf("anthropic: upstream error user=%d model=%s wrote=%v: %v", hr.userID, hr.hm.Code, wrote, serr)
		}
		if serr != nil && !wrote {
			writeUpstreamError(w, serr, "upstream error")
		}
		return
	}

	usage, status, respBody, cerr := proxy.CompleteAnthropic(r.Context(), upstreamURL, hr.apiKey, newBody)
	if cerr != nil {
		hr.settle(nil)
		log.Printf("anthropic: upstream unreachable user=%d model=%s: %v", hr.userID, hr.hm.Code, cerr)
		writeUpstreamError(w, cerr, "upstream error")
		return
	}
	if status != http.StatusOK {
		log.Printf("anthropic: upstream non-200 user=%d model=%s status=%d", hr.userID, hr.hm.Code, status)
	}
	actual := hr.settle(usage)
	setCreditHeaders(w, hr.usedPeriod-hr.estCredits+actual, hr.capPeriod, hr.topupBal)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(respBody)
}

// anthropicUpstream derives DeepSeek's Anthropic Messages endpoint from a model's
// configured (OpenAI-style) upstream base URL by keeping the origin and appending
// /anthropic/v1/messages (DeepSeek exposes the Anthropic-compatible API at
// https://api.deepseek.com/anthropic).
func anthropicUpstream(base string) string {
	trimmed := strings.TrimRight(base, "/")
	if u, err := url.Parse(trimmed); err == nil && u.Scheme != "" && u.Host != "" {
		return u.Scheme + "://" + u.Host + "/anthropic/v1/messages"
	}
	return strings.TrimSuffix(trimmed, "/v1") + "/anthropic/v1/messages"
}

// recordLedger writes the durable consumption row via the bounded write
// the SAME per-bucket ModelRates used to charge the user's credits, reused
// here purely as a discount RATIO (rates.CacheRead/rates.Input) so the
// internal cost ledger tracks what the provider actually charged Rayu — not
// the full sticker price for every prompt token — for whatever cache-read
// rate this specific model is configured with (global default or an
// admin-set per-model override), instead of a hardcoded constant that could
// drift from what the user was actually billed.
func (s *Server) recordLedger(userID int64, m store.HostedModel, u *proxy.Usage, creditsConsumed int64, source string, rates credits.ModelRates) {
	if s.st == nil {
		return
	}
	cacheReadFraction := 1.0
	if rates.Input > 0 {
		cacheReadFraction = rates.CacheRead / rates.Input
	}
	// Reconciled cache split (DeepSeek native + OpenAI cached_tokens + none):
	// fresh tokens at full price, cache reads at the discounted fraction. This
	// mirrors what the user's credits were charged and what the provider bills
	// Rayu. fresh + read always == PromptTokens, so no input token is missed.
	billableInputTokens := float64(u.FreshInputTokens()) + float64(u.CacheReadTokens())*cacheReadFraction
	cost := billableInputTokens/1e6*float64(m.InputPricePer1MCents) +
		float64(u.CompletionTokens)/1e6*float64(m.OutputPricePer1MCents)
	realCostCents := int(math.Round(cost))
	s.wq.Enqueue(eventqueue.Item{
		Name: "record_ledger",
		Run: func(ctx context.Context) error {
			return s.st.InsertLedger(ctx, userID, m.Code, u.PromptTokens, u.CompletionTokens, creditsConsumed, realCostCents, source)
		},
	})
}

// handleProxy is a transparent, authenticated reverse proxy for BYO-key
// providers (openai-compatible + anthropic) when the CLI has USE_RAYU_OAUTH on.
// It verifies the Rayu identity (X-Rayu-Token), guards against SSRF, forwards
// the request to the user-supplied upstream (X-Rayu-Upstream-URL) with the
// caller's own provider auth headers, streams the response back, and records a
// best-effort usage event. No credits are charged (the user pays their own
// provider). Any gateway-origin failure carries an X-Rayu-Proxy-Error header so
// the CLI can fail safe to a direct call.
func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimSpace(r.Header.Get("X-Rayu-Token"))
	if tok == "" {
		proxyError(w, http.StatusUnauthorized, "missing X-Rayu-Token")
		return
	}
	claims, err := auth.VerifyAccessToken(tok, s.cfg.JWTSecret)
	if err != nil {
		proxyError(w, http.StatusUnauthorized, "invalid X-Rayu-Token")
		return
	}
	upstream := strings.TrimSpace(r.Header.Get("X-Rayu-Upstream-URL"))
	if upstream == "" {
		proxyError(w, http.StatusBadRequest, "missing X-Rayu-Upstream-URL")
		return
	}
	if verr := validateUpstreamURL(upstream); verr != nil {
		proxyError(w, http.StatusForbidden, verr.Error())
		return
	}

	// --- Daily turn cap (maxDailyTurns) — BEST-EFFORT on the BYO-key path ---
	// Enforced only when entitlements + limiter are available (nil in some unit
	// tests). On deny we return a plain 429 that is intentionally NOT tagged with
	// X-Rayu-Proxy-Error, so the CLI surfaces "daily limit reached" instead of
	// failing safe to a direct provider call (which would bypass the cap). Any
	// infra hiccup fails open — a BYO-key user is never blocked by gateway issues.
	reservedTurn := false
	if s.ent != nil && s.lim != nil {
		if ent, eerr := s.ent.Resolve(r.Context(), claims.UserID); eerr == nil {
			tr, terr := s.lim.ReserveTurn(r.Context(), claims.UserID, dailyTurnCap(ent.Plan.MaxDailyTurns))
			switch {
			case terr != nil:
				// limiter unavailable → fail open (don't block BYO-key traffic)
			case !tr.OK:
				if tr.ResetSeconds > 0 {
					w.Header().Set("Retry-After", strconv.FormatInt(tr.ResetSeconds, 10))
				}
				// Mark this as an intentional gateway limit (NOT an X-Rayu-Proxy-Error):
				// the CLI must surface it to the user rather than failing safe to a
				// direct provider call (which would bypass the cap).
				w.Header().Set("X-Rayu-Limit", "daily_turn_limit")
				log.Printf("proxy reject: user=%d daily turn limit reached (%d/%d)",
					claims.UserID, tr.UsedToday, tr.Limit)
				httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
					"error":        map[string]any{"message": "daily turn limit reached", "type": "rate_limit_exceeded"},
					"reason":       "daily_turn_limit",
					"resetSeconds": tr.ResetSeconds,
				})
				return
			default:
				reservedTurn = true
			}
		}
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		if reservedTurn {
			s.releaseTurnBG(claims.UserID)
		}
		proxyError(w, http.StatusBadRequest, "request body too large or unreadable")
		return
	}
	provider := headerOr(r, "X-Rayu-Provider", "unknown")
	model := bestEffortModel(body)

	// Positive marker so the CLI can distinguish a genuinely-proxied response
	// from anything else — an older gateway without this route (404), a redirect,
	// an error page — and fail safe to a direct call when it is absent.
	w.Header().Set("X-Rayu-Proxied", "1")
	status, wrote, ferr := proxy.Forward(r.Context(), w, r.Method, upstream, forwardableHeaders(r.Header), body)
	if ferr != nil && !wrote {
		// Upstream unreachable / gateway-side failure before any bytes were sent.
		if reservedTurn {
			s.releaseTurnBG(claims.UserID) // CLI will fail safe to direct; don't burn a turn
		}
		w.Header().Del("X-Rayu-Proxied")
		log.Printf("proxy: upstream unreachable user=%d provider=%s model=%q upstream=%s: %v",
			claims.UserID, provider, model, upstream, ferr)
		if errors.Is(ferr, circuitbreaker.ErrOpen) {
			w.Header().Set("Retry-After", "5")
			proxyError(w, http.StatusServiceUnavailable, "upstream temporarily unavailable")
		} else {
			proxyError(w, http.StatusBadGateway, "upstream unreachable")
		}
		return
	}
	if status != http.StatusOK {
		// The gateway is a transparent pass-through here, so a non-200 (e.g. the
		// upstream's own 503/429) is expected sometimes — but it MUST show up in
		// gateway logs, or every "why did I get a 503 from the gateway" report
		// requires cross-referencing the provider's own dashboard to answer.
		log.Printf("proxy: upstream non-200 user=%d provider=%s model=%q upstream=%s status=%d",
			claims.UserID, provider, model, upstream, status)
	}

	// Best-effort tracking via the bounded write queue. Never affects the
	// proxied response — Enqueue is non-blocking and the write happens on a
	// shared worker pool instead of one untracked goroutine per request.
	if s.st != nil {
		s.wq.Enqueue(eventqueue.Item{
			Name: "proxy_usage_event",
			Run: func(ctx context.Context) error {
				return s.st.InsertUsageEvent(ctx, claims.UserID, provider, model, "gateway")
			},
		})
	}
	log.Printf("proxy: user=%d provider=%s model=%q -> %s (status=%d)", claims.UserID, provider, model, upstream, status)
}

// proxyError writes a gateway-origin error tagged with X-Rayu-Proxy-Error so the
// CLI can distinguish it from a forwarded upstream response and fall back to a
// direct provider call.
func proxyError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("X-Rayu-Proxy-Error", msg)
	httpx.WriteError(w, status, msg)
}

// writeUpstreamError classifies an upstream call failure from proxy.Stream/
// Complete/Forward. circuitbreaker.ErrOpen means the breaker for that host is
// already open from recent consecutive failures — the gateway didn't even
// attempt to dial, so this returns fast as a 503 (with Retry-After) rather
// than the 502 used for "we tried and the upstream didn't answer". Any other
// error keeps the existing 502 semantics via defaultMsg.
func writeUpstreamError(w http.ResponseWriter, err error, defaultMsg string) {
	if errors.Is(err, circuitbreaker.ErrOpen) {
		w.Header().Set("Retry-After", "5")
		httpx.WriteError(w, http.StatusServiceUnavailable, "upstream temporarily unavailable")
		return
	}
	httpx.WriteError(w, http.StatusBadGateway, defaultMsg)
}

func headerOr(r *http.Request, key, def string) string {
	if v := strings.TrimSpace(r.Header.Get(key)); v != "" {
		return v
	}
	return def
}

// bestEffortModel pulls the "model" field from a JSON request body for tracking.
func bestEffortModel(body []byte) string {
	var m struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &m) == nil {
		return m.Model
	}
	return ""
}

// hopByHopHeaders are per-connection headers that must not be forwarded.
var hopByHopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true,
	"Proxy-Authorization": true, "Te": true, "Trailer": true,
	"Transfer-Encoding": true, "Upgrade": true,
}

// forwardableHeaders returns the headers to replay to the upstream: everything
// except the gateway's own control headers (X-Rayu-*), Host/Content-Length
// (set from the new request/body), and hop-by-hop headers. The provider's auth
// header (Authorization / x-api-key) is preserved so the upstream authenticates.
func forwardableHeaders(h http.Header) http.Header {
	out := http.Header{}
	for k, vs := range h {
		ck := http.CanonicalHeaderKey(k)
		if strings.HasPrefix(ck, "X-Rayu-") || ck == "Host" || ck == "Content-Length" || hopByHopHeaders[ck] {
			continue
		}
		for _, v := range vs {
			out.Add(ck, v)
		}
	}
	return out
}

// validateUpstreamURL enforces https and blocks SSRF to private/loopback/
// link-local hosts (so the authenticated proxy can't be used to reach internal
// services or the cloud metadata endpoint). It is a var so tests can relax the
// guard to reach a loopback httptest upstream.
var validateUpstreamURL = func(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid upstream url")
	}
	if u.Scheme != "https" {
		return errors.New("upstream must be https")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("upstream host required")
	}
	if isPrivateHost(host) {
		return errors.New("upstream host not allowed")
	}
	return nil
}

func isPrivateHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return isPrivateIP(ip)
	}
	// Hostname: resolve and reject if any A/AAAA record is private.
	ips, err := net.LookupIP(host)
	if err != nil {
		return false // let the forward attempt fail naturally if it won't resolve
	}
	for _, ip := range ips {
		if isPrivateIP(ip) {
			return true
		}
	}
	return false
}

func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

func setCreditHeaders(w http.ResponseWriter, usedWeek, capWeek, topup int64) {
	w.Header().Set("x-rayu-credits-used", strconv.FormatInt(usedWeek, 10))
	if capWeek < 0 {
		w.Header().Set("x-rayu-credits-remaining", "unlimited")
	} else {
		rem := capWeek - usedWeek
		if rem < 0 {
			rem = 0
		}
		w.Header().Set("x-rayu-credits-remaining", strconv.FormatInt(rem, 10))
	}
	w.Header().Set("x-rayu-topup-balance", strconv.FormatInt(topup, 10))
}

func actualCredits(u *proxy.Usage, baseline int, rates credits.ModelRates) int64 {
	if u == nil {
		return 0
	}
	return credits.ForUsage(credits.Usage{
		PromptTokens:           int64(u.PromptTokens),
		CompletionTokens:       int64(u.CompletionTokens),
		TotalTokens:            int64(u.TotalTokens),
		PromptCacheHitTokens:   int64(u.CacheReadTokens()),
		PromptCacheMissTokens:  int64(u.FreshInputTokens()),
		PromptCacheWriteTokens: 0, // DeepSeek/DeepInfra don't report a cache-write count today
	}, baseline, rates)
}

// remaining returns the remaining credits for a cap, or nil when unlimited.
func remaining(cap, used int64) *int64 {
	if cap < 0 {
		return nil
	}
	r := cap - used
	if r < 0 {
		r = 0
	}
	return &r
}

func capOrUnlimited(v *int64) int64 {
	if v == nil {
		return credits.Unlimited
	}
	return *v
}

// dailyTurnCap returns the per-day turn cap for a plan: 0 (unlimited) when the
// limit is unset or non-positive, else the configured value. Treating 0/negative
// as unlimited fails open, so an accidental 0 never locks every user out.
func dailyTurnCap(v *int64) int64 {
	if v == nil || *v <= 0 {
		return 0
	}
	return *v
}

// releaseTurnBG refunds one daily turn out-of-band (the response is already
// being written, so the request context may be cancelling).
func (s *Server) releaseTurnBG(userID int64) {
	bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.lim.ReleaseTurn(bg, userID)
}

func statusOrUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

// periodTTLSeconds is the Redis TTL for the period balance: time until the
// subscription renews. 0 lets the limiter fall back to its 30-day default.
func periodTTLSeconds(pe *time.Time) int {
	if pe == nil {
		return 0
	}
	s := int(time.Until(*pe).Seconds())
	if s < 60 {
		s = 60
	}
	return s
}

// isoTime renders a *time.Time as RFC3339, or null.
func isoTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Format(time.RFC3339)
}

// corsMiddleware allows the configured browser origins (default "*") to call the
// JWT-protected API (the dashboard reads /v1/credits). Auth is via Bearer token,
// not cookies, so a wildcard origin is safe here.
// logRequests logs one line per request (method, path, status, duration, bytes),
// skipping the health probe. Streaming requests log when the stream completes,
// so the duration reflects total stream time.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		log.Printf("%s %s -> %d (%s, %dB)",
			r.Method, r.URL.Path, ww.Status(),
			time.Since(start).Round(time.Millisecond), ww.BytesWritten())
	})
}

func corsMiddleware(origins []string) func(http.Handler) http.Handler {
	// (request logging lives in logRequests, registered before this)
	allowed := map[string]bool{}
	allowAll := false
	for _, o := range origins {
		if o == "*" {
			allowAll = true
		}
		allowed[o] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (allowAll || allowed[origin]) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
