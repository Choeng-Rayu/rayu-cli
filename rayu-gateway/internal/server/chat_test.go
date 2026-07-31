package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

func i64(v int64) *int64 { return &v }

// Provider ids used by the test helpers below. Any test that needs two different
// providers in one entitlement relies on these being distinct.
const (
	provIDDeepSeek int64 = 1
	provIDLongCat  int64 = 2
	provIDOllama   int64 = 3
	// provIDOpenRouter is a translated (non-Anthropic) upstream.
	provIDOpenRouter int64 = 9
)

// testProviderKeys is the decrypted key each provider has in the harness, keyed
// by provider id. It stands in for what entitlements.Cache loads from
// provider_api_keys and decrypts once per refresh — the request path only ever
// sees these in-memory values.
var testProviderKeys = map[int64]string{
	provIDDeepSeek:   "sk-test",
	provIDLongCat:    "sk-longcat",
	provIDOllama:     "sk-ollama",
	provIDOpenRouter: "sk-or-test",
}

// deepseekProvider / longcatProvider / ollamaProvider mirror the seeded registry
// rows (see the backend's PROVIDER_SEED + migration 0000000000009_providers), so
// handler tests assert against the SAME wire config production loads from MySQL.
func deepseekProvider(baseURL string) store.Provider {
	return store.Provider{
		ID: provIDDeepSeek, Name: "deepseek", Label: "DeepSeek",
		Format: providercfg.FormatAnthropicMessages, BaseURL: baseURL,
		EndpointPath: "/anthropic/v1/messages", AuthScheme: providercfg.AuthXAPIKey,
		Enabled: true,
	}
}

func longcatProvider(baseURL string) store.Provider {
	return store.Provider{
		ID: provIDLongCat, Name: "longcat", Label: "LongCat",
		Format: providercfg.FormatAnthropicMessages, BaseURL: baseURL,
		EndpointPath: "/anthropic/v1/messages", AuthScheme: providercfg.AuthBearer,
		Enabled: true,
	}
}

func ollamaProvider(baseURL string) store.Provider {
	return store.Provider{
		ID: provIDOllama, Name: "rayu-ollama", Label: "Ollama Cloud",
		Format: providercfg.FormatAnthropicMessages, BaseURL: baseURL,
		EndpointPath: "/v1/messages", AuthScheme: providercfg.AuthBearer,
		Enabled: true,
	}
}

// hostedModel wires a model to a provider row. Capabilities default to permissive
// so a test that isn't about capabilities isn't affected by the capability gate.
//
// The four credit charges mirror the DATABASE defaults an admin-created model
// gets (output == input, cache-read 0.10 absolute, cache-write == input), so a
// test that isn't about pricing bills the same way production does.
func hostedModel(code string, p store.Provider, upstreamID string, mult float64) store.HostedModel {
	return store.HostedModel{
		Code: code, Label: code, ProviderID: p.ID, Provider: p,
		UpstreamModelID: upstreamID, Enabled: true,
		CreditMultiplier:           mult,
		OutputCreditMultiplier:     mult,
		CacheReadCreditMultiplier:  credits.CacheHitBillingWeight,
		CacheWriteCreditMultiplier: mult,
		SupportsReasoning:          true, SupportsImage: true, SupportsTools: true,
	}
}

// fakeEnt is an in-memory entSource for handler tests (no live MySQL).
type fakeEnt struct {
	ent      entitlements.Entitlement
	settings store.AppSettings
	// catalog overrides "the whole hosted catalog" for admin paths that are not
	// limited to a user's plan (nil = use the entitlement's allowed models).
	catalog []store.HostedModel
	// providerKeys overrides testProviderKeys per provider id: use it to give a
	// provider several keys (rotation) or none at all (unconfigured provider).
	// An empty (non-nil) slice means "this provider has no keys".
	providerKeys map[int64][]providerkeys.Key
	// reg is built lazily from providerKeys/testProviderKeys and then reused, so
	// health recorded during a request survives to the assertions.
	reg     *providerkeys.Registry
	regOnce sync.Once
	// onReload stands in for a config refresh reading newer database rows, and
	// reloads counts how often an admin path asked for one (it must never happen
	// on the request path).
	onReload func(*fakeEnt)
	reloads  int
	// reloadErr makes the refresh fail, standing in for an unreachable database.
	reloadErr error
	// invalidated records the user ids dropped from the entitlement cache.
	invalidated []int64
	// disabledProviders forces a provider row's kill switch off in the resolved
	// route, without the test having to restate the whole row.
	disabledProviders map[string]bool
	// strictRoutes resolves routes with AllowInsecure=false, i.e. exactly as
	// PRODUCTION does. Tests that use an httptest upstream (http://127.0.0.1)
	// leave it false; tests asserting the SSRF/plaintext guards set it true.
	strictRoutes bool
}

func (f *fakeEnt) Resolve(context.Context, int64) (entitlements.Entitlement, error) {
	return f.ent, nil
}
func (f *fakeEnt) Settings() store.AppSettings { return f.settings }

// Invalidate records which users were dropped from the entitlement cache, so a
// test can prove a per-user change (plan switch, suspension) took effect without
// waiting for the TTL.
func (f *fakeEnt) Invalidate(userID int64) {
	f.invalidated = append(f.invalidated, userID)
}

// Reload records the call and applies the test's onReload hook, standing in for
// the config refresh picking up rows written since the last snapshot.
func (f *fakeEnt) Reload(context.Context) error {
	f.reloads++
	if f.reloadErr != nil {
		return f.reloadErr
	}
	if f.onReload != nil {
		f.onReload(f)
	}
	return nil
}

// Models is the whole catalog. The harness has no separate catalog, so the
// entitlement's models stand in — plus any extra ones a test declares for the
// admin paths (which can reach models no plan allows).
func (f *fakeEnt) Models() []store.HostedModel {
	if f.catalog != nil {
		return f.catalog
	}
	return f.ent.AllowedModels
}

// keysFor is the provider's key set: the test's override, or a single default
// key so the common case needs no setup.
func (f *fakeEnt) keysFor(providerID int64) []providerkeys.Key {
	if f.providerKeys != nil {
		if ks, ok := f.providerKeys[providerID]; ok {
			return ks
		}
	}
	secret, ok := testProviderKeys[providerID]
	if !ok {
		return nil
	}
	return []providerkeys.Key{{
		ID: providerID * 100, Secret: secret, Masked: "sk-***",
		Priority: 0, Enabled: true, Status: providerkeys.StatusActive,
	}}
}

// Keys returns the live registry, loaded once from the harness's key set exactly
// as the real cache loads it after decrypting.
func (f *fakeEnt) Keys() *providerkeys.Registry {
	f.regOnce.Do(func() {
		f.reg = providerkeys.New(nil)
		seen := map[int64]bool{}
		for _, m := range f.ent.AllowedModels {
			if seen[m.ProviderID] {
				continue
			}
			seen[m.ProviderID] = true
			f.reg.Replace(m.ProviderID, f.keysFor(m.ProviderID))
		}
		for id := range f.providerKeys {
			if !seen[id] {
				f.reg.Replace(id, f.keysFor(id))
			}
		}
	})
	return f.reg
}

// Route resolves a provider row through the REAL providercfg.Build, so the tests
// exercise production's validation/key-resolution rather than a stub of it.
// AllowInsecure is on because httptest upstreams are http://127.0.0.1.
func (f *fakeEnt) Route(providerID int64) (entitlements.ProviderRoute, bool) {
	for _, m := range f.ent.AllowedModels {
		if m.ProviderID != providerID {
			continue
		}
		enabled := m.Provider.Enabled && !f.disabledProviders[m.Provider.Name]
		route, err := providercfg.Build(providercfg.Row{
			Name:         m.Provider.Name,
			Format:       m.Provider.Format,
			BaseURL:      m.Provider.BaseURL,
			EndpointPath: m.Provider.EndpointPath,
			AuthScheme:   m.Provider.AuthScheme,
			Enabled:      enabled,
			KeyCount:     len(f.keysFor(providerID)),
		}, providercfg.Options{
			AllowInsecure: !f.strictRoutes,
		})
		return entitlements.ProviderRoute{Route: route, Err: err}, true
	}
	return entitlements.ProviderRoute{}, false
}

func (f *fakeEnt) Routes() map[int64]entitlements.ProviderRoute {
	out := map[int64]entitlements.ProviderRoute{}
	for _, m := range f.ent.AllowedModels {
		if r, ok := f.Route(m.ProviderID); ok {
			out[m.ProviderID] = r
		}
	}
	return out
}

// chatHarness builds the full router with a fake entSource + miniredis limiter.
func chatHarness(t *testing.T, fe *fakeEnt) (http.Handler, *credits.Limiter) {
	return chatHarnessCfg(t, fe, &config.Config{JWTSecret: testSecret})
}

// chatHarnessCfg is chatHarness with a caller-supplied config.
// JWTSecret defaults to testSecret when unset.
func chatHarnessCfg(t *testing.T, fe *fakeEnt, cfg *config.Config) (http.Handler, *credits.Limiter) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	lim := credits.NewLimiter(rdb)
	if cfg.JWTSecret == "" {
		cfg.JWTSecret = testSecret
	}
	return New(cfg, fe, lim, nil, nil), lim
}

// TestRetiredChatCompletionsIngress locks in the retirement of the OpenAI-shaped
// hosted ingress: an already-published CLI that still POSTs there must get an
// actionable 410 (NOT a bare 404, and NOT a silently working endpoint), and the
// call must cost nothing — no upstream call, no credits, no daily turn.
func TestRetiredChatCompletionsIngress(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("retired ingress must not reach any upstream")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50), MaxDailyTurns: i64(5)},
			AllowedModels: []store.HostedModel{
				hostedModel("m1", deepseekProvider(upstream.URL), "real-model", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m1","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 77))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusGone {
		t.Fatalf("status=%d want 410 Gone; body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	// The message must tell the user what to DO, and where hosted models moved.
	if !strings.Contains(strings.ToLower(body.Error.Message), "update rayu-cli") ||
		!strings.Contains(body.Error.Message, "/anthropic/v1/messages") {
		t.Errorf("unhelpful retirement message: %q", body.Error.Message)
	}
	st, err := lim.Status(context.Background(), 77)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d want 0 (retired ingress must not bill)", st.UsedPeriod)
	}
	if used, _, _ := lim.TurnsToday(context.Background(), 77); used != 0 {
		t.Fatalf("turnsToday=%d want 0 (retired ingress must not burn a turn)", used)
	}
}

// The retired ingress still requires auth: it must not become an unauthenticated
// endpoint just because it no longer does any work.
func TestRetiredChatCompletionsRequiresAuth(t *testing.T) {
	fe := &fakeEnt{
		ent:      entitlements.Entitlement{UserID: 78, Status: "active"},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want 401 without a token", rec.Code)
	}
}

func TestHostedDailyTurnLimit(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 7,
			Status: "active",
			Plan:   store.Plan{Code: "free", Name: "Free", MaxDailyTurns: i64(1)},
			AllowedModels: []store.HostedModel{
				hostedModel("m1", deepseekProvider("https://unused.example"), "m1", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, lim := chatHarness(t, fe)

	// Exhaust the single allowed daily turn directly via the limiter.
	if _, err := lim.ReserveTurn(context.Background(), 7, 1); err != nil {
		t.Fatalf("seed turn: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"m1","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 7))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d, want 429; body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Reason       string `json:"reason"`
		ResetSeconds int64  `json:"resetSeconds"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Reason != "daily_turn_limit" {
		t.Fatalf("reason=%q, want daily_turn_limit", body.Reason)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After header on daily-limit 429")
	}
}

func TestHostedUnderCapCountsTurn(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":5,"output_tokens":3}}`))
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 8,
			Status: "active",
			Plan:   store.Plan{Code: "pro", Name: "Pro", MaxDailyTurns: i64(5)}, // under cap
			AllowedModels: []store.HostedModel{
				hostedModel("m1", deepseekProvider(upstream.URL), "real-model", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"m1","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 8))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// The successful request must have counted exactly one daily turn.
	used, reset, _ := lim.TurnsToday(context.Background(), 8)
	if used != 1 {
		t.Fatalf("turnsToday=%d, want 1", used)
	}
	if reset <= 0 {
		t.Fatalf("resetSeconds=%d, want >0", reset)
	}
}

// TestHostedBillsCacheHitTokensAtDiscount is a regression test for the
// "two prompts, 24M of 50M tokens" class of report: a response reporting mostly
// cache-hit prompt tokens (typical of an agentic follow-up call that resends a
// huge, already-billed conversation history) must be charged at
// credits.CacheHitBillingWeight, not at full price.
func TestHostedBillsCacheHitTokensAtDiscount(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":10000000}}`))
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 42,
			Status: "active",
			Plan:   store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("m1", deepseekProvider(upstream.URL), "real-model", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 10},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"m1","max_tokens":16}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 42))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	st, err := lim.Status(context.Background(), 42)
	if err != nil {
		t.Fatalf("lim.Status: %v", err)
	}
	// Fine-grained billable tokens: 10,000,000 all-cache-hit tokens ×
	// CacheHitBillingWeight(0.10) = 1,000,000 billable tokens (≈10 credits at
	// baseline 10). Naive no-cache billing would be 10,000,000 billable (~100
	// credits — 2× the whole 50-credit allowance from one request).
	if st.UsedPeriod != 1_000_000 {
		t.Fatalf("usedPeriod=%d billable tokens, want 1_000_000 (cache-discounted)", st.UsedPeriod)
	}
}

func TestHandleCreditsReportsDailyTurns(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 11, Status: "active",
			Plan: store.Plan{Code: "free", Name: "Free", MaxDailyTurns: i64(50)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, lim := chatHarness(t, fe)
	// Use 2 of 50 turns.
	_, _ = lim.ReserveTurn(context.Background(), 11, 50)
	_, _ = lim.ReserveTurn(context.Background(), 11, 50)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/credits", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 11))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		MaxDailyTurns     *int64 `json:"maxDailyTurns"`
		TurnsUsedToday    int64  `json:"turnsUsedToday"`
		TurnsRemaining    *int64 `json:"turnsRemaining"`
		TurnsResetSeconds int64  `json:"turnsResetSeconds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.MaxDailyTurns == nil || *body.MaxDailyTurns != 50 {
		t.Fatalf("maxDailyTurns=%v, want 50", body.MaxDailyTurns)
	}
	if body.TurnsUsedToday != 2 {
		t.Fatalf("turnsUsedToday=%d, want 2", body.TurnsUsedToday)
	}
	if body.TurnsRemaining == nil || *body.TurnsRemaining != 48 {
		t.Fatalf("turnsRemaining=%v, want 48", body.TurnsRemaining)
	}
	if body.TurnsResetSeconds <= 0 {
		t.Fatalf("turnsResetSeconds=%d, want >0", body.TurnsResetSeconds)
	}
}

// The CLI and dashboard quote the top-up price from this endpoint rather than
// hardcoding a rate, so /v1/credits must report the admin's configured rate and
// minimum verbatim.
func TestHandleCreditsReportsTheTopupRate(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 12, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", TopUpEnabled: true},
		},
		settings: store.AppSettings{
			BaselineCreditsPer1M: 1000,
			CreditsPerDollar:     5,
			MinTopupCents:        100,
		},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/credits", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 12))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		TopUpEnabled     bool `json:"topUpEnabled"`
		CreditsPerDollar int  `json:"creditsPerDollar"`
		MinTopupCents    int  `json:"minTopupCents"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.TopUpEnabled {
		t.Error("topUpEnabled=false, want true")
	}
	if body.CreditsPerDollar != 5 || body.MinTopupCents != 100 {
		t.Fatalf("creditsPerDollar=%d minTopupCents=%d, want 5 and 100",
			body.CreditsPerDollar, body.MinTopupCents)
	}
}

func TestHandleModelsReturnsAllowedForPro(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 21, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{
				{Code: "deepseek-v4-flash", Label: "DeepSeek V4 Flash", Enabled: true, CreditMultiplier: 0.33},
				{Code: "deepseek-v4-pro", Label: "DeepSeek V4 Pro", Enabled: true, CreditMultiplier: 1},
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 21))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ids := make([]string, 0, len(body.Data))
	for _, m := range body.Data {
		ids = append(ids, m.ID)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 hosted models for pro, got %v", ids)
	}
}
