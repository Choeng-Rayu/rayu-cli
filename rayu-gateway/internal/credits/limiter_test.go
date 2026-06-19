package credits

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestForTokens(t *testing.T) {
	cases := []struct {
		tokens   int64
		baseline int
		mult     float64
		want     int64
	}{
		{0, 10, 1, 0},
		{1_000_000, 10, 1, 10},  // 1M tokens @ baseline 10 = 10 credits
		{100_000, 10, 1, 1},     // 100k tokens = 1 credit
		{5_000_000, 10, 1, 50},  // 5M tokens = 50 credits ($10 Pro)
		{100_000, 10, 3, 3},     // pro model multiplier 3x
		{18, 10, 1, 1},          // tiny usage rounds up to 1
	}
	for _, c := range cases {
		if got := ForTokens(c.tokens, c.baseline, c.mult); got != c.want {
			t.Errorf("ForTokens(%d,%d,%v)=%d want %d", c.tokens, c.baseline, c.mult, got, c.want)
		}
	}
}

func TestEstimateTokens(t *testing.T) {
	req := map[string]any{
		"messages":   []any{map[string]any{"role": "user", "content": "12345678"}}, // 8 chars -> 2 tokens
		"max_tokens": float64(100),
	}
	if got := EstimateTokens(req, 2048); got != 102 {
		t.Fatalf("EstimateTokens=%d want 102", got)
	}
	if got := EstimateTokens(map[string]any{}, 2048); got != 2048 {
		t.Fatalf("EstimateTokens default=%d want 2048", got)
	}
}

func newLimiter(t *testing.T) (*Limiter, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return NewLimiter(rdb), mr
}

func TestReservePeriodLimit(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	r, err := lim.Reserve(ctx, ReserveParams{UserID: 1, EstCredits: 30, CapPeriod: 50, PeriodTTLSec: 3600})
	if err != nil || !r.OK || r.Source != "plan" {
		t.Fatalf("first reserve: ok=%v source=%s err=%v", r.OK, r.Source, err)
	}
	if r.UsedPeriod != 30 {
		t.Fatalf("usedPeriod=%d want 30", r.UsedPeriod)
	}
	// 30 + 25 > 50 -> deny period_limit (no weekly reset; it's a period balance)
	r2, _ := lim.Reserve(ctx, ReserveParams{UserID: 1, EstCredits: 25, CapPeriod: 50, PeriodTTLSec: 3600})
	if r2.OK || r2.Reason != "period_limit" {
		t.Fatalf("expected period_limit deny, got ok=%v reason=%s", r2.OK, r2.Reason)
	}
}

func TestSettleRefunds(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	_, _ = lim.Reserve(ctx, ReserveParams{UserID: 7, EstCredits: 40, CapPeriod: 5000, PeriodTTLSec: 3600})
	if err := lim.Settle(ctx, 7, "plan", 40, 10); err != nil {
		t.Fatalf("settle: %v", err)
	}
	if v, _ := mr.Get("cwperiod:7"); v != "10" {
		t.Fatalf("cwperiod after settle=%q want 10", v)
	}
}

func TestTopupFallback(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	if err := lim.EnsureTopup(ctx, 3, 500); err != nil {
		t.Fatalf("ensure topup: %v", err)
	}
	// Period cap 10; est 100 exceeds it -> with top-up enabled, falls back to top-up.
	r, err := lim.Reserve(ctx, ReserveParams{UserID: 3, EstCredits: 100, CapPeriod: 10, PeriodTTLSec: 3600, TopUpEnabled: true})
	if err != nil || !r.OK || r.Source != "topup" {
		t.Fatalf("expected topup, got ok=%v source=%s reason=%s", r.OK, r.Source, r.Reason)
	}
	if v, _ := mr.Get("topup:3"); v != "400" {
		t.Fatalf("topup after reserve=%q want 400", v)
	}
	_ = lim.Settle(ctx, 3, "topup", 100, 60)
	if v, _ := mr.Get("topup:3"); v != "440" {
		t.Fatalf("topup after settle=%q want 440", v)
	}

	// Without top-up enabled, the over-cap request is denied.
	r2, _ := lim.Reserve(ctx, ReserveParams{UserID: 4, EstCredits: 100, CapPeriod: 10, PeriodTTLSec: 3600})
	if r2.OK || r2.Reason != "period_limit" {
		t.Fatalf("expected period_limit deny, got ok=%v reason=%s", r2.OK, r2.Reason)
	}
}

func TestConcurrencyCap(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	r1, _ := lim.Reserve(ctx, ReserveParams{UserID: 9, EstCredits: 1, CapPeriod: Unlimited, PeriodTTLSec: 3600, MaxConcurrent: 1})
	if !r1.OK {
		t.Fatal("first concurrent reserve should pass")
	}
	r2, _ := lim.Reserve(ctx, ReserveParams{UserID: 9, EstCredits: 1, CapPeriod: Unlimited, PeriodTTLSec: 3600, MaxConcurrent: 1})
	if r2.OK || r2.Reason != "concurrency" {
		t.Fatalf("expected concurrency deny, got ok=%v reason=%s", r2.OK, r2.Reason)
	}
	_ = lim.Settle(ctx, 9, "plan", 1, 1)
	r3, _ := lim.Reserve(ctx, ReserveParams{UserID: 9, EstCredits: 1, CapPeriod: Unlimited, PeriodTTLSec: 3600, MaxConcurrent: 1})
	if !r3.OK {
		t.Fatalf("after settle, reserve should pass; reason=%s", r3.Reason)
	}
}

func TestRequestsCap(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		r, _ := lim.Reserve(ctx, ReserveParams{UserID: 5, EstCredits: 1, CapPeriod: Unlimited, PeriodTTLSec: 3600, MaxReq5h: 2})
		_ = lim.Settle(ctx, 5, "plan", 1, 1)
		if !r.OK {
			t.Fatalf("req %d should pass", i)
		}
	}
	r, _ := lim.Reserve(ctx, ReserveParams{UserID: 5, EstCredits: 1, CapPeriod: Unlimited, PeriodTTLSec: 3600, MaxReq5h: 2})
	if r.OK || r.Reason != "requests" {
		t.Fatalf("expected requests deny, got ok=%v reason=%s", r.OK, r.Reason)
	}
}
