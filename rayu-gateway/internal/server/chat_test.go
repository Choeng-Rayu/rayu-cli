package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

func i64(v int64) *int64 { return &v }

// fakeEnt is an in-memory entSource for handler tests (no live MySQL).
type fakeEnt struct {
	ent      entitlements.Entitlement
	settings store.AppSettings
}

func (f *fakeEnt) Resolve(context.Context, int64) (entitlements.Entitlement, error) {
	return f.ent, nil
}
func (f *fakeEnt) Settings() store.AppSettings { return f.settings }
func (f *fakeEnt) Invalidate(int64)            {}

// chatHarness builds the full router with a fake entSource + miniredis limiter.
func chatHarness(t *testing.T, fe *fakeEnt) (http.Handler, *credits.Limiter) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	lim := credits.NewLimiter(rdb)
	cfg := &config.Config{JWTSecret: testSecret, ProviderKeys: map[string]string{"deepseek": "sk-test"}}
	return New(cfg, fe, lim, nil), lim
}

func TestHandleChatDailyTurnLimit(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 7,
			Status: "active",
			Plan:   store.Plan{Code: "free", Name: "Free", MaxDailyTurns: i64(1)},
			AllowedModels: []store.HostedModel{
				{Code: "m1", Provider: "deepseek", Enabled: true, CreditMultiplier: 1},
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
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m1"}`))
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

func TestHandleChatUnderCapCountsTurn(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`))
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 8,
			Status: "active",
			Plan:   store.Plan{Code: "pro", Name: "Pro", MaxDailyTurns: i64(5)}, // under cap
			AllowedModels: []store.HostedModel{
				{Code: "m1", Provider: "deepseek", Enabled: true, CreditMultiplier: 1,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "real-model"},
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m1"}`))
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

// TestHandleChatBillsCacheHitTokensAtDiscount is a regression test for the
// "two prompts, 24M of 50M tokens" class of report: a DeepSeek-style response
// reporting mostly prompt_cache_hit_tokens (typical of an agentic follow-up
// call that resends a huge, already-billed conversation history) must be
// charged at credits.CacheHitBillingWeight, not at full price.
func TestHandleChatBillsCacheHitTokensAtDiscount(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":10000000,"completion_tokens":0,"total_tokens":10000000,"prompt_cache_hit_tokens":10000000,"prompt_cache_miss_tokens":0}}`))
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 42,
			Status: "active",
			Plan:   store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				{Code: "m1", Provider: "deepseek", Enabled: true, CreditMultiplier: 1,
					UpstreamBaseURL: upstream.URL, UpstreamModelID: "real-model"},
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 10},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m1"}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 42))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	st, err := lim.Status(context.Background(), 42)
	if err != nil {
		t.Fatalf("lim.Status: %v", err)
	}
	// Naive (pre-fix) billing would have charged ForTokens(10_000_000, 10, 1) = 100
	// credits — double the entire 50-credit Pro allowance from ONE request. With
	// the cache-hit discount, 10,000,000 all-cache-hit tokens bill as if they
	// were 1,000,000 tokens: ceil(1 * 10 * 1) = 10 credits.
	if st.UsedPeriod != 10 {
		t.Fatalf("usedPeriod=%d, want 10 (cache-hit-discounted), naive-bug value would be 100", st.UsedPeriod)
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
