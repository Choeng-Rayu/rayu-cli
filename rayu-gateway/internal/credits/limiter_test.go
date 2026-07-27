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
		{1_000_000, 10, 1, 10}, // 1M tokens @ baseline 10 = 10 credits
		{100_000, 10, 1, 1},    // 100k tokens = 1 credit
		{5_000_000, 10, 1, 50}, // 5M tokens = 50 credits ($10 Pro)
		{100_000, 10, 3, 3},    // pro model multiplier 3x
		{18, 10, 1, 1},         // tiny usage rounds up to 1
	}
	for _, c := range cases {
		if got := ForTokens(c.tokens, c.baseline, c.mult); got != c.want {
			t.Errorf("ForTokens(%d,%d,%v)=%d want %d", c.tokens, c.baseline, c.mult, got, c.want)
		}
	}
}

// flatRates returns a ModelRates where every bucket shares the same
// multiplier, i.e. the pre-per-bucket-pricing behavior (ForTokens-equivalent)
// — used by tests that want to isolate ONE dimension (e.g. just the cache
// discount) without differentiated input/output pricing interfering.
func flatRates(mult float64) ModelRates {
	return ModelRates{Input: mult, Output: mult, CacheRead: mult, CacheWrite: mult}
}

func TestForUsage(t *testing.T) {
	cases := []struct {
		name                                   string
		total, cacheHit, cacheMiss, completion int64
		baseline                               int
		want                                   int64
	}{
		{
			name:  "no cache breakdown, no prompt/completion split falls back to totalTokens",
			total: 5_000_000, cacheHit: 0, cacheMiss: 0, completion: 0,
			baseline: 10,
			want:     50, // ceil(5,000,000/1e6 * 10 * 1)
		},
		{
			name: "all cache hit is billed at CacheHitBillingWeight",
			// prompt=5,000,000 (all cache hit) + completion=0 => total=5,000,000
			total: 5_000_000, cacheHit: 5_000_000, cacheMiss: 0, completion: 0,
			baseline: 10,
			// billable = 5,000,000*0.10 = 500,000 tokens -> ceil(0.5*10*1) = 5
			want: 5,
		},
		{
			name: "mixed hit/miss/completion",
			// prompt = cacheHit(9,000,000) + cacheMiss(1,000,000) = 10,000,000; +completion(1,000,000) = total 11,000,000
			total: 11_000_000, cacheHit: 9_000_000, cacheMiss: 1_000_000, completion: 1_000_000,
			baseline: 10,
			// billable = 1,000,000 (miss) + 9,000,000*0.10 (hit) + 1,000,000 (completion) = 2,900,000
			want: 29, // ceil(2.9 * 10 * 1)
		},
		{
			name:  "pure cache-miss agentic re-send is unaffected (no hits yet)",
			total: 2_000_000, cacheHit: 0, cacheMiss: 2_000_000, completion: 0,
			baseline: 10,
			want:     20,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := Usage{TotalTokens: c.total, PromptCacheHitTokens: c.cacheHit, PromptCacheMissTokens: c.cacheMiss, CompletionTokens: c.completion}
			rates := ModelRates{Input: 1, Output: 1, CacheRead: CacheHitBillingWeight, CacheWrite: 1}
			if got := ForUsage(u, c.baseline, rates); got != c.want {
				t.Errorf("ForUsage(%+v, %d, %+v)=%d want %d", u, c.baseline, rates, got, c.want)
			}
		})
	}
}

// TestForUsageBillsOutputAtItsOwnRate verifies the fix for output tokens
// previously being billed at the same rate as input tokens even though every
// real provider prices them differently (DeepSeek: output is ~2x input).
func TestForUsageBillsOutputAtItsOwnRate(t *testing.T) {
	rates := ModelRates{Input: 1, Output: 2, CacheRead: CacheHitBillingWeight, CacheWrite: 1}
	// No cache breakdown (DeepInfra-style), but prompt/completion ARE reported
	// separately: 1,000,000 prompt + 1,000,000 completion.
	u := Usage{PromptTokens: 1_000_000, CompletionTokens: 1_000_000, TotalTokens: 2_000_000}
	// billable = 1,000,000*1 (input) + 1,000,000*2 (output) = 3,000,000 -> ceil(3*10) = 30
	if got := ForUsage(u, 10, rates); got != 30 {
		t.Fatalf("ForUsage(output-rate-aware)=%d, want 30", got)
	}
	// A flat (Input==Output) rate on the SAME usage must reproduce the old,
	// pre-fix flat-multiplier number exactly, proving this is additive.
	flat := ForUsage(u, 10, flatRates(1))
	if flat != 20 {
		t.Fatalf("ForUsage(flat rate)=%d, want 20 (sanity check on the flat-rate baseline)", flat)
	}
}

// TestForUsageNeverBillsMoreThanFlatRate locks in the invariant that a
// cache-read discount can only ever reduce (or leave unchanged) the charge
// relative to treating every token as full-price — it must never accidentally
// increase it.
func TestForUsageNeverBillsMoreThanFlatRate(t *testing.T) {
	u := Usage{TotalTokens: 3_000_000, PromptCacheHitTokens: 2_000_000, PromptCacheMissTokens: 500_000, CompletionTokens: 500_000}
	noDiscount := ForUsage(u, 10, flatRates(1))
	discounted := ForUsage(u, 10, ModelRates{Input: 1, Output: 1, CacheRead: CacheHitBillingWeight, CacheWrite: 1})
	if discounted > noDiscount {
		t.Fatalf("cache-aware billing (%d) exceeded the no-discount baseline (%d)", discounted, noDiscount)
	}
}

// TestForTokensAndForUsageClampNegativeInputs locks in the defensive posture
// (mirroring Claude Code/OpenCode's usage-parsing safe() guards): a malformed
// or unexpected negative token count from a provider must never subtract from
// the user's cumulative credit balance.
func TestForTokensAndForUsageClampNegativeInputs(t *testing.T) {
	if got := ForTokens(-5_000_000, 10, 1); got != 0 {
		t.Fatalf("ForTokens(negative)=%d, want 0", got)
	}
	allNegative := Usage{TotalTokens: -1, PromptCacheHitTokens: -1, PromptCacheMissTokens: -1, CompletionTokens: -1}
	if got := ForUsage(allNegative, 10, flatRates(1)); got != 0 {
		t.Fatalf("ForUsage(all negative)=%d, want 0", got)
	}
	// A negative completion alongside valid cache fields must clamp to 0, not
	// silently reduce the bill below what the cache-miss/hit tokens alone cost.
	rates := flatRates(1)
	got := ForUsage(Usage{TotalTokens: 1_000_000, PromptCacheMissTokens: 1_000_000, CompletionTokens: -500_000}, 10, rates)
	want := ForUsage(Usage{TotalTokens: 1_000_000, PromptCacheMissTokens: 1_000_000, CompletionTokens: 0}, 10, rates)
	if got != want {
		t.Fatalf("ForUsage(negative completion)=%d, want %d (same as completion=0)", got, want)
	}
}

func TestModelRatesFor(t *testing.T) {
	// The four charges are ADMIN-ENTERED and must be used verbatim: nothing is
	// derived from cost prices any more, so editing a cost price can never
	// silently re-price the product.
	t.Run("all four charges pass through untouched", func(t *testing.T) {
		r := ModelRatesFor(0.33, 0.66, 0.02, 0.5)
		if r.Input != 0.33 || r.Output != 0.66 || r.CacheRead != 0.02 || r.CacheWrite != 0.5 {
			t.Errorf("rates=%+v, want the admin values 0.33/0.66/0.02/0.5", r)
		}
	})
	t.Run("a model may charge output BELOW input (cheap-completion models)", func(t *testing.T) {
		r := ModelRatesFor(2, 1, 0.1, 2)
		if r.Output != 1 {
			t.Errorf("Output=%v, want 1 — the admin value must not be second-guessed", r.Output)
		}
	})
	t.Run("an unset output charge falls back to input, never to zero", func(t *testing.T) {
		r := ModelRatesFor(1.5, 0, 0.1, 1.5)
		if r.Output != 1.5 {
			t.Errorf("Output=%v, want the input charge 1.5 (a 0 charge would bill nothing)", r.Output)
		}
	})
	t.Run("an unset cache-write charge falls back to input", func(t *testing.T) {
		r := ModelRatesFor(2, 3, 0.2, 0)
		if r.CacheWrite != 2 {
			t.Errorf("CacheWrite=%v, want the input charge 2", r.CacheWrite)
		}
	})
	t.Run("a zero cache-READ charge is honoured (free cache reads are legitimate)", func(t *testing.T) {
		r := ModelRatesFor(1, 1, 0, 1)
		if r.CacheRead != 0 {
			t.Errorf("CacheRead=%v, want 0 — some providers do not charge for cache hits", r.CacheRead)
		}
	})
	t.Run("negative input is clamped rather than crediting the user", func(t *testing.T) {
		r := ModelRatesFor(-5, 1, 0.1, 1)
		if r.Input != 0 {
			t.Errorf("Input=%v, want 0", r.Input)
		}
	})
	t.Run("rates feed ForUsage without panicking", func(t *testing.T) {
		r := ModelRatesFor(1, 2, 0.1, 1)
		u := Usage{TotalTokens: 5_000_000, PromptCacheHitTokens: 3_000_000, PromptCacheMissTokens: 2_000_000}
		_ = ForUsage(u, 10, r)
	})
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

func TestReserveTurnUnlimited(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	for i := int64(1); i <= 5; i++ {
		r, err := lim.ReserveTurn(ctx, 1, 0) // cap 0 = unlimited
		if err != nil || !r.OK {
			t.Fatalf("turn %d should pass: ok=%v err=%v", i, r.OK, err)
		}
		if r.UsedToday != i {
			t.Fatalf("usedToday=%d want %d", r.UsedToday, i)
		}
	}
}

func TestReserveTurnCap(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	// cap 2: two pass, third denied.
	r1, _ := lim.ReserveTurn(ctx, 2, 2)
	r2, _ := lim.ReserveTurn(ctx, 2, 2)
	if !r1.OK || !r2.OK {
		t.Fatalf("first two turns should pass: %v %v", r1.OK, r2.OK)
	}
	r3, _ := lim.ReserveTurn(ctx, 2, 2)
	if r3.OK {
		t.Fatal("third turn should be denied at cap 2")
	}
	if r3.UsedToday != 2 {
		t.Fatalf("usedToday at deny=%d want 2", r3.UsedToday)
	}
	// A daily TTL must be set (end-of-day, so within (0, 86400]).
	if r3.ResetSeconds <= 0 || r3.ResetSeconds > 86400 {
		t.Fatalf("resetSeconds=%d want (0,86400]", r3.ResetSeconds)
	}
}

func TestReleaseTurnRefund(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	_, _ = lim.ReserveTurn(ctx, 3, 5)
	_, _ = lim.ReserveTurn(ctx, 3, 5) // used=2
	if err := lim.ReleaseTurn(ctx, 3); err != nil {
		t.Fatalf("release: %v", err)
	}
	used, reset, _ := lim.TurnsToday(ctx, 3)
	if used != 1 {
		t.Fatalf("used after release=%d want 1", used)
	}
	if reset <= 0 {
		t.Fatalf("resetSeconds=%d want >0", reset)
	}
	// Release floors at 0 and is safe when nothing is counted.
	_ = lim.ReleaseTurn(ctx, 3)
	_ = lim.ReleaseTurn(ctx, 3) // would go negative -> no-op
	used, _, _ = lim.TurnsToday(ctx, 3)
	if used != 0 {
		t.Fatalf("used after over-release=%d want 0", used)
	}
}

// --- Idempotent-by-logical-request-id turn accounting (Task 7) ------------

func TestReserveTurnForDedupesRetries(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	// 3 attempts of the SAME logical request (retries, no release) must reserve
	// exactly ONE turn.
	for i := 0; i < 3; i++ {
		r, err := lim.ReserveTurnFor(ctx, 42, 5, "LID-1")
		if err != nil || !r.OK {
			t.Fatalf("attempt %d should pass: ok=%v err=%v", i, r.OK, err)
		}
		if r.UsedToday != 1 {
			t.Fatalf("attempt %d usedToday=%d want 1 (retries must not double count)", i, r.UsedToday)
		}
	}
	// A DISTINCT logical request counts separately.
	r2, _ := lim.ReserveTurnFor(ctx, 42, 5, "LID-2")
	if !r2.OK || r2.UsedToday != 2 {
		t.Fatalf("distinct logical id: ok=%v used=%d want ok=true used=2", r2.OK, r2.UsedToday)
	}
	used, _, _ := lim.TurnsToday(ctx, 42)
	if used != 2 {
		t.Fatalf("day counter=%d want 2 (two distinct logical requests)", used)
	}
}

func TestReserveTurnForReleaseAllowsReReserve(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	r1, _ := lim.ReserveTurnFor(ctx, 7, 5, "LID-1")
	if !r1.OK || r1.UsedToday != 1 {
		t.Fatalf("first reserve: ok=%v used=%d", r1.OK, r1.UsedToday)
	}
	// Failure path: release drops the hold AND decrements.
	if err := lim.ReleaseTurnFor(ctx, 7, "LID-1"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if used, _, _ := lim.TurnsToday(ctx, 7); used != 0 {
		t.Fatalf("used after release=%d want 0", used)
	}
	// Retry of the same logical id re-reserves (hold was cleared).
	r2, _ := lim.ReserveTurnFor(ctx, 7, 5, "LID-1")
	if !r2.OK || r2.UsedToday != 1 {
		t.Fatalf("re-reserve after release: ok=%v used=%d want ok=true used=1", r2.OK, r2.UsedToday)
	}
}

func TestReserveTurnForEmptyLogicalFallsBackToPerAttempt(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	// Empty logical id -> per-attempt counting (back-compat with ReserveTurn).
	_, _ = lim.ReserveTurnFor(ctx, 9, 0, "")
	_, _ = lim.ReserveTurnFor(ctx, 9, 0, "")
	if used, _, _ := lim.TurnsToday(ctx, 9); used != 2 {
		t.Fatalf("empty-logical used=%d want 2 (per-attempt)", used)
	}
}
func TestTurnsTodayEmpty(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	used, reset, err := lim.TurnsToday(ctx, 42)
	if err != nil {
		t.Fatalf("TurnsToday: %v", err)
	}
	if used != 0 || reset != -1 {
		t.Fatalf("empty TurnsToday used=%d reset=%d want 0/-1", used, reset)
	}
}

// TestReserveResetsOnPeriodRenewal is the regression test for "I renewed my $10
// plan but my credits stayed maxed out and I still can't use it": exhausting the
// allowance on one billing period (P1) must NOT carry over after a renewal sets
// a new period id (P2) — the counter resets so the renewed plan is usable, while
// staying accumulative within the same period.
func TestReserveResetsOnPeriodRenewal(t *testing.T) {
	lim, mr := newLimiter(t)
	defer mr.Close()
	ctx := context.Background()

	// Exhaust the 50-credit allowance on period "P1".
	r, err := lim.Reserve(ctx, ReserveParams{UserID: 20, EstCredits: 50, CapPeriod: 50, PeriodTTLSec: 3600, PeriodID: "P1"})
	if err != nil || !r.OK || r.UsedPeriod != 50 {
		t.Fatalf("exhaust P1: ok=%v used=%d err=%v", r.OK, r.UsedPeriod, err)
	}
	// Still P1 → denied (counter maxed) — the pre-renewal state.
	d, _ := lim.Reserve(ctx, ReserveParams{UserID: 20, EstCredits: 1, CapPeriod: 50, PeriodTTLSec: 3600, PeriodID: "P1"})
	if d.OK || d.Reason != "period_limit" {
		t.Fatalf("still P1: expected period_limit deny, got ok=%v reason=%s", d.OK, d.Reason)
	}
	// Renewal → new period id "P2" → counter resets → usable again, used=1.
	r2, err := lim.Reserve(ctx, ReserveParams{UserID: 20, EstCredits: 1, CapPeriod: 50, PeriodTTLSec: 3600, PeriodID: "P2"})
	if err != nil || !r2.OK {
		t.Fatalf("after renewal: expected OK, got ok=%v reason=%s err=%v", r2.OK, r2.Reason, err)
	}
	if r2.UsedPeriod != 1 {
		t.Fatalf("after renewal usedPeriod=%d, want 1 (counter reset)", r2.UsedPeriod)
	}
	// Within the SAME new period, usage keeps accumulating (no spurious reset).
	r3, _ := lim.Reserve(ctx, ReserveParams{UserID: 20, EstCredits: 1, CapPeriod: 50, PeriodTTLSec: 3600, PeriodID: "P2"})
	if !r3.OK || r3.UsedPeriod != 2 {
		t.Fatalf("same-period accumulate: ok=%v used=%d, want ok=true used=2", r3.OK, r3.UsedPeriod)
	}
}
