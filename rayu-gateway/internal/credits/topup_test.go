package credits

import "testing"

// Every case feeds the rate in as DATA. If any of these could pass with a rate
// baked into the package, the package would be hardcoding a price — which is the
// one thing the top-up design forbids.

func TestTopupEnabledIsOffAtRateZero(t *testing.T) {
	tests := []struct {
		name             string
		creditsPerDollar int
		want             bool
	}{
		{"admin has not enabled top-up", 0, false},
		{"nonsense negative rate", -5, false},
		{"smallest positive rate", 1, true},
		{"typical rate", 1000, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := TopupEnabled(tc.creditsPerDollar); got != tc.want {
				t.Fatalf("TopupEnabled(%d)=%v, want %v", tc.creditsPerDollar, got, tc.want)
			}
		})
	}
}

func TestEffectiveMinTopupCentsNeverAllowsAFreePurchase(t *testing.T) {
	tests := []struct {
		name  string
		given int
		want  int
	}{
		{"admin floor used verbatim", 250, 250},
		{"default floor", 100, 100},
		// A 0¢ purchase has no payment to confirm, so the QR would sit pending
		// forever — clamp to 1¢ instead.
		{"zero clamps to one cent", 0, 1},
		{"negative clamps to one cent", -100, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := EffectiveMinTopupCents(tc.given); got != tc.want {
				t.Fatalf("EffectiveMinTopupCents(%d)=%d, want %d", tc.given, got, tc.want)
			}
		})
	}
}

func TestTopupAmountCentsRoundsUp(t *testing.T) {
	tests := []struct {
		name             string
		credits          int64
		creditsPerDollar int
		want             int64
	}{
		{"exact dollar", 1000, 1000, 100},
		{"five dollars", 5000, 1000, 500},
		// 5 credits at 3/$ is $1.6667: must be 167¢, not 166¢, or the buyer gets
		// credits they did not pay for.
		{"rounds up, never down", 5, 3, 167},
		{"disabled prices at zero", 5000, 0, 0},
		{"zero credits cost nothing", 0, 1000, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := TopupAmountCents(tc.credits, tc.creditsPerDollar)
			if got != tc.want {
				t.Fatalf("TopupAmountCents(%d, %d)=%d, want %d",
					tc.credits, tc.creditsPerDollar, got, tc.want)
			}
		})
	}
}

func TestMinTopupCreditsIsDerivedFromTheLiveRate(t *testing.T) {
	tests := []struct {
		name             string
		creditsPerDollar int
		minTopupCents    int
		want             int64
	}{
		{"$1 floor at 1000/$", 1000, 100, 1000},
		{"$2.50 floor at 1000/$", 1000, 250, 2500},
		{"$1 floor at 5/$", 5, 100, 5},
		{"1¢ floor at 1000/$ rounds up", 1000, 1, 10},
		{"disabled has no floor", 0, 100, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := MinTopupCredits(tc.creditsPerDollar, tc.minTopupCents)
			if got != tc.want {
				t.Fatalf("MinTopupCredits(%d, %d)=%d, want %d",
					tc.creditsPerDollar, tc.minTopupCents, got, tc.want)
			}
		})
	}
}

// Buying exactly MinCredits must always cost at least the floor. If rounding went
// the other way anywhere, the backend would reject a purchase the gateway just
// told the client was the minimum.
func TestMinTopupCreditsAlwaysClearsTheFloor(t *testing.T) {
	for _, rate := range []int{1, 3, 5, 7, 100, 999, 1000} {
		for _, floor := range []int{1, 50, 100, 250, 999} {
			credits := MinTopupCredits(rate, floor)
			cents := TopupAmountCents(credits, rate)
			minCents := int64(EffectiveMinTopupCents(floor))
			if cents < minCents {
				t.Fatalf("rate=%d floor=%d: minCredits=%d costs %d¢, below the %d¢ floor",
					rate, floor, credits, cents, minCents)
			}
		}
	}
}

func TestQuoteTopupPricesFromTheLiveRate(t *testing.T) {
	q := QuoteTopup(1000, 100, 5000)
	if !q.Enabled {
		t.Fatal("enabled=false, want true at a positive rate")
	}
	if q.Credits != 5000 || q.AmountCents != 500 {
		t.Fatalf("credits=%d amountCents=%d, want 5000 and 500", q.Credits, q.AmountCents)
	}
	// The rate and floor are echoed so a client never has to assume one.
	if q.RateCreditsPerDollar != 1000 || q.MinTopupCents != 100 {
		t.Fatalf("rate=%d minTopupCents=%d, want 1000 and 100",
			q.RateCreditsPerDollar, q.MinTopupCents)
	}
	if q.MinCredits != 1000 || q.MaxCredits != MaxTopupCredits {
		t.Fatalf("minCredits=%d maxCredits=%d, want 1000 and %d",
			q.MinCredits, q.MaxCredits, MaxTopupCredits)
	}
	if q.Currency != "USD" || !q.MeetsMinimum {
		t.Fatalf("currency=%q meetsMinimum=%v, want USD and true", q.Currency, q.MeetsMinimum)
	}
}

// An admin rate change must re-price with no code change and no redeploy — the
// whole point of keeping the rate in app_settings.
func TestQuoteTopupRepricesWhenTheAdminChangesTheRate(t *testing.T) {
	before := QuoteTopup(1000, 100, 5000)
	after := QuoteTopup(500, 100, 5000)
	if before.AmountCents != 500 {
		t.Fatalf("before=%d¢, want 500", before.AmountCents)
	}
	if after.AmountCents != 1000 {
		t.Fatalf("after halving the rate=%d¢, want 1000", after.AmountCents)
	}
	// And the derived credit floor moves with it, never cached across the change.
	if before.MinCredits != 1000 || after.MinCredits != 500 {
		t.Fatalf("minCredits before=%d after=%d, want 1000 and 500",
			before.MinCredits, after.MinCredits)
	}
}

func TestQuoteTopupClampsToTheFloorAndFlagsTheBump(t *testing.T) {
	q := QuoteTopup(1000, 100, 10)
	if q.MeetsMinimum {
		t.Fatal("meetsMinimum=true for a below-floor request, want false")
	}
	if q.Credits != 1000 || q.AmountCents != 100 {
		t.Fatalf("credits=%d amountCents=%d, want 1000 and 100 (raised to the floor)",
			q.Credits, q.AmountCents)
	}
}

func TestQuoteTopupDefaultsToTheCheapestPayableAmount(t *testing.T) {
	for _, asked := range []int64{0, -1} {
		q := QuoteTopup(1000, 100, asked)
		if q.Credits != 1000 || q.AmountCents != 100 {
			t.Fatalf("credits=%d asked=%d amountCents=%d, want the 1000-credit floor at 100¢",
				q.Credits, asked, q.AmountCents)
		}
	}
}

func TestQuoteTopupCapsAtTheAbuseCeiling(t *testing.T) {
	q := QuoteTopup(1000, 100, MaxTopupCredits*10)
	if q.Credits != MaxTopupCredits {
		t.Fatalf("credits=%d, want the %d ceiling", q.Credits, MaxTopupCredits)
	}
}

// Rate 0 means the admin switched top-up off. The client must be told that
// explicitly rather than shown a $0 price it might try to buy.
func TestQuoteTopupReportsDisabledRatherThanAFreePrice(t *testing.T) {
	q := QuoteTopup(0, 100, 5000)
	if q.Enabled {
		t.Fatal("enabled=true at rate 0, want false")
	}
	if q.Credits != 0 || q.AmountCents != 0 || q.MinCredits != 0 || q.RateCreditsPerDollar != 0 {
		t.Fatalf("disabled quote leaked non-zero values: %+v", q)
	}
	if q.Currency != "USD" || q.MaxCredits != MaxTopupCredits {
		t.Fatalf("currency=%q maxCredits=%d, want USD and %d", q.Currency, q.MaxCredits, MaxTopupCredits)
	}
}
