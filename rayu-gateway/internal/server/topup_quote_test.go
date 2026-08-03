package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// topupQuoteBody is the wire contract of GET /v1/credits/topup/quote. It must
// match the backend's GET /payments/topup/quote field for field so a client can
// use either.
type topupQuoteBody struct {
	Enabled              bool   `json:"enabled"`
	Credits              int64  `json:"credits"`
	AmountCents          int64  `json:"amountCents"`
	Currency             string `json:"currency"`
	MinCredits           int64  `json:"minCredits"`
	MaxCredits           int64  `json:"maxCredits"`
	RateCreditsPerDollar int    `json:"rateCreditsPerDollar"`
	MinTopupCents        int    `json:"minTopupCents"`
	MeetsMinimum         bool   `json:"meetsMinimum"`
	TopUpEnabled         bool   `json:"topUpEnabled"`
}

func topupQuoteEnt(settings store.AppSettings) *fakeEnt {
	return &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 31, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", TopUpEnabled: true},
		},
		settings: settings,
	}
}

func getTopupQuote(t *testing.T, h http.Handler, query string) (int, topupQuoteBody) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/credits/topup/quote"+query, nil)
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 31))
	h.ServeHTTP(rec, req)
	var body topupQuoteBody
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
		}
	}
	return rec.Code, body
}

// The CLI quotes from this endpoint instead of hardcoding a rate, so it must
// report the admin's configured rate and the price derived from it verbatim.
func TestHandleTopupQuoteReturnsTheLiveRate(t *testing.T) {
	fe := topupQuoteEnt(store.AppSettings{
		BaselineCreditsPer1M: 1000,
		CreditsPerDollar:     1000,
		MinTopupCents:        100,
	})
	h, _ := chatHarness(t, fe)

	code, body := getTopupQuote(t, h, "?credits=5000")
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if !body.Enabled {
		t.Error("enabled=false, want true at a positive rate")
	}
	if body.Credits != 5000 || body.AmountCents != 500 {
		t.Fatalf("credits=%d amountCents=%d, want 5000 and 500", body.Credits, body.AmountCents)
	}
	if body.RateCreditsPerDollar != 1000 || body.MinTopupCents != 100 {
		t.Fatalf("rate=%d minTopupCents=%d, want 1000 and 100",
			body.RateCreditsPerDollar, body.MinTopupCents)
	}
	if body.Currency != "USD" {
		t.Fatalf("currency=%q, want USD", body.Currency)
	}
	if !body.MeetsMinimum {
		t.Error("meetsMinimum=false for an above-floor request, want true")
	}
	if !body.TopUpEnabled {
		t.Error("topUpEnabled=false, want the plan's flag echoed")
	}
}

// An admin rate change must reach the quote through the normal config snapshot —
// no redeploy, no code change. onReload stands in for the refresh reading the
// newer app_settings row.
func TestHandleTopupQuoteFollowsAnAdminRateChange(t *testing.T) {
	fe := topupQuoteEnt(store.AppSettings{
		BaselineCreditsPer1M: 1000,
		CreditsPerDollar:     1000,
		MinTopupCents:        100,
	})
	h, _ := chatHarness(t, fe)

	_, before := getTopupQuote(t, h, "?credits=5000")
	if before.AmountCents != 500 {
		t.Fatalf("amountCents=%d, want 500", before.AmountCents)
	}

	// Admin halves the credits per dollar; the snapshot picks it up.
	fe.settings.CreditsPerDollar = 500
	_, after := getTopupQuote(t, h, "?credits=5000")
	if after.AmountCents != 1000 {
		t.Fatalf("amountCents=%d after halving the rate, want 1000", after.AmountCents)
	}
	// The derived credit floor moves with the rate; it is never cached across a change.
	if before.MinCredits != 1000 || after.MinCredits != 500 {
		t.Fatalf("minCredits before=%d after=%d, want 1000 and 500",
			before.MinCredits, after.MinCredits)
	}
}

// minTopupCents is stored in cents while the client's input is in credits, so the
// endpoint must publish the floor as a credit amount the client can clamp to.
func TestHandleTopupQuoteClampsToMinTopupCents(t *testing.T) {
	fe := topupQuoteEnt(store.AppSettings{
		BaselineCreditsPer1M: 1000,
		CreditsPerDollar:     1000,
		MinTopupCents:        250,
	})
	h, _ := chatHarness(t, fe)

	_, body := getTopupQuote(t, h, "?credits=10")
	if body.MinCredits != 2500 {
		t.Fatalf("minCredits=%d, want 2500 ($2.50 at 1000/$)", body.MinCredits)
	}
	// The below-floor request is quoted at the floor and flagged, so the UI can
	// explain the bump instead of silently charging more than was asked for.
	if body.MeetsMinimum {
		t.Error("meetsMinimum=true for a below-floor request, want false")
	}
	if body.Credits != 2500 || body.AmountCents != 250 {
		t.Fatalf("credits=%d amountCents=%d, want 2500 and 250", body.Credits, body.AmountCents)
	}
}

// Omitting (or garbling) the credits param means "no amount chosen yet": answer
// with the cheapest payable purchase rather than a 400, so the CLI can render the
// screen before the user types anything.
func TestHandleTopupQuoteDefaultsWithoutACreditsParam(t *testing.T) {
	fe := topupQuoteEnt(store.AppSettings{
		BaselineCreditsPer1M: 1000,
		CreditsPerDollar:     1000,
		MinTopupCents:        100,
	})
	h, _ := chatHarness(t, fe)

	for _, query := range []string{"", "?credits=", "?credits=abc", "?credits=0", "?credits=-5"} {
		code, body := getTopupQuote(t, h, query)
		if code != http.StatusOK {
			t.Fatalf("query %q: status=%d, want 200", query, code)
		}
		if body.Credits != 1000 || body.AmountCents != 100 {
			t.Fatalf("query %q: credits=%d amountCents=%d, want the 1000-credit floor at 100¢",
				query, body.Credits, body.AmountCents)
		}
	}
}

// Rate 0 = the admin switched top-up off. Say so explicitly; a $0 price would
// invite the client to offer a purchase that the backend will reject.
func TestHandleTopupQuoteReportsDisabledWhenTheRateIsZero(t *testing.T) {
	fe := topupQuoteEnt(store.AppSettings{
		BaselineCreditsPer1M: 1000,
		CreditsPerDollar:     0,
		MinTopupCents:        100,
	})
	h, _ := chatHarness(t, fe)

	code, body := getTopupQuote(t, h, "?credits=5000")
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if body.Enabled {
		t.Error("enabled=true at rate 0, want false")
	}
	if body.Credits != 0 || body.AmountCents != 0 || body.MinCredits != 0 {
		t.Fatalf("disabled quote leaked non-zero values: %+v", body)
	}
}

// The quote endpoint must be authenticated (it reveals commercial config) and
// must refuse a suspended account like every other entitlement-gated route.
func TestHandleTopupQuoteRequiresAnActiveAccount(t *testing.T) {
	fe := topupQuoteEnt(store.AppSettings{CreditsPerDollar: 1000, MinTopupCents: 100})
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/credits/topup/quote", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d, want 401", rec.Code)
	}

	fe.ent.Status = "suspended"
	code, _ := getTopupQuote(t, h, "")
	if code != http.StatusForbidden {
		t.Fatalf("suspended status=%d, want 403", code)
	}
}
