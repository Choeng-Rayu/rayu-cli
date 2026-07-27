// Package server wires the gateway HTTP routes.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
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
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
	"github.com/choeng-rayu/rayu-gateway/internal/translate"
)

const (
	maxRequestBytes  = 8 << 20 // 8 MiB
	defaultMaxTokens = 2048    // estimate fallback when max_tokens is unset
)

// entSource resolves per-user entitlements and exposes cached app settings +
// the resolved provider registry. It is backed by *entitlements.Cache in
// production and a fake in tests (so the chat/proxy handlers can be exercised
// without a live MySQL).
type entSource interface {
	Resolve(ctx context.Context, userID int64) (entitlements.Entitlement, error)
	Settings() store.AppSettings
	Invalidate(userID int64)
	// Route returns the validated upstream route for a provider id, resolved once
	// per config refresh (never per request).
	Route(providerID int64) (entitlements.ProviderRoute, bool)
	Routes() map[int64]entitlements.ProviderRoute
	// Keys is the live per-key registry: which of a provider's API keys may serve
	// a request right now, plus their health. Decryption already happened during
	// the config refresh, so this is pure in-memory bookkeeping.
	Keys() *providerkeys.Registry
	// Models is the whole hosted catalog, not one user's allowed subset: the admin
	// provider test must be able to exercise a model no plan can use yet.
	Models() []store.HostedModel
	// Reload refreshes the config snapshot immediately. ADMIN paths only: the
	// snapshot exists precisely so a request never queries the database.
	Reload(ctx context.Context) error
}

// Server holds the gateway dependencies shared across handlers.
type Server struct {
	cfg *config.Config
	ent entSource
	lim *credits.Limiter
	st  *store.Store
	wq  *eventqueue.Queue
	// testLim caps the admin provider-test endpoint: each test is a real upstream
	// call with a real key, so it must not be clickable in a loop.
	testLim *testLimiter
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
	s := &Server{cfg: cfg, ent: ent, lim: lim, st: st, wq: wq, testLim: newTestLimiter()}

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware(cfg.CorsOrigins))
	r.Use(logRequests)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	inflight := newInflightLimiter(cfg.MaxInFlight)
	r.Group(func(pr chi.Router) {
		pr.Use(auth.Middleware(cfg.JWTSecret))
		pr.Get("/v1/models", s.handleModels)
		// Only the heavy STREAMING completions are load-shed; the light metadata
		// endpoints (models/credits/whoami) are cheap and stay unlimited.
		pr.Post("/anthropic/v1/messages", inflight.wrap(s.handleAnthropicMessages))
		// Token counting is metadata: free, no upstream call, no concurrency slot.
		// Without it the SDK's countTokens() 404s and the client falls back to
		// sending real billed completions to measure its own context.
		pr.Post("/anthropic/v1/messages/count_tokens", s.handleCountTokens)
		// Retired ingress. Kept registered (rather than 404ing) because CLI builds
		// already published may still POST here: they get an actionable 410 plus a
		// log line that tells operators old clients are still in the field.
		pr.Post("/v1/chat/completions", s.handleRetiredChatCompletions)
		pr.Get("/v1/credits", s.handleCredits)

		pr.Get("/v1/_whoami", s.handleWhoami)
		pr.Get("/v1/_entitlements", s.handleEntitlements)
		pr.Get("/v1/_provider-health", s.handleProviderHealth)
		// Admin-only, rate-limited, charges nothing: one real 1-token request
		// through the production adapter so the dashboard can say "this provider +
		// key + model works" instead of the admin finding out from a user.
		pr.Post("/v1/_provider-test", s.handleProviderTest)
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

// handleProviderHealth reports, per provider in the registry, whether the
// gateway can actually route it: is the config valid, is the provider enabled,
// and is its API key present in THIS gateway's environment. The admin dashboard
// needs this because the backend cannot see the gateway's env — the key never
// leaves it.
//
// The key itself is never returned; only a masked fingerprint ("sk-e2…71c8(35)")
// so an operator can tell two keys apart and spot a truncated/rotated value
// without the secret appearing in a browser, a log, or a screenshot.
// Admin-only: the config detail (env var names, upstream URLs) is operational
// information users have no need for.
func (s *Server) handleProviderHealth(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if claims.Role != "admin" && claims.Role != "superadmin" {
		httpx.WriteError(w, http.StatusForbidden, "admin only")
		return
	}
	routes := s.ent.Routes()
	out := make([]map[string]any, 0, len(routes))
	for id, pr := range routes {
		entry := map[string]any{
			"providerId": id,
			"name":       pr.Route.Name,
			"format":     pr.Route.Format,
			"baseUrl":    pr.Route.BaseURL,
			"endpoint":   pr.Route.Endpoint(),
			"authScheme": pr.Route.AuthScheme,
			"keyCount":   pr.Route.KeyCount,
			"keyPresent": pr.Route.HasKey(),
			"enabled":    pr.Route.Enabled,
			// usableKeys is what actually matters operationally: a provider with 3
			// keys where 2 are rate-limited still works, and the dashboard should
			// say so rather than just "3 keys".
			"usableKeys": s.ent.Keys().Usable(id),
			"routable":   pr.Usable() && s.ent.Keys().Usable(id) > 0,
			// Per-key health, masked — never a secret.
			"keys": s.ent.Keys().SnapshotFor(id),
		}
		if pr.Err != nil {
			entry["configError"] = pr.Err.Error()
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["providerId"].(int64) < out[j]["providerId"].(int64)
	})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"providers": out})
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
			// Capabilities so the client can warn the user ("this model can't read
			// images — pick another model") instead of discovering it as an error
			// mid-request. Authoritative per model; enforced on the request path.
			"supportsReasoning": m.SupportsReasoning,
			"supportsImage":     m.SupportsImage,
			"supportsTools":     m.SupportsTools,
			// Admin-set context window in tokens (null when unset, so the client
			// keeps its own default). Clients budget auto-compaction against this.
			"contextWindow": m.ContextWindow,
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
	tokensPerCredit := credits.TokensPerCredit(settings.BaselineCreditsPer1M)
	usedBillable := st.UsedPeriod // billable tokens used this period (fine-grained)
	// Derive credits from billable tokens (fractional — the coarse whole-credit
	// ceil is gone), rounded to 2 dp for display.
	usedCredits := math.Round(float64(usedBillable)/float64(tokensPerCredit)*100) / 100
	var remainingCredits *float64
	var allowanceTokens, usedTokens, remainingTokens *int64
	if ent.Plan.CreditsPerPeriod != nil {
		rc := float64(*ent.Plan.CreditsPerPeriod) - usedCredits
		if rc < 0 {
			rc = 0
		}
		remainingCredits = &rc
		at := *ent.Plan.CreditsPerPeriod * tokensPerCredit // allowance in billable tokens
		ut := usedBillable                                 // real billable tokens used
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
		"usedCredits":      usedCredits,
		"remainingCredits": remainingCredits,
		"tokensPerCredit":  tokensPerCredit,
		"allowanceTokens":  allowanceTokens,
		"usedTokens":       usedTokens,
		"remainingTokens":  remainingTokens,
		"resetSeconds":     st.ResetPeriod,
		"periodEnd":        isoTime(ent.PeriodEnd),
		"topupBalance":     topup,
		"topUpEnabled":     ent.Plan.TopUpEnabled,
		// Top-up pricing, so a client can quote "$1 = N credits" and enforce the
		// minimum purchase locally instead of guessing or hardcoding a rate.
		"creditsPerDollar": settings.CreditsPerDollar,
		"minTopupCents":    settings.MinTopupCents,
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
	userID   int64
	reqID    string // X-Rayu-Request-Id (edge/gateway correlation)
	source   string // X-Rayu-Query-Source (which CLI feature issued this)
	intended string // X-Rayu-Intended-Model (what the CLI meant to send)
	req      map[string]any
	hm       *store.HostedModel
	route    providercfg.Route // resolved provider route (URL, auth, keys)
	adapter  translate.Adapter // wire-format adapter for that provider
	// apiKeys are the provider keys usable right now, in try order. Each carries
	// its id so a failure can be attributed to that key.
	apiKeys         []proxy.APIKey
	estBillable     int64 // pre-flight billable-token reservation
	usedPeriod      int64 // billable tokens used this period (from the limiter)
	capPeriod       int64 // billable-token allowance (or credits.Unlimited)
	topupBal        int64
	tokensPerCredit int64 // billable tokens per credit (for display/headers)
	settle          func(usage *proxy.Usage) int64
}

// newReqID mints a gateway-assigned correlation id, used when the client did
// NOT send X-Rayu-Request-Id (an older CLI build). The "gw_" prefix makes it
// obvious the id came from the gateway (so a missing client id is visible), while
// still giving every request a single id that ties its start/done/response lines
// together in the gateway log.
func newReqID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "gw_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return "gw_" + hex.EncodeToString(b[:])
}

// hostedIdentity pulls the CLI correlation/attribution headers off a hosted
// request. `source` is the KEY field for diagnosing "why did model X get called"
// — it names the CLI feature (repl_main_thread, agent:*, tool summary, compact,
// webfetch, quota probe, …) that issued the request. When the client is an older
// build that doesn't send these, reqID is gateway-assigned and source is
// "unknown" (which itself signals "old CLI, please update").
func hostedIdentity(r *http.Request) (reqID, source, intended string) {
	reqID = strings.TrimSpace(r.Header.Get("X-Rayu-Request-Id"))
	if reqID == "" {
		reqID = newReqID()
	}
	source = headerOr(r, "X-Rayu-Query-Source", "unknown")
	intended = strings.TrimSpace(r.Header.Get("X-Rayu-Intended-Model"))
	return
}

// reserveHosted runs the shared hosted-request preamble — auth, entitlement,
// model lookup, max_tokens guard, provider key, daily-turn cap, and the credit
// reserve — identically for the OpenAI (/v1/chat/completions) and Anthropic
// (/anthropic/v1/messages) endpoints. On success it returns a *hostedReserve
// (whose settle closure reconciles credits + records the ledger) and ok=true; on
// any failure it writes the HTTP error itself and returns ok=false.
func (s *Server) reserveHosted(w http.ResponseWriter, r *http.Request) (*hostedReserve, bool) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	reqID, source, intended := hostedIdentity(r)
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		log.Printf("hosted reject: user=%d reqid=%s source=%s reason=entitlement_error: %v",
			claims.UserID, reqID, source, err)
		writeEntitlementError(w, err)
		return nil, false
	}
	if !ent.Active() {
		log.Printf("hosted reject: user=%d reqid=%s source=%s reason=account_%s",
			claims.UserID, reqID, source, statusOrUnknown(ent.Status))
		httpx.WriteError(w, http.StatusForbidden, "account is "+statusOrUnknown(ent.Status))
		return nil, false
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		status, label := classifyBodyReadError(err, r.Context().Err())
		log.Printf("hosted reject: user=%d reqid=%s source=%s reason=body_%s status=%d: %v",
			claims.UserID, reqID, source, strings.ReplaceAll(label, " ", "_"), status, err)
		if status == http.StatusRequestTimeout {
			w.Header().Set("Retry-After", "1")
		}
		httpx.WriteError(w, status, "request body "+label)
		return nil, false
	}
	var req map[string]any
	if json.Unmarshal(body, &req) != nil {
		log.Printf("hosted reject: user=%d reqid=%s source=%s reason=invalid_json",
			claims.UserID, reqID, source)
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
		log.Printf("reject: user=%d reqid=%s source=%s model=%q intended=%q not allowed for plan=%s; allowed=[%s]",
			claims.UserID, reqID, source, modelCode, intended, ent.Plan.Code, allowedModelCodes(ent.AllowedModels))
		httpx.WriteError(w, http.StatusForbidden, "model not available on your plan: "+modelCode)
		return nil, false
	}

	// --- Provider registry resolution (replaces the old env registry) ----------
	// The provider row decides the wire format, URL, auth scheme, and which env
	// var holds the key. Everything here happens BEFORE the daily-turn count and
	// the credit reserve, so a misconfigured or disabled provider never charges a
	// user or burns a turn. Errors are deliberately vague to the CLI (they are
	// operator problems, and the detail can name internal hosts/vars) but precise
	// in the log.
	pr, haveRoute := s.ent.Route(hm.ProviderID)
	if !haveRoute {
		log.Printf("reject: user=%d reqid=%s source=%s model=%q provider_id=%d reason=provider_not_in_registry",
			claims.UserID, reqID, source, modelCode, hm.ProviderID)
		httpx.WriteError(w, http.StatusServiceUnavailable, "model temporarily unavailable: "+modelCode)
		return nil, false
	}
	// A row that fails validation is REFUSED, never silently repaired: the
	// gateway would otherwise attach a provider key to a URL/variable nobody
	// configured (SSRF + key exfiltration). Re-checked here (not just in the
	// backend) so a row written directly to the database is caught too.
	if pr.Err != nil {
		log.Printf("reject: user=%d reqid=%s source=%s model=%q provider=%q reason=provider_config_invalid: %v",
			claims.UserID, reqID, source, modelCode, pr.Route.Name, pr.Err)
		httpx.WriteError(w, http.StatusServiceUnavailable, "model temporarily unavailable: "+modelCode)
		return nil, false
	}
	// Admin kill switch (replaces RAYU_DISABLED_PROVIDERS).
	if !pr.Route.Enabled {
		log.Printf("reject: user=%d reqid=%s source=%s model=%q provider=%q is disabled",
			claims.UserID, reqID, source, modelCode, pr.Route.Name)
		httpx.WriteError(w, http.StatusServiceUnavailable, "model temporarily unavailable: "+modelCode)
		return nil, false
	}
	// The provider's wire format must have an adapter in THIS build. Checked here,
	// before any turn or credit is reserved, because a format this gateway cannot
	// speak is an operator/deploy problem and must never cost the user anything.
	adapter, aerr := translate.For(pr.Route.Format)
	if aerr != nil {
		log.Printf("reject: user=%d reqid=%s source=%s model=%q provider=%q reason=unsupported_format: %v (this build serves: %v)",
			claims.UserID, reqID, source, modelCode, pr.Route.Name, aerr, translate.Formats())
		httpx.WriteError(w, http.StatusServiceUnavailable, "model temporarily unavailable: "+modelCode)
		return nil, false
	}

	settings := s.ent.Settings()
	if settings.MaxTokensPerRequest > 0 {
		if mt, ok := req["max_tokens"].(float64); ok && int(mt) > settings.MaxTokensPerRequest {
			log.Printf("reject: user=%d reqid=%s source=%s model=%q reason=max_tokens_exceeded (%d>%d)",
				claims.UserID, reqID, source, modelCode, int(mt), settings.MaxTokensPerRequest)
			httpx.WriteError(w, http.StatusBadRequest, "max_tokens exceeds the per-request limit")
			return nil, false
		}
	}

	// --- Per-model capability gate ---------------------------------------------
	// Refuse content the selected model cannot handle BEFORE reserving a turn or
	// credits, and say so with a stable machine code so the CLI can warn the user
	// and offer to switch models (see internal/httpx WriteCapabilityError).
	if !hm.SupportsImage && requestHasImage(req) {
		log.Printf("reject: user=%d reqid=%s source=%s model=%q reason=no_image_support",
			claims.UserID, reqID, source, modelCode)
		httpx.WriteCapabilityError(w, httpx.CodeNoImageSupport,
			"Model \""+hm.Code+"\" cannot read images. Switch to a model with image support, or remove the image from your message.")
		return nil, false
	}
	if !hm.SupportsReasoning && requestWantsThinking(req) {
		log.Printf("reject: user=%d reqid=%s source=%s model=%q reason=no_thinking_support",
			claims.UserID, reqID, source, modelCode)
		httpx.WriteCapabilityError(w, httpx.CodeNoThinkingSupport,
			"Model \""+hm.Code+"\" does not support extended thinking. Switch to a reasoning-capable model, or disable thinking for this request.")
		return nil, false
	}

	// Which keys may serve this request right now: disabled, invalid and
	// still-cooling keys are already excluded, in priority order. No DB read and
	// no decryption happens here — the registry holds decrypted keys in memory.
	apiKeys := s.ent.Keys().Pick(hm.ProviderID)
	if len(apiKeys) == 0 {
		// Distinguish "never configured" from "all keys are temporarily unusable":
		// the first is an admin task, the second resolves itself.
		total := len(s.ent.Keys().SnapshotFor(hm.ProviderID))
		if total == 0 {
			log.Printf("reject: user=%d reqid=%s source=%s model=%q provider=%q reason=no_api_key_configured",
				claims.UserID, reqID, source, modelCode, pr.Route.Name)
			httpx.WriteError(w, http.StatusInternalServerError, "provider key not configured")
			return nil, false
		}
		log.Printf("reject: user=%d reqid=%s source=%s model=%q provider=%q reason=all_keys_unusable (%d configured: rate-limited or invalid)",
			claims.UserID, reqID, source, modelCode, pr.Route.Name, total)
		w.Header().Set("Retry-After", "60")
		httpx.WriteError(w, http.StatusServiceUnavailable,
			"model temporarily unavailable: "+modelCode)
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
		log.Printf("reject: user=%d reqid=%s source=%s model=%q daily turn limit reached (%d/%d)",
			claims.UserID, reqID, source, hm.Code, tr.UsedToday, turnCap)
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        map[string]any{"message": "daily turn limit reached", "type": "rate_limit_exceeded"},
			"reason":       "daily_turn_limit",
			"resetSeconds": tr.ResetSeconds,
		})
		return nil, false
	}

	// --- Credit reserve (pre-flight) ---
	baseline := settings.BaselineCreditsPer1M
	tpc := credits.TokensPerCredit(baseline)
	mult := hm.CreditMultiplier
	// rates prices each usage bucket (input/output/cache-read/cache-write)
	// independently for the ACTUAL charge, using the four charges the admin
	// entered — nothing is derived from the cost prices (see credits.ModelRatesFor).
	rates := credits.ModelRatesFor(
		hm.CreditMultiplier, hm.OutputCreditMultiplier,
		hm.CacheReadCreditMultiplier, hm.CacheWriteCreditMultiplier,
	)
	// Track usage + allowance in FINE-GRAINED billable tokens (not whole ceil'd
	// credits): a tiny turn then costs its true fraction instead of a full 1M-
	// token credit. Cap = the plan's credit allowance × tokensPerCredit.
	capBillable := credits.Unlimited
	if ent.Plan.CreditsPerPeriod != nil {
		capBillable = *ent.Plan.CreditsPerPeriod * tpc
	}
	// Pre-flight hold: rough billable estimate; settle reconciles to actual.
	estBillable := credits.EstimateBillableTokens(credits.EstimateTokens(req, defaultMaxTokens), mult)
	topUpAvailable := ent.Plan.TopUpEnabled && ent.TopupBalance > 0
	if topUpAvailable {
		_ = s.lim.EnsureTopup(r.Context(), claims.UserID, ent.TopupBalance)
	}
	rr, rerr := s.lim.Reserve(r.Context(), credits.ReserveParams{
		UserID:        claims.UserID,
		EstCredits:    estBillable,
		CapPeriod:     capBillable,
		PeriodTTLSec:  periodTTLSeconds(ent.PeriodEnd),
		PeriodID:      periodID(ent.PeriodEnd),
		MaxConcurrent: settings.MaxConcurrentStreams,
		MaxReq5h:      settings.MaxRequestsPer5h,
		TopUpEnabled:  topUpAvailable,
	})
	if rerr != nil {
		s.releaseTurnBG(claims.UserID) // refund the turn; the request didn't proceed
		log.Printf("hosted reject: user=%d reqid=%s source=%s model=%q reason=limiter_unavailable: %v",
			claims.UserID, reqID, source, hm.Code, rerr)
		httpx.WriteError(w, http.StatusInternalServerError, "rate limiter unavailable")
		return nil, false
	}
	if !rr.OK {
		s.releaseTurnBG(claims.UserID) // credit denial: don't also burn a daily turn
		reset := rr.ResetPeriod
		if reset > 0 {
			w.Header().Set("Retry-After", strconv.FormatInt(reset, 10))
		}
		log.Printf("reject: user=%d reqid=%s source=%s model=%q reason=credit_limit(%s) reset=%ds",
			claims.UserID, reqID, source, hm.Code, rr.Reason, reset)
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        map[string]any{"message": "credit limit reached: " + rr.Reason, "type": "rate_limit_exceeded"},
			"reason":       rr.Reason,
			"resetSeconds": reset,
		})
		return nil, false
	}

	creditSource := rr.Source
	settled := false
	settle := func(usage *proxy.Usage) int64 {
		actual := actualBillable(usage, rates) // billable tokens (fine-grained)
		if !settled {
			settled = true
			bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = s.lim.Settle(bg, claims.UserID, creditSource, estBillable, actual)
			s.ent.Invalidate(claims.UserID)
			if usage != nil {
				// billable = credit-weighted tokens actually charged; ~credits is
				// billable/tokensPerCredit (no coarse whole-credit rounding).
				log.Printf("hosted done: user=%d reqid=%s source=%s model=%s billable=%d (~%.4f credits, est %d) via=%s tokens(total=%d prompt=%d completion=%d reasoning=%d cacheHit=%d cacheMiss=%d)",
					claims.UserID, reqID, source, hm.Code, actual, float64(actual)/float64(tpc), estBillable, creditSource,
					usage.TotalTokens, usage.PromptTokens, usage.CompletionTokens, usage.CompletionTokensDetails.ReasoningTokens,
					usage.PromptCacheHitTokens, usage.PromptCacheMissTokens)
				s.recordLedger(claims.UserID, *hm, usage, creditsFromBillable(actual, tpc), creditSource, rates)
			} else {
				log.Printf("hosted done: user=%d reqid=%s source=%s model=%s billable=%d (est %d) via=%s (no usage reported)",
					claims.UserID, reqID, source, hm.Code, actual, estBillable, creditSource)
			}
		}
		return actual
	}

	// Hand the adapter proxy.APIKey values: secret to use, id to blame on failure.
	tryKeys := make([]proxy.APIKey, 0, len(apiKeys))
	for _, k := range apiKeys {
		tryKeys = append(tryKeys, proxy.APIKey{ID: k.ID, Secret: k.Secret})
	}

	return &hostedReserve{
		userID:          claims.UserID,
		reqID:           reqID,
		source:          source,
		intended:        intended,
		req:             req,
		hm:              hm,
		route:           pr.Route,
		adapter:         adapter,
		apiKeys:         tryKeys,
		estBillable:     estBillable,
		usedPeriod:      rr.UsedPeriod,
		capPeriod:       capBillable,
		topupBal:        ent.TopupBalance,
		tokensPerCredit: tpc,
		settle:          settle,
	}, true
}

// retiredChatCompletionsMessage tells the user how to fix a call to the retired
// OpenAI-shaped hosted ingress. It is deliberately actionable: the only cause is
// an out-of-date CLI, since current builds use the Anthropic ingress.
const retiredChatCompletionsMessage = "This endpoint has been retired. Update rayu-cli (npm i -g @rayu-dev/rayu-cli) — hosted models are now served on /anthropic/v1/messages."

// handleRetiredChatCompletions answers the retired OpenAI-shaped hosted ingress.
//
// The hosted path now has ONE ingress: POST /anthropic/v1/messages, with the
// gateway translating to whatever the provider speaks. This route stays
// registered rather than 404ing because already-published CLI builds may still
// POST here; 410 Gone + a clear message is a far better failure than a bare 404,
// and the log line shows operators that old clients are still in the field.
//
// Nothing is reserved or billed: this returns before any entitlement, turn, or
// credit work.
func (s *Server) handleRetiredChatCompletions(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	log.Printf("retired endpoint: user=%d POST /v1/chat/completions source=%s ua=%q — client needs updating",
		claims.UserID, headerOr(r, "X-Rayu-Query-Source", "unknown"), r.UserAgent())
	httpx.WriteError(w, http.StatusGone, retiredChatCompletionsMessage)
}

// handleAnthropicMessages is THE rayu-hosted completion endpoint. The CLI always
// speaks Anthropic Messages here; the provider's own wire format is resolved from
// the registry and served by the matching adapter in internal/translate — either
// the byte-verbatim Anthropic passthrough or a translating adapter (OpenAI chat /
// OpenAI Responses / Google GenAI). Usage is metered in the same normalized
// buckets whichever format was used, so billing is format-independent.
func (s *Server) handleAnthropicMessages(w http.ResponseWriter, r *http.Request) {
	hr, ok := s.reserveHosted(w, r)
	if !ok {
		return
	}
	req := hr.req
	stream, _ := req["stream"].(bool)
	log.Printf("anthropic: user=%d reqid=%s source=%s model=%s provider=%s format=%s intended=%q stream=%v reserved=%d",
		hr.userID, hr.reqID, hr.source, hr.hm.Code, hr.route.Name, hr.route.Format, hr.intended, stream, hr.estBillable)
	// Model fidelity: the upstream always receives the PROVIDER's model id.
	req["model"] = hr.hm.UpstreamModelID

	// Multi-key failover: the keys arrive in priority order, already filtered to
	// the ones usable right now. The adapter walks them on a rate-limit/quota/auth
	// status and reports each failure so the key's health is recorded — a 429 puts
	// that key on cooldown, a 401/403 takes it out of rotation entirely.
	providerID := hr.hm.ProviderID
	areq := translate.Request{
		Route:           hr.route,
		Keys:            hr.apiKeys,
		UpstreamModelID: hr.hm.UpstreamModelID,
		Anthropic:       req,
		Stream:          stream,
		OnKeyFailure: func(f proxy.KeyFailure) {
			s.recordKeyFailure(providerID, f)
		},
	}

	if stream {
		setCreditHeaders(w, hr.usedPeriod, hr.capPeriod, hr.tokensPerCredit, hr.topupBal)
		usage, wrote, serr := hr.adapter.Stream(r.Context(), w, areq)
		hr.settle(usage)
		if serr != nil {
			log.Printf("anthropic: upstream error user=%d reqid=%s source=%s model=%s format=%s wrote=%v: %v",
				hr.userID, hr.reqID, hr.source, hr.hm.Code, hr.route.Format, wrote, serr)
		}
		if serr != nil && !wrote {
			writeUpstreamError(w, serr, "upstream error")
		}
		return
	}

	usage, status, respBody, cerr := hr.adapter.Complete(r.Context(), areq)
	if cerr != nil {
		hr.settle(nil)
		log.Printf("anthropic: upstream unreachable user=%d reqid=%s source=%s model=%s: %v", hr.userID, hr.reqID, hr.source, hr.hm.Code, cerr)
		writeUpstreamError(w, cerr, "upstream error")
		return
	}
	if status != http.StatusOK {
		log.Printf("anthropic: upstream non-200 user=%d reqid=%s source=%s model=%s status=%d", hr.userID, hr.reqID, hr.source, hr.hm.Code, status)
	}
	actual := hr.settle(usage)
	setCreditHeaders(w, hr.usedPeriod-hr.estBillable+actual, hr.capPeriod, hr.tokensPerCredit, hr.topupBal)
	if status != http.StatusOK {
		// Relay a client-fixable request error (400/413/422 — e.g. "this model
		// does not support image input") with its real status + message so the
		// CLI shows the cause and does NOT retry; keep the sanitized 502 for
		// provider-side/transient failures.
		if proxy.IsUpstreamRequestError(status) {
			msg := proxy.UpstreamErrorMessage(respBody)
			if msg == "" {
				msg = "The request was rejected by the model provider."
			}
			httpx.WriteAnthropicError(w, status, msg)
			return
		}
		httpx.WriteProviderUnavailable(w, http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(respBody)
}

// recordKeyFailure records what an upstream said about a specific API key, so
// rotation reflects reality instead of retrying a credential that just failed.
//
//   - 429 / 402 → cooldown. The key is skipped until the window passes; the
//     provider's Retry-After is honoured (capped, so a provider cannot remove a
//     key from rotation for an hour).
//   - 401 / 403 → invalid. The key stays out until an admin replaces it: retrying
//     a rejected credential wastes latency and can trip abuse counters.
//
// State is updated in memory immediately (so the NEXT request skips the key) and
// persisted asynchronously, so a health write never sits on the request path.
func (s *Server) recordKeyFailure(providerID int64, f proxy.KeyFailure) {
	if f.KeyID == 0 {
		return
	}
	if f.RateLimited() {
		s.ent.Keys().MarkRateLimited(providerID, f.KeyID, f.RetryAfter)
		log.Printf("provider key #%d rate limited (HTTP %d) — cooling down, rotating to the next key",
			f.KeyID, f.Status)
		return
	}
	s.ent.Keys().MarkInvalid(providerID, f.KeyID, fmt.Sprintf("HTTP %d", f.Status))
	log.Printf("provider key #%d rejected by the upstream (HTTP %d) — taken out of rotation until replaced",
		f.KeyID, f.Status)
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

	// Request-identity headers, read early: the logical request id keys the
	// idempotent daily-turn accounting so the CLI's retries of ONE logical
	// request don't each burn a separate daily turn. reqID is gateway-assigned
	// when the client (older CLI) didn't send one, so the request is still
	// correlatable in the gateway log.
	reqID := strings.TrimSpace(r.Header.Get("X-Rayu-Request-Id"))
	if reqID == "" {
		reqID = newReqID()
	}
	logicalID := headerOr(r, "X-Rayu-Logical-Request-Id", reqID)

	// --- Daily turn cap (maxDailyTurns) — BEST-EFFORT on the BYO-key path ---
	// Enforced only when entitlements + limiter are available (nil in some unit
	// tests). On deny we return a plain 429 that is intentionally NOT tagged with
	// X-Rayu-Proxy-Error, so the CLI surfaces "daily limit reached" instead of
	// failing safe to a direct provider call (which would bypass the cap). Any
	// infra hiccup fails open — a BYO-key user is never blocked by gateway issues.
	reservedTurn := false
	if s.ent != nil && s.lim != nil {
		if ent, eerr := s.ent.Resolve(r.Context(), claims.UserID); eerr == nil {
			tr, terr := s.lim.ReserveTurnFor(r.Context(), claims.UserID, dailyTurnCap(ent.Plan.MaxDailyTurns), logicalID)
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

	// Bounded body read. A slow/stalled client upload (or an edge/proxy that
	// half-opens the connection) otherwise hangs here until something upstream
	// gives up — the class of failure seen as `POST /v1/proxy -> 400 (59.953s)`
	// with no `proxy:` detail line. RAYU_PROXY_BODY_READ_TIMEOUT (seconds) sets an
	// explicit read deadline; 0 leaves Go's server defaults. We deliberately do
	// NOT set a global write timeout, which would truncate long SSE streams.
	bodyReadStart := time.Now()
	if s.cfg != nil && s.cfg.ProxyBodyReadTimeoutSeconds > 0 {
		rc := http.NewResponseController(w)
		_ = rc.SetReadDeadline(bodyReadStart.Add(
			time.Duration(s.cfg.ProxyBodyReadTimeoutSeconds) * time.Second,
		))
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		if reservedTurn {
			s.releaseTurnForBG(claims.UserID, logicalID)
		}
		// Classify the failure so operators can tell a too-large upload from a
		// stalled/timed-out read from a generic read error — instead of one
		// opaque 400 for all three (the original "request body too large or
		// unreadable" line that masked the 59.953s stall).
		status, label := classifyBodyReadError(err, r.Context().Err())
		log.Printf("proxy: body read %s user=%d after=%s status=%d ctxErr=%v: %v",
			label, claims.UserID, time.Since(bodyReadStart).Round(time.Millisecond),
			status, r.Context().Err(), err)
		if status == http.StatusRequestTimeout {
			w.Header().Set("Retry-After", "1")
		}
		proxyError(w, status, "request body "+label)
		return
	}
	provider := headerOr(r, "X-Rayu-Provider", "unknown")
	source := headerOr(r, "X-Rayu-Query-Source", "unknown")
	intended := strings.TrimSpace(r.Header.Get("X-Rayu-Intended-Model"))
	// The model ACTUALLY going upstream: Bedrock hides it in the URL path, other
	// providers put it in the JSON body; fall back to the CLI-declared resolved
	// model header. This is what makes gateway logs show the real model instead
	// of the empty body "model" for Bedrock.
	actual := modelFromUpstreamURL(upstream)
	if actual == "" {
		actual = bestEffortModel(body)
	}
	if actual == "" {
		actual = strings.TrimSpace(r.Header.Get("X-Rayu-Resolved-Model"))
	}

	// MODEL FIDELITY: the routed model must match the model the user intended. A
	// definite cross-family mismatch (e.g. intended sonnet-4-6, routed opus) is
	// always logged; when RAYU_ENFORCE_MODEL_FIDELITY is set it is rejected here,
	// BEFORE any upstream call or turn burn, so the bad request never reaches AWS.
	if familyMismatch(intended, actual) {
		log.Printf("proxy: MODEL FIDELITY MISMATCH user=%d reqid=%s logical=%s source=%s intended=%q actual=%q upstream=%s",
			claims.UserID, reqID, logicalID, source, intended, actual, upstream)
		if s.cfg != nil && s.cfg.EnforceModelFidelity {
			if reservedTurn {
				s.releaseTurnForBG(claims.UserID, logicalID)
			}
			w.Header().Set("X-Rayu-Model-Fidelity", "mismatch")
			proxyError(w, http.StatusConflict,
				"model fidelity mismatch: intended and routed model families differ")
			return
		}
	}

	// Positive marker so the CLI can distinguish a genuinely-proxied response
	// from anything else — an older gateway without this route (404), a redirect,
	// an error page — and fail safe to a direct call when it is absent.
	w.Header().Set("X-Rayu-Proxied", "1")
	status, wrote, ferr := proxy.Forward(r.Context(), w, r.Method, upstream, forwardableHeaders(r.Header), body)
	if ferr != nil && !wrote {
		// Upstream unreachable / gateway-side failure before any bytes were sent.
		if reservedTurn {
			s.releaseTurnForBG(claims.UserID, logicalID) // CLI will fail safe to direct; don't burn a turn
		}
		w.Header().Del("X-Rayu-Proxied")
		log.Printf("proxy: upstream unreachable user=%d reqid=%s source=%s provider=%s intended=%q actual=%q upstream=%s: %v",
			claims.UserID, reqID, source, provider, intended, actual, upstream, ferr)
		if errors.Is(ferr, circuitbreaker.ErrOpen) {
			w.Header().Set("Retry-After", "5")
			proxyError(w, http.StatusServiceUnavailable, "upstream temporarily unavailable")
		} else {
			proxyError(w, http.StatusBadGateway, "upstream unreachable")
		}
		return
	}
	// Post-header stream break: upstream started (headers/bytes sent, wrote=true)
	// then failed mid-stream. The status is already committed, but this MUST be
	// logged distinctly instead of being reported as a clean success — otherwise
	// the client sees a truncated stream / "connection error" with no gateway
	// trace to explain it.
	if ferr != nil && wrote {
		log.Printf("proxy: stream interrupted user=%d reqid=%s source=%s provider=%s intended=%q actual=%q upstream=%s status=%d wrote=true: %v",
			claims.UserID, reqID, source, provider, intended, actual, upstream, status, ferr)
		if reservedTurn {
			// Partial/broken stream: refund so an interrupted turn the user has to
			// retry doesn't consume the daily cap.
			s.releaseTurnForBG(claims.UserID, logicalID)
			reservedTurn = false
		}
	}
	if status != http.StatusOK {
		// The gateway is a transparent pass-through here, so a non-200 (e.g. the
		// upstream's own 503/429) is expected sometimes — but it MUST show up in
		// gateway logs, or every "why did I get a 503 from the gateway" report
		// requires cross-referencing the provider's own dashboard to answer.
		log.Printf("proxy: upstream non-200 user=%d reqid=%s source=%s provider=%s intended=%q actual=%q upstream=%s status=%d",
			claims.UserID, reqID, source, provider, intended, actual, upstream, status)
		if reservedTurn {
			// Upstream rejected the request (e.g. Bedrock 400/429). No successful
			// turn happened and the CLI will retry, so refund the reservation to
			// avoid multiplying the daily-turn count across retries.
			s.releaseTurnForBG(claims.UserID, logicalID)
			reservedTurn = false
		}
	}

	// Best-effort tracking via the bounded write queue. Never affects the
	// proxied response — Enqueue is non-blocking and the write happens on a
	// shared worker pool instead of one untracked goroutine per request.
	if s.st != nil {
		s.wq.Enqueue(eventqueue.Item{
			Name: "proxy_usage_event",
			Run: func(ctx context.Context) error {
				return s.st.InsertUsageEvent(ctx, claims.UserID, provider, actual, "gateway")
			},
		})
	}
	log.Printf("proxy: user=%d reqid=%s source=%s provider=%s intended=%q actual=%q -> %s (status=%d)",
		claims.UserID, reqID, source, provider, intended, actual, upstream, status)
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
func writeUpstreamError(w http.ResponseWriter, err error, _ string) {
	// rayu-hosted path: reply with a clean, upstream-agnostic error (never the
	// upstream body) so the CLI shows "try a smaller model or try again later".
	// Circuit open → 503 + Retry-After (a temporary cooldown); otherwise 502.
	if errors.Is(err, circuitbreaker.ErrOpen) {
		w.Header().Set("Retry-After", "5")
		httpx.WriteProviderUnavailable(w, http.StatusServiceUnavailable)
		return
	}
	httpx.WriteProviderUnavailable(w, http.StatusBadGateway)
}

func headerOr(r *http.Request, key, def string) string {
	if v := strings.TrimSpace(r.Header.Get(key)); v != "" {
		return v
	}
	return def
}

// allowedModelCodes returns a comma-joined, length-capped list of the model
// codes a plan allows. Logged on a "model not allowed" reject so an operator can
// see the actual allow-list (and spot a wrong/hardcoded model id from the CLI)
// without a DB lookup.
func allowedModelCodes(models []store.HostedModel) string {
	const maxCodes = 20
	codes := make([]string, 0, len(models))
	for i := range models {
		if i >= maxCodes {
			codes = append(codes, "…")
			break
		}
		codes = append(codes, models[i].Code)
	}
	return strings.Join(codes, ",")
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

// bedrockModelURLRe matches the model id in a Bedrock invoke URL. The
// AnthropicBedrock SDK moves the model OUT of the JSON body and INTO the path:
//
//	/model/{id}/invoke
//	/model/{id}/invoke-with-response-stream
//
// so bestEffortModel(body) returns "" for Bedrock and the real model must be
// read from the URL instead (this is why gateway logs showed model="").
var bedrockModelURLRe = regexp.MustCompile(
	`/model/([^/]+)/invoke(?:-with-response-stream)?(?:$|\?|#)`,
)

// modelFromUpstreamURL extracts the model id from a Bedrock invoke URL, or ""
// when the URL is not a Bedrock invoke URL.
func modelFromUpstreamURL(upstream string) string {
	m := bedrockModelURLRe.FindStringSubmatch(upstream)
	if len(m) < 2 || m[1] == "" {
		return ""
	}
	if dec, err := url.PathUnescape(m[1]); err == nil {
		return dec
	}
	return m[1]
}

// modelFamilyOf classifies a model id/alias into its Claude family by substring
// ("opus"/"sonnet"/"haiku"), or "other" for non-Claude / opaque ids. Mirrors the
// CLI's modelFamilyOf so both ends agree on the fidelity rule.
func modelFamilyOf(model string) string {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"):
		return "opus"
	case strings.Contains(m, "sonnet"):
		return "sonnet"
	case strings.Contains(m, "haiku"):
		return "haiku"
	default:
		return "other"
	}
}

// familyMismatch reports a DEFINITE cross-family mismatch between the intended
// and the actually-routed model: both classify to a known (non-"other") Claude
// family and those families differ. Unknown/opaque ids never trigger it, so an
// enterprise deployment id / custom profile is never falsely flagged (mirrors
// the CLI's isFamilyConsistentOverride).
func familyMismatch(intended, actual string) bool {
	if intended == "" || actual == "" {
		return false
	}
	fi := modelFamilyOf(intended)
	fa := modelFamilyOf(actual)
	if fi == "other" || fa == "other" {
		return false
	}
	return fi != fa
}

// isTimeoutErr reports whether err is a deadline/timeout (net timeout errors and
// anything implementing Timeout() bool, e.g. from SetReadDeadline).
func isTimeoutErr(err error) bool {
	var te interface{ Timeout() bool }
	return errors.As(err, &te) && te.Timeout()
}

// classifyBodyReadError maps a request-body read failure to an HTTP status +
// short label so the three distinct failure modes are individually diagnosable:
//   - too large  -> 413 (client sent > maxRequestBytes)
//   - timeout    -> 408 (read deadline / cancelled context — the 59.953s stall)
//   - unreadable -> 400 (generic transport read error)
func classifyBodyReadError(err error, ctxErr error) (int, string) {
	var maxErr *http.MaxBytesError
	switch {
	case errors.As(err, &maxErr):
		return http.StatusRequestEntityTooLarge, "too large"
	case isTimeoutErr(err) ||
		errors.Is(ctxErr, context.DeadlineExceeded) ||
		errors.Is(err, context.DeadlineExceeded):
		return http.StatusRequestTimeout, "timeout"
	default:
		return http.StatusBadRequest, "unreadable"
	}
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

func setCreditHeaders(w http.ResponseWriter, usedBillable, capBillable, tokensPerCredit, topup int64) {
	if tokensPerCredit <= 0 {
		tokensPerCredit = 1
	}
	w.Header().Set("x-rayu-credits-used", strconv.FormatInt(usedBillable/tokensPerCredit, 10))
	if capBillable < 0 {
		w.Header().Set("x-rayu-credits-remaining", "unlimited")
	} else {
		rem := (capBillable - usedBillable) / tokensPerCredit
		if rem < 0 {
			rem = 0
		}
		w.Header().Set("x-rayu-credits-remaining", strconv.FormatInt(rem, 10))
	}
	w.Header().Set("x-rayu-topup-balance", strconv.FormatInt(topup, 10))
}

// actualBillable is the settled fine-grained billable-token count for a request's
// usage (0 for nil/failed usage). Fresh input → cache-miss bucket, cache reads →
// cache-hit bucket (see proxy.Usage helpers); each bucket priced by its rate.
func actualBillable(u *proxy.Usage, rates credits.ModelRates) int64 {
	if u == nil {
		return 0
	}
	return credits.BillableTokens(credits.Usage{
		PromptTokens:           int64(u.PromptTokens),
		CompletionTokens:       int64(u.CompletionTokens),
		TotalTokens:            int64(u.TotalTokens),
		PromptCacheHitTokens:   int64(u.CacheReadTokens()),
		PromptCacheMissTokens:  int64(u.FreshInputTokens()),
		PromptCacheWriteTokens: 0, // DeepSeek/DeepInfra don't report a cache-write count today
	}, rates)
}

// creditsFromBillable converts billable tokens to whole credits for the audit
// ledger (rounded; tokensPerCredit<=0 → passthrough).
func creditsFromBillable(billable, tokensPerCredit int64) int64 {
	if tokensPerCredit <= 0 {
		return billable
	}
	return int64(math.Round(float64(billable) / float64(tokensPerCredit)))
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

// releaseTurnForBG refunds one daily turn AND clears the logical-request hold
// out-of-band, so a subsequent retry of the same logical request can reserve
// again (idempotent-by-logical-id accounting). Used on the /v1/proxy path.
func (s *Server) releaseTurnForBG(userID int64, logicalID string) {
	bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.lim.ReleaseTurnFor(bg, userID, logicalID)
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

// periodID is a stable identifier for the current billing period (its end
// instant, as unix seconds). When it changes — a plan renewal/upgrade sets a new
// currentPeriodEnd — the limiter resets the used-credit counter so the renewed
// plan starts fresh instead of inheriting the exhausted count. Empty when there
// is no period (free / no-expiry).
func periodID(pe *time.Time) string {
	if pe == nil {
		return ""
	}
	return strconv.FormatInt(pe.Unix(), 10)
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
// inflightLimiter caps how many hosted STREAMING requests the gateway actively
// processes at once. Streaming holds a full connection chain (client → gateway →
// upstream) open for the whole generation, so a burst of concurrent users can
// otherwise exhaust the origin's connections/FDs/goroutines and drag the whole
// process down — which surfaces to clients as a Cloudflare origin_bad_gateway
// with NO gateway log line, because the saturated origin can no longer accept
// new connections. At capacity we shed IMMEDIATELY with a clean, retryable 503
// (the CLI renders it as the friendly "temporarily unavailable" message) and,
// critically, LOG the rejection so overload is visible instead of silent.
//
// This is a graceful-degradation valve, NOT added capacity: set RAYU_MAX_INFLIGHT
// to a value your instance can sustain (measure with `docker stats`), and scale
// the gateway horizontally for real throughput. 0 = unlimited (disabled).
type inflightLimiter struct {
	sem chan struct{}
	max int
}

func newInflightLimiter(max int) *inflightLimiter {
	if max <= 0 {
		return &inflightLimiter{} // unlimited
	}
	return &inflightLimiter{sem: make(chan struct{}, max), max: max}
}

func (l *inflightLimiter) wrap(next http.HandlerFunc) http.HandlerFunc {
	if l == nil || l.sem == nil {
		return next // unlimited: no wrapper overhead
	}
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case l.sem <- struct{}{}:
			defer func() { <-l.sem }()
			next(w, r)
		default:
			// Saturated: shed fast so the process stays healthy and keeps
			// accepting/logging, rather than collapsing into silent 502s.
			w.Header().Set("Retry-After", "5")
			log.Printf("reject: gateway at capacity (RAYU_MAX_INFLIGHT=%d) path=%s", l.max, r.URL.Path)
			httpx.WriteProviderUnavailable(w, http.StatusServiceUnavailable)
		}
	}
}

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
