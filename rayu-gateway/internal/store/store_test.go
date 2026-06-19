package store

import "testing"

func TestParseLimits(t *testing.T) {
	l := parseLimits([]byte(`{"creditsPerPeriod":50,"maxDailyTurns":100,"topUpEnabled":true}`))
	if l.creditsPerPeriod == nil || *l.creditsPerPeriod != 50 {
		t.Fatalf("creditsPerPeriod=%v", l.creditsPerPeriod)
	}
	if l.maxDailyTurns == nil || *l.maxDailyTurns != 100 {
		t.Fatalf("maxDailyTurns=%v", l.maxDailyTurns)
	}
	if !l.topUpEnabled {
		t.Fatal("topUpEnabled should be true")
	}

	// maxDailyTurns can be set independently of credits (e.g. free plan).
	l = parseLimits([]byte(`{"maxDailyTurns":50,"features":{}}`))
	if l.creditsPerPeriod != nil {
		t.Fatalf("expected nil creditsPerPeriod, got %v", l.creditsPerPeriod)
	}
	if l.maxDailyTurns == nil || *l.maxDailyTurns != 50 {
		t.Fatalf("maxDailyTurns=%v", l.maxDailyTurns)
	}

	// Missing fields => nil caps + topup false.
	l = parseLimits([]byte(`{"features":{}}`))
	if l.creditsPerPeriod != nil || l.maxDailyTurns != nil || l.topUpEnabled {
		t.Fatalf("expected all empty, got %v %v %v", l.creditsPerPeriod, l.maxDailyTurns, l.topUpEnabled)
	}

	// Empty/invalid JSON is safe.
	if l := parseLimits(nil); l.creditsPerPeriod != nil || l.maxDailyTurns != nil {
		t.Fatal("nil limits should yield nil caps")
	}
}
