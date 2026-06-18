// Package server wires the gateway HTTP routes.
package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/choeng-rayu/rayu-gateway/internal/auth"
	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

const (
	maxRequestBytes  = 8 << 20 // 8 MiB
	defaultMaxTokens = 2048    // estimate fallback when max_tokens is unset
)

// Server holds the gateway dependencies shared across handlers.
type Server struct {
	cfg *config.Config
	ent *entitlements.Cache
	lim *credits.Limiter
	st  *store.Store
}

// New builds the gateway HTTP handler. /healthz is public; everything under
// /v1 requires a valid Rayu access token.
func New(cfg *config.Config, ent *entitlements.Cache, lim *credits.Limiter, st *store.Store) http.Handler {
	s := &Server{cfg: cfg, ent: ent, lim: lim, st: st}

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
		pr.Get("/v1/credits", s.handleCredits)

		pr.Get("/v1/_whoami", s.handleWhoami)
		pr.Get("/v1/_entitlements", s.handleEntitlements)
	})

	return r
}

func (s *Server) handleWhoami(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"userId": claims.UserID, "role": claims.Role})
}

func (s *Server) handleEntitlements(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "entitlement lookup failed")
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
		httpx.WriteError(w, http.StatusInternalServerError, "entitlement lookup failed")
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

// handleCredits returns the caller's live credit usage, remaining allowance,
// top-up balance, and window reset times (for the dashboard + CLI display).
func (s *Server) handleCredits(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "entitlement lookup failed")
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
	capWk := capOrUnlimited(ent.Plan.CreditsPerWeek)
	cap5 := capOrUnlimited(ent.Plan.CreditsPer5h)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"plan":             ent.Plan.Code,
		"creditsPerWeek":   ent.Plan.CreditsPerWeek,
		"creditsPer5h":     ent.Plan.CreditsPer5h,
		"used5h":           st.Used5h,
		"usedWeek":         st.UsedWeek,
		"remaining5h":      remaining(cap5, st.Used5h),
		"remainingWeek":    remaining(capWk, st.UsedWeek),
		"reset5hSeconds":   st.Reset5h,
		"resetWeekSeconds": st.ResetWeek,
		"topupBalance":     topup,
		"topUpEnabled":     ent.Plan.TopUpEnabled,
	})
}

// handleChat reserves credits, proxies the (streaming) completion to the model's
// upstream provider, settles to actual usage, and records the ledger.
func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "entitlement lookup failed")
		return
	}
	if !ent.Active() {
		httpx.WriteError(w, http.StatusForbidden, "account is "+statusOrUnknown(ent.Status))
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "request body too large or unreadable")
		return
	}
	var req map[string]any
	if json.Unmarshal(body, &req) != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid JSON body")
		return
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
		return
	}

	settings := s.ent.Settings()
	if settings.MaxTokensPerRequest > 0 {
		if mt, ok := req["max_tokens"].(float64); ok && int(mt) > settings.MaxTokensPerRequest {
			httpx.WriteError(w, http.StatusBadRequest, "max_tokens exceeds the per-request limit")
			return
		}
	}

	apiKey := s.cfg.KeyForProvider(hm.Provider)
	if apiKey == "" {
		httpx.WriteError(w, http.StatusInternalServerError, "provider key not configured")
		return
	}

	// --- Credit reserve (pre-flight) ---
	baseline := settings.BaselineCreditsPer1M
	mult := hm.CreditMultiplier
	capWeek := capOrUnlimited(ent.Plan.CreditsPerWeek)
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
		Cap5h:         capOrUnlimited(ent.Plan.CreditsPer5h),
		CapWeek:       capWeek,
		MaxConcurrent: settings.MaxConcurrentStreams,
		MaxReq5h:      settings.MaxRequestsPer5h,
		TopUpEnabled:  topUpAvailable,
	})
	if rerr != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "rate limiter unavailable")
		return
	}
	if !rr.OK {
		reset := rr.ResetWeek
		if rr.Reason != "weekly_limit" {
			reset = rr.Reset5h
		}
		if reset > 0 {
			w.Header().Set("Retry-After", strconv.FormatInt(reset, 10))
		}
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        map[string]any{"message": "credit limit reached: " + rr.Reason, "type": "rate_limit_exceeded"},
			"reason":       rr.Reason,
			"resetSeconds": reset,
		})
		return
	}

	source := rr.Source
	settled := false
	settle := func(usage *proxy.Usage) int64 {
		actual := actualCredits(usage, baseline, mult)
		if !settled {
			settled = true
			bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = s.lim.Settle(bg, claims.UserID, source, estCredits, actual)
			s.ent.Invalidate(claims.UserID)
			log.Printf("chat done: user=%d model=%s charged=%d (est %d) via=%s",
				claims.UserID, hm.Code, actual, estCredits, source)
			if usage != nil {
				s.recordLedger(claims.UserID, *hm, usage, actual, source)
			}
		}
		return actual
	}

	stream, _ := req["stream"].(bool)
	log.Printf("chat: user=%d model=%s stream=%v reserved=%d via=%s",
		claims.UserID, hm.Code, stream, estCredits, source)
	req["model"] = hm.UpstreamModelID
	if stream {
		req["stream_options"] = map[string]any{"include_usage": true}
	}
	newBody, _ := json.Marshal(req)
	upstreamURL := strings.TrimRight(hm.UpstreamBaseURL, "/") + "/chat/completions"

	if stream {
		// Best-effort headers before the stream starts (exact figures via /v1/credits).
		setCreditHeaders(w, rr.UsedWeek, capWeek, ent.TopupBalance)
		usage, wrote, serr := proxy.Stream(r.Context(), w, upstreamURL, apiKey, newBody)
		settle(usage)
		if serr != nil && !wrote {
			httpx.WriteError(w, http.StatusBadGateway, "upstream error")
		}
		return
	}

	usage, status, respBody, cerr := proxy.Complete(r.Context(), upstreamURL, apiKey, newBody)
	if cerr != nil {
		settle(nil)
		httpx.WriteError(w, http.StatusBadGateway, "upstream error")
		return
	}
	actual := settle(usage)
	setCreditHeaders(w, rr.UsedWeek-estCredits+actual, capWeek, ent.TopupBalance)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(respBody)
}

// recordLedger writes the durable consumption row asynchronously.
func (s *Server) recordLedger(userID int64, m store.HostedModel, u *proxy.Usage, creditsConsumed int64, source string) {
	cost := float64(u.PromptTokens)/1e6*float64(m.InputPricePer1MCents) +
		float64(u.CompletionTokens)/1e6*float64(m.OutputPricePer1MCents)
	realCostCents := int(math.Round(cost))
	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.st.InsertLedger(bg, userID, m.Code, u.PromptTokens, u.CompletionTokens, creditsConsumed, realCostCents, source)
	}()
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

func actualCredits(u *proxy.Usage, baseline int, mult float64) int64 {
	if u == nil {
		return 0
	}
	return credits.ForTokens(int64(u.TotalTokens), baseline, mult)
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

func statusOrUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
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
