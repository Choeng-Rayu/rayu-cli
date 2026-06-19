package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

func TestHandleProxyDailyTurnLimitUntagged(t *testing.T) {
	// Relax the SSRF guard so the (never-reached) upstream URL passes validation.
	old := validateUpstreamURL
	validateUpstreamURL = func(string) error { return nil }
	defer func() { validateUpstreamURL = old }()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 7, Status: "active",
			Plan: store.Plan{Code: "free", MaxDailyTurns: i64(1)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, lim := chatHarness(t, fe)
	if _, err := lim.ReserveTurn(context.Background(), 7, 1); err != nil { // exhaust the one turn
		t.Fatalf("seed turn: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy", strings.NewReader(`{"model":"x"}`))
	req.Header.Set("X-Rayu-Token", accessToken(t, 7))
	req.Header.Set("X-Rayu-Upstream-URL", "https://api.example.com/v1/chat/completions")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d, want 429; body=%s", rec.Code, rec.Body.String())
	}
	// CRITICAL: must NOT be tagged as a proxy error, else the CLI fails safe to a
	// direct call and bypasses the cap.
	if got := rec.Header().Get("X-Rayu-Proxy-Error"); got != "" {
		t.Fatalf("daily-limit 429 must not carry X-Rayu-Proxy-Error, got %q", got)
	}
	if rec.Header().Get("X-Rayu-Proxied") != "" {
		t.Fatal("X-Rayu-Proxied must not be set when the request is rejected")
	}
	if rec.Header().Get("X-Rayu-Limit") != "daily_turn_limit" {
		t.Fatalf("expected X-Rayu-Limit=daily_turn_limit, got %q", rec.Header().Get("X-Rayu-Limit"))
	}
	if !strings.Contains(rec.Body.String(), "daily_turn_limit") {
		t.Fatalf("body=%q, want daily_turn_limit", rec.Body.String())
	}
}

func TestHandleProxyUnderCapForwardsAndCounts(t *testing.T) {
	old := validateUpstreamURL
	validateUpstreamURL = func(string) error { return nil }
	defer func() { validateUpstreamURL = old }()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 9, Status: "active",
			Plan: store.Plan{Code: "pro", MaxDailyTurns: i64(5)}, // under cap
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy", strings.NewReader(`{"model":"x"}`))
	req.Header.Set("X-Rayu-Token", accessToken(t, 9))
	req.Header.Set("X-Rayu-Upstream-URL", upstream.URL)
	req.Header.Set("Authorization", "Bearer user-key")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Rayu-Proxied") != "1" {
		t.Fatal("expected X-Rayu-Proxied=1 on a forwarded response")
	}
	if used, _, _ := lim.TurnsToday(context.Background(), 9); used != 1 {
		t.Fatalf("turnsToday=%d, want 1", used)
	}
}
