package credits

import "math"

// Pay-as-you-go top-up quoting. The gateway quotes a price so the CLI does not
// need a backend round trip (the schema comment on app_settings says exactly
// this: "the gateway reads both so the CLI can quote a price without calling the
// backend"), but it deliberately does NOT grant credits — granting stays in the
// backend's activatePaid so there is a single write path.
//
// Every number below is derived from the admin's live app_settings values
// (creditsPerDollar / minTopupCents) that the entitlements cache refreshes from
// MySQL. Nothing here hardcodes a rate; MaxTopupCredits is an anti-abuse
// validation bound that mirrors the backend's CreateTopupDto @Max, not a price.

// MaxTopupCredits is the ceiling on one purchase, mirroring the backend's
// TOPUP_MAX_CREDITS so a client clamping against the gateway quote cannot build
// a request the backend would reject.
const MaxTopupCredits int64 = 100_000_000

// TopupQuote is the wire shape of GET /v1/credits/topup/quote. Field-for-field
// identical to the backend's GET /payments/topup/quote so a client can use
// either interchangeably.
type TopupQuote struct {
	// Enabled is false when the admin has not turned top-up on
	// (creditsPerDollar = 0); the client should hide the top-up UI.
	Enabled bool `json:"enabled"`
	// Credits is the amount this quote prices, clamped to [MinCredits, MaxCredits].
	Credits int64 `json:"credits"`
	// AmountCents is what those credits cost. 0 when disabled.
	AmountCents int64  `json:"amountCents"`
	Currency    string `json:"currency"`
	// MinCredits is the cheapest payable purchase at the current rate.
	MinCredits int64 `json:"minCredits"`
	// MaxCredits is the validation ceiling on one purchase.
	MaxCredits int64 `json:"maxCredits"`
	// RateCreditsPerDollar and MinTopupCents echo the live settings this quote
	// used, so a client never has to assume either.
	RateCreditsPerDollar int `json:"rateCreditsPerDollar"`
	MinTopupCents        int `json:"minTopupCents"`
	// MeetsMinimum reports whether the REQUESTED amount already cleared the
	// dollar floor. False means it was raised to MinCredits, so a UI can explain
	// the bump instead of silently charging more than the user asked for.
	MeetsMinimum bool `json:"meetsMinimum"`
}

// TopupEnabled reports whether top-up is available: the admin must have set a
// positive credits-per-dollar rate. 0 means "unavailable", per the app_settings
// schema comment.
func TopupEnabled(creditsPerDollar int) bool { return creditsPerDollar > 0 }

// EffectiveMinTopupCents is the dollar floor, never below 1¢: a free "purchase"
// has no payment to confirm, so a 0¢ QR would sit pending forever.
func EffectiveMinTopupCents(minTopupCents int) int {
	if minTopupCents < 1 {
		return 1
	}
	return minTopupCents
}

// TopupAmountCents prices a credit amount. Rounds UP, matching the backend
// exactly, so a buyer never receives credits that were not paid for and the
// quote never undercuts what the backend will charge.
func TopupAmountCents(creditsWanted int64, creditsPerDollar int) int64 {
	if !TopupEnabled(creditsPerDollar) || creditsWanted <= 0 {
		return 0
	}
	return int64(math.Ceil(float64(creditsWanted) / float64(creditsPerDollar) * 100))
}

// MinTopupCredits converts the cents floor into a credit floor at the CURRENT
// rate. Derived on every quote, never cached: the floor is stored in cents while
// the client's input is in credits, so a cached value would go stale the moment
// the admin changed the rate.
func MinTopupCredits(creditsPerDollar, minTopupCents int) int64 {
	if !TopupEnabled(creditsPerDollar) {
		return 0
	}
	cents := EffectiveMinTopupCents(minTopupCents)
	return int64(math.Ceil(float64(cents) / 100 * float64(creditsPerDollar)))
}

// QuoteTopup prices requestedCredits at the live rate. A below-floor request is
// raised to MinCredits (flagged via MeetsMinimum) rather than rejected, so the
// endpoint can always answer with a payable price; the backend still rejects a
// below-floor CREATE outright, because that charges real money.
//
// requestedCredits <= 0 means "no amount chosen yet" and yields the cheapest
// payable purchase, which is what a client needs to render the screen first.
func QuoteTopup(creditsPerDollar, minTopupCents int, requestedCredits int64) TopupQuote {
	minCents := EffectiveMinTopupCents(minTopupCents)
	if !TopupEnabled(creditsPerDollar) {
		return TopupQuote{
			Enabled:       false,
			Currency:      "USD",
			MaxCredits:    MaxTopupCredits,
			MinTopupCents: minCents,
		}
	}

	minCredits := MinTopupCredits(creditsPerDollar, minTopupCents)
	asked := requestedCredits
	if asked <= 0 {
		asked = minCredits
	}
	meetsMinimum := asked >= minCredits
	credits := asked
	if credits < minCredits {
		credits = minCredits
	}
	if credits > MaxTopupCredits {
		credits = MaxTopupCredits
	}

	return TopupQuote{
		Enabled:              true,
		Credits:              credits,
		AmountCents:          TopupAmountCents(credits, creditsPerDollar),
		Currency:             "USD",
		MinCredits:           minCredits,
		MaxCredits:           MaxTopupCredits,
		RateCreditsPerDollar: creditsPerDollar,
		MinTopupCents:        minCents,
		MeetsMinimum:         meetsMinimum,
	}
}
