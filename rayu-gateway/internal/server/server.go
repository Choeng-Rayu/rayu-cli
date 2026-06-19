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

// handleCredits returns the caller's live per-period credit usage, remaining
// allowance (credits + token equivalents), top-up balance, and reset time.
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
		httpx.WriteError(w, http.StatusInternalServerError, "rate limiter unavailable")
		return
	}
	if !rr.OK {
		reset := rr.ResetPeriod
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
		setCreditHeaders(w, rr.UsedPeriod, capPeriod, ent.TopupBalance)
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
	setCreditHeaders(w, rr.UsedPeriod-estCredits+actual, capPeriod, ent.TopupBalance)
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

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		proxyError(w, http.StatusBadRequest, "request body too large or unreadable")
		return
	}
	provider := headerOr(r, "X-Rayu-Provider", "unknown")
	model := bestEffortModel(body)

	// Positive marker so the CLI can distinguish a genuinely-proxied response
	// from anything else — an older gateway without this route (404), a redirect,
	// an error page — and fail safe to a direct call when it is absent.
	w.Header().Set("X-Rayu-Proxied", "1")
	wrote, ferr := proxy.Forward(r.Context(), w, r.Method, upstream, forwardableHeaders(r.Header), body)
	if ferr != nil && !wrote {
		// Upstream unreachable / gateway-side failure before any bytes were sent.
		w.Header().Del("X-Rayu-Proxied")
		proxyError(w, http.StatusBadGateway, "upstream unreachable")
		return
	}

	// Best-effort, fire-and-forget tracking. Never affects the proxied response.
	if s.st != nil {
		go func() {
			bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if e := s.st.InsertUsageEvent(bg, claims.UserID, provider, model, "gateway"); e != nil {
				log.Printf("proxy: usage record failed user=%d provider=%s: %v", claims.UserID, provider, e)
			}
		}()
	}
	log.Printf("proxy: user=%d provider=%s model=%q -> %s", claims.UserID, provider, model, upstream)
}

// proxyError writes a gateway-origin error tagged with X-Rayu-Proxy-Error so the
// CLI can distinguish it from a forwarded upstream response and fall back to a
// direct provider call.
func proxyError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("X-Rayu-Proxy-Error", msg)
	httpx.WriteError(w, status, msg)
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
