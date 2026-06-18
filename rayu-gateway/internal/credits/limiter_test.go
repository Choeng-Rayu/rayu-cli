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
		{0, 1000, 1, 0},
		{1_000_000, 1000, 1, 1000},   // exactly 1M -> baseline credits
		{1_000_000, 1000, 3, 3000},   // 3x multiplier
		{18, 1000, 1, 1},             // tiny usage rounds up to 1
		{500_000, 1000, 1, 500},      // half a million tokens
		{1_500_000, 1000, 1, 1500},   // 1.5M
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
	// default max tokens when unset
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

func TestReserveWeeklyLimit(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	r, err := lim.Reserve(ctx, ReserveParams{UserID: 1, EstCredits: 100, Cap5h: Unlimited, CapWeek: 500})
	if err != nil || !r.OK {
		t.Fatalf("first reserve: ok=%v err=%v", r.OK, err)
	}
	if r.UsedWeek != 100 {
		t.Fatalf("usedWeek=%d want 100", r.UsedWeek)
	}
	// 100 + 450 > 500 -> deny weekly
	r2, _ := lim.Reserve(ctx, ReserveParams{UserID: 1, EstCredits: 450, Cap5h: Unlimited, CapWeek: 500})
	if r2.OK || r2.Reason != "weekly_limit" {
		t.Fatalf("expected weekly_limit deny, got ok=%v reason=%s", r2.OK, r2.Reason)
	}
}

func TestSettleRefunds(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	// reserve 1000 estimate
	_, _ = lim.Reserve(ctx, ReserveParams{UserID: 7, EstCredits: 1000, Cap5h: Unlimited, CapWeek: 5000})
	// settle to actual 30 -> usedWeek should drop to 30
	if err := lim.Settle(ctx, 7, "plan", 1000, 30); err != nil {
		t.Fatalf("settle: %v", err)
	}
	v, _ := mr.Get("cwwk:7")
	if v != "30" {
		t.Fatalf("cwwk after settle=%q want 30", v)
	}
}

func TestTopupFallback(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	// Seed a 500-credit top-up balance from "MySQL".
	if err := lim.EnsureTopup(ctx, 3, 500); err != nil {
		t.Fatalf("ensure topup: %v", err)
	}
	// Plan weekly cap is 10; an est of 100 exceeds it, so with top-up enabled
	// the charge falls back to the top-up balance.
	r, err := lim.Reserve(ctx, ReserveParams{UserID: 3, EstCredits: 100, Cap5h: Unlimited, CapWeek: 10, TopUpEnabled: true})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if !r.OK || r.Source != "topup" {
		t.Fatalf("expected ok via topup, got ok=%v source=%s reason=%s", r.OK, r.Source, r.Reason)
	}
	if v, _ := mr.Get("topup:3"); v != "400" {
		t.Fatalf("topup balance after reserve=%q want 400", v)
	}
	// settle to actual 60 -> refund 40 to topup -> 440
	_ = lim.Settle(ctx, 3, "topup", 100, 60)
	if v, _ := mr.Get("topup:3"); v != "440" {
		t.Fatalf("topup after settle=%q want 440", v)
	}

	// Without top-up enabled, the same over-cap request is denied.
	r2, _ := lim.Reserve(ctx, ReserveParams{UserID: 4, EstCredits: 100, Cap5h: Unlimited, CapWeek: 10, TopUpEnabled: false})
	if r2.OK || r2.Reason != "weekly_limit" {
		t.Fatalf("expected weekly_limit deny, got ok=%v reason=%s", r2.OK, r2.Reason)
	}
}

func TestConcurrencyCap(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	r1, _ := lim.Reserve(ctx, ReserveParams{UserID: 9, EstCredits: 1, Cap5h: Unlimited, CapWeek: Unlimited, MaxConcurrent: 1})
	if !r1.OK {
		t.Fatal("first concurrent reserve should pass")
	}
	r2, _ := lim.Reserve(ctx, ReserveParams{UserID: 9, EstCredits: 1, Cap5h: Unlimited, CapWeek: Unlimited, MaxConcurrent: 1})
	if r2.OK || r2.Reason != "concurrency" {
		t.Fatalf("expected concurrency deny, got ok=%v reason=%s", r2.OK, r2.Reason)
	}
	// settle one -> slot frees -> next passes
	_ = lim.Settle(ctx, 9, "plan", 1, 1)
	r3, _ := lim.Reserve(ctx, ReserveParams{UserID: 9, EstCredits: 1, Cap5h: Unlimited, CapWeek: Unlimited, MaxConcurrent: 1})
	if !r3.OK {
		t.Fatalf("after settle, reserve should pass; reason=%s", r3.Reason)
	}
}

func TestRequestsCap(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()
	// allow 2 requests / 5h
	for i := 0; i < 2; i++ {
		r, _ := lim.Reserve(ctx, ReserveParams{UserID: 5, EstCredits: 1, Cap5h: Unlimited, CapWeek: Unlimited, MaxReq5h: 2})
		_ = lim.Settle(ctx, 5, "plan", 1, 1) // free concurrency, keep req counter
		if !r.OK {
			t.Fatalf("req %d should pass", i)
		}
	}
	r, _ := lim.Reserve(ctx, ReserveParams{UserID: 5, EstCredits: 1, Cap5h: Unlimited, CapWeek: Unlimited, MaxReq5h: 2})
	if r.OK || r.Reason != "requests" {
		t.Fatalf("expected requests deny, got ok=%v reason=%s", r.OK, r.Reason)
	}
}
