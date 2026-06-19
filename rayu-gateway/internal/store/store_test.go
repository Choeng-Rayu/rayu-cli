package store

import "testing"

func TestParseLimits(t *testing.T) {
	cpp, topup := parseLimits([]byte(`{"creditsPerPeriod":50,"topUpEnabled":true}`))
	if cpp == nil || *cpp != 50 {
		t.Fatalf("creditsPerPeriod=%v", cpp)
	}
	if !topup {
		t.Fatal("topUpEnabled should be true")
	}

	// Missing credit field => nil + topup false.
	cpp, topup = parseLimits([]byte(`{"features":{}}`))
	if cpp != nil || topup {
		t.Fatalf("expected nil/false, got %v %v", cpp, topup)
	}

	// Empty/invalid JSON is safe.
	if cpp, _ := parseLimits(nil); cpp != nil {
		t.Fatal("nil limits should yield nil creditsPerPeriod")
	}
}
