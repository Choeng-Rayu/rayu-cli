package credits

import (
	"context"
	"testing"
)

// Team credit accounting has exactly two rules worth testing:
//   1. the member's bucket is a SOFT quota — exceeding it is allowed and only
//      changes the recorded source to "pool";
//   2. the POOL is the hard cap — when it cannot cover the hold, the request is
//      denied no matter what the member's quota says.
// Everything else (seeding from MySQL, settle reconciliation) exists so those two
// rules survive a restart and a wrong pre-flight estimate.

func orgParams(est, bucketCap, poolCap int64) OrgReserveParams {
	return OrgReserveParams{
		OrgID:        21,
		UserID:       7,
		EstBillable:  est,
		BucketCap:    bucketCap,
		PoolCap:      poolCap,
		PeriodTTLSec: 3600,
		PeriodID:     "p1",
	}
}

func TestReserveOrgChargesBucketFirst(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	res, err := lim.ReserveOrg(ctx, orgParams(100, 500, 10_000))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if !res.OK || res.Source != "bucket" {
		t.Fatalf("got ok=%v source=%q, want ok=true source=bucket", res.OK, res.Source)
	}
	// Both tiers move on every accepted request — the pool is what caps the team.
	if res.UsedBucket != 100 || res.UsedPool != 100 {
		t.Errorf("usedBucket=%d usedPool=%d, want 100/100", res.UsedBucket, res.UsedPool)
	}
}

func TestReserveOrgOverflowsToPoolWhenBucketIsSpent(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	// Spend the whole bucket (cap 200) in two holds.
	if _, err := lim.ReserveOrg(ctx, orgParams(200, 200, 10_000)); err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	res, err := lim.ReserveOrg(ctx, orgParams(50, 200, 10_000))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if !res.OK {
		t.Fatalf("bucket exhaustion must fall back to the pool, got deny reason=%q", res.Reason)
	}
	if res.Source != "pool" {
		t.Errorf("source = %q, want pool", res.Source)
	}
	if res.UsedPool != 250 {
		t.Errorf("usedPool = %d, want 250", res.UsedPool)
	}
}

func TestReserveOrgDeniesWhenPoolIsExhausted(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	// Pool cap 300, member quota is generous — the pool must still stop them.
	if _, err := lim.ReserveOrg(ctx, orgParams(300, 1_000_000, 300)); err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	res, err := lim.ReserveOrg(ctx, orgParams(1, 1_000_000, 300))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if res.OK {
		t.Fatal("expected denial once the pool is exhausted")
	}
	if res.Reason != "pool_limit" {
		t.Errorf("reason = %q, want pool_limit", res.Reason)
	}
}

// --- Purchased (pay-as-you-go) team credits ---------------------------------
//
// A team can buy credits on top of its plan. Three things must hold, and each is
// a way this feature could quietly cheat someone:
//   1. purchased credits RAISE the hard cap — otherwise the team paid for nothing;
//   2. the plan's own allowance is spent FIRST, and a charge that crosses into the
//      purchased tier is labeled "extra" — otherwise a buyer cannot tell what
//      their money bought;
//   3. the cap is still a cap — once plan + purchased are both gone, the team is
//      denied.

/** orgParamsWithPurchased mirrors orgParams plus a purchased tier. */
func orgParamsWithPurchased(est, bucketCap, planCap, purchased int64) OrgReserveParams {
	p := orgParams(est, bucketCap, planCap+purchased)
	p.PurchasedCap = purchased
	return p
}

func TestReserveOrgPurchasedCreditsExtendTheHardCap(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	// Plan allowance 300, bought 200. The 400th billable token must be served —
	// without the purchased tier this is the request that would be refused.
	if _, err := lim.ReserveOrg(ctx, orgParamsWithPurchased(300, 1_000_000, 300, 200)); err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	res, err := lim.ReserveOrg(ctx, orgParamsWithPurchased(100, 1_000_000, 300, 200))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if !res.OK {
		t.Fatalf("purchased credits must keep the team serving, got deny reason=%q", res.Reason)
	}
	if res.Source != "extra" {
		t.Errorf("source = %q, want extra — the buyer has to be able to see what their money paid for", res.Source)
	}
	if res.UsedPool != 400 {
		t.Errorf("usedPool = %d, want 400", res.UsedPool)
	}
}

func TestReserveOrgSpendsThePlanAllowanceBeforePurchasedCredits(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	// Well inside the plan's own allowance: this is the team's subscription being
	// spent, not the credits it bought.
	res, err := lim.ReserveOrg(ctx, orgParamsWithPurchased(100, 50, 1000, 500))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if !res.OK || res.Source != "pool" {
		t.Fatalf("got ok=%v source=%q, want ok=true source=pool", res.OK, res.Source)
	}
}

func TestReserveOrgDeniesOncePlanAndPurchasedAreBothGone(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	if _, err := lim.ReserveOrg(ctx, orgParamsWithPurchased(500, 1_000_000, 300, 200)); err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	res, err := lim.ReserveOrg(ctx, orgParamsWithPurchased(1, 1_000_000, 300, 200))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if res.OK {
		t.Fatal("expected denial once plan allowance AND purchased credits are spent")
	}
	if res.Reason != "pool_limit" {
		t.Errorf("reason = %q, want pool_limit", res.Reason)
	}
}

func TestReserveOrgWithoutPurchasedCreditsNeverReportsExtra(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	// The zero value of PurchasedCap must mean "the team bought nothing", so a
	// caller that knows nothing about this tier cannot mislabel plan usage.
	res, err := lim.ReserveOrg(ctx, orgParams(300, 10, 300))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if !res.OK || res.Source != "pool" {
		t.Fatalf("got ok=%v source=%q, want ok=true source=pool", res.OK, res.Source)
	}
}

func TestReserveOrgUnlimitedPoolNeverReportsExtra(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	p := orgParams(1_000_000, 10, Unlimited)
	p.PurchasedCap = 500 // nonsensical with an unlimited pool; must not confuse it
	res, err := lim.ReserveOrg(ctx, p)
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if !res.OK || res.Source != "pool" {
		t.Fatalf("got ok=%v source=%q, want ok=true source=pool", res.OK, res.Source)
	}
}

func TestReserveOrgZeroQuotaStillDrawsOnThePool(t *testing.T) {

	lim, _ := newLimiter(t)
	ctx := context.Background()

	// bucketQuota = 0 means "no personal quota", not "cannot spend".
	res, err := lim.ReserveOrg(ctx, orgParams(10, 0, 1000))
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if !res.OK || res.Source != "pool" {
		t.Fatalf("got ok=%v source=%q, want ok=true source=pool", res.OK, res.Source)
	}
}

func TestReserveOrgHonorsConcurrencyAndRequestCaps(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()
	p := orgParams(10, 1000, 10_000)
	p.MaxConcurrent = 1

	if res, err := lim.ReserveOrg(ctx, p); err != nil || !res.OK {
		t.Fatalf("first reserve: ok=%v err=%v", res.OK, err)
	}
	res, err := lim.ReserveOrg(ctx, p)
	if err != nil {
		t.Fatalf("ReserveOrg: %v", err)
	}
	if res.OK || res.Reason != "concurrency" {
		t.Fatalf("got ok=%v reason=%q, want deny/concurrency", res.OK, res.Reason)
	}
}

func TestSettleOrgReconcilesBothTiers(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	res, err := lim.ReserveOrg(ctx, orgParams(1000, 5000, 10_000))
	if err != nil || !res.OK {
		t.Fatalf("reserve: ok=%v err=%v", res.OK, err)
	}
	// The real turn cost far less than the pre-flight estimate.
	if err := lim.SettleOrg(ctx, 21, 7, 1000, 120); err != nil {
		t.Fatalf("SettleOrg: %v", err)
	}
	st, err := lim.OrgStatus(ctx, 21, 7)
	if err != nil {
		t.Fatalf("OrgStatus: %v", err)
	}
	if st.UsedBucket != 120 || st.UsedPool != 120 {
		t.Errorf("after settle usedBucket=%d usedPool=%d, want 120/120", st.UsedBucket, st.UsedPool)
	}
}

func TestReleaseOrgRefundsFullyAndNeverGoesNegative(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	if _, err := lim.ReserveOrg(ctx, orgParams(500, 5000, 10_000)); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := lim.ReleaseOrg(ctx, 21, 7, 500); err != nil {
		t.Fatalf("ReleaseOrg: %v", err)
	}
	// A second (erroneous) refund must not create free credits.
	if err := lim.ReleaseOrg(ctx, 21, 7, 500); err != nil {
		t.Fatalf("ReleaseOrg: %v", err)
	}
	st, _ := lim.OrgStatus(ctx, 21, 7)
	if st.UsedBucket != 0 || st.UsedPool != 0 {
		t.Errorf("usedBucket=%d usedPool=%d, want 0/0 (never negative)", st.UsedBucket, st.UsedPool)
	}
}

func TestEnsureOrgCountersSeedFromDatabaseOnlyWhenAbsent(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	// Cold start: MySQL says the team already spent 400 and the member 150.
	if err := lim.EnsureOrgPoolUsed(ctx, 21, 400, 3600); err != nil {
		t.Fatalf("EnsureOrgPoolUsed: %v", err)
	}
	if err := lim.EnsureOrgBucketUsed(ctx, 21, 7, 150, 3600); err != nil {
		t.Fatalf("EnsureOrgBucketUsed: %v", err)
	}
	st, _ := lim.OrgStatus(ctx, 21, 7)
	if st.UsedPool != 400 || st.UsedBucket != 150 {
		t.Fatalf("seeded usedPool=%d usedBucket=%d, want 400/150", st.UsedPool, st.UsedBucket)
	}

	// Live counters must win afterwards: a re-seed with a stale value is a no-op.
	if _, err := lim.ReserveOrg(ctx, orgParams(100, 5000, 10_000)); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := lim.EnsureOrgPoolUsed(ctx, 21, 400, 3600); err != nil {
		t.Fatalf("EnsureOrgPoolUsed: %v", err)
	}
	st, _ = lim.OrgStatus(ctx, 21, 7)
	if st.UsedPool != 500 {
		t.Errorf("usedPool = %d, want 500 (live counter, not re-seeded)", st.UsedPool)
	}
}

func TestReserveOrgResetsBucketOnPeriodChange(t *testing.T) {
	lim, _ := newLimiter(t)
	ctx := context.Background()

	p := orgParams(200, 200, 10_000)
	if _, err := lim.ReserveOrg(ctx, p); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	// Renewal: a new period id must give the member a full quota again.
	p2 := orgParams(200, 200, 10_000)
	p2.PeriodID = "p2"
	res, err := lim.ReserveOrg(ctx, p2)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if !res.OK || res.Source != "bucket" {
		t.Fatalf("got ok=%v source=%q, want ok=true source=bucket after renewal", res.OK, res.Source)
	}
	if res.UsedBucket != 200 {
		t.Errorf("usedBucket = %d, want 200 (counter was reset)", res.UsedBucket)
	}
}
