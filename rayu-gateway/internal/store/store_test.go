package store

import "testing"

func TestParseLimits(t *testing.T) {
	cpw, cp5h, topup := parseLimits([]byte(`{"creditsPerWeek":500000,"creditsPer5h":100000,"topUpEnabled":true}`))
	if cpw == nil || *cpw != 500000 {
		t.Fatalf("creditsPerWeek=%v", cpw)
	}
	if cp5h == nil || *cp5h != 100000 {
		t.Fatalf("creditsPer5h=%v", cp5h)
	}
	if !topup {
		t.Fatal("topUpEnabled should be true")
	}

	// Missing credit fields => unlimited (nil) + topup false.
	cpw, cp5h, topup = parseLimits([]byte(`{"features":{}}`))
	if cpw != nil || cp5h != nil || topup {
		t.Fatalf("expected nil/nil/false, got %v %v %v", cpw, cp5h, topup)
	}

	// Empty/invalid JSON is safe.
	if cpw, _, _ := parseLimits(nil); cpw != nil {
		t.Fatal("nil limits should yield nil creditsPerWeek")
	}
}
