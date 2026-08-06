//! Integration tests for [`rayu_gateway_lib::limiter`] against a real Redis.
//!
//! The Go tests use `miniredis`, an in-process Lua-capable fake. There is no Rust
//! equivalent that runs the real Lua interpreter, and these eight scripts ARE the
//! logic under test -- so these run against a real Redis and are skipped unless
//! `RAYU_TEST_REDIS_URL` is set.
//!
//! ```text
//! docker run -d --name rayu-rust-test-redis -p 16379:6379 redis:7-alpine
//! export RAYU_TEST_REDIS_URL='redis://127.0.0.1:16379'
//! ```
//!
//! Every test uses a distinct user/org id so they can run in parallel without a
//! shared-fixture lock.

use rayu_gateway_lib::limiter::*;

async fn limiter() -> Option<Limiter> {
    let url = std::env::var("RAYU_TEST_REDIS_URL").ok()?;
    let lim = Limiter::connect(&url)
        .await
        .expect("RAYU_TEST_REDIS_URL is set but unreachable");
    lim.load_scripts().await.expect("scripts must load");
    Some(lim)
}

macro_rules! require_redis {
    () => {
        match limiter().await {
            Some(l) => l,
            None => {
                eprintln!("skipping: RAYU_TEST_REDIS_URL not set");
                return;
            }
        }
    };
}

/// Clears every key a user or org could own, so a re-run starts clean.
async fn reset(lim: &Limiter, uid: i64, org: i64) {
    let url = std::env::var("RAYU_TEST_REDIS_URL").unwrap();
    let client = redis::Client::open(url).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();
    let today = chrono::Utc::now().format("%Y%m%d").to_string();
    let mut keys = vec![
        format!("cwperiod:{uid}"),
        format!("cwperiodid:{uid}"),
        format!("conc:{uid}"),
        format!("req5h:{uid}"),
        format!("topup:{uid}"),
        format!("turns:{uid}:{today}"),
        format!("orgpool:{org}"),
        format!("orgbucket:{org}:{uid}"),
        format!("orgbucketpid:{org}:{uid}"),
    ];
    // Turn holds are per logical id; the tests below use a small fixed set.
    for lid in ["LID-1", "LID-2"] {
        keys.push(format!("turnhold:{uid}:{lid}"));
    }
    let _: () = redis::cmd("DEL")
        .arg(&keys)
        .query_async(&mut conn)
        .await
        .unwrap();
    let _ = lim; // keeps the signature honest about what it operates on
}

/// Reads a raw key, for the assertions Go makes directly against miniredis.
async fn raw_get(key: &str) -> Option<String> {
    let url = std::env::var("RAYU_TEST_REDIS_URL").unwrap();
    let client = redis::Client::open(url).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();
    redis::cmd("GET")
        .arg(key)
        .query_async(&mut conn)
        .await
        .unwrap()
}

// --- individual reserve / settle -------------------------------------------

#[tokio::test]
async fn reserve_denies_once_the_period_allowance_is_spent() {
    let lim = require_redis!();
    let uid = 1001;
    reset(&lim, uid, 0).await;

    let r = lim
        .reserve(&ReserveParams {
            user_id: uid,
            est_credits: 30,
            cap_period: 50,
            period_ttl_sec: 3600,
            ..Default::default()
        })
        .await
        .expect("reserve");
    assert!(r.ok);
    assert_eq!(r.source, "plan");
    assert_eq!(r.used_period, 30);

    // 30 + 25 > 50 -> deny. There is no weekly reset; this is a period balance.
    let r2 = lim
        .reserve(&ReserveParams {
            user_id: uid,
            est_credits: 25,
            cap_period: 50,
            period_ttl_sec: 3600,
            ..Default::default()
        })
        .await
        .expect("reserve");
    assert!(!r2.ok);
    assert_eq!(r2.reason, "period_limit");
}

#[tokio::test]
async fn settle_refunds_the_unused_hold() {
    let lim = require_redis!();
    let uid = 1007;
    reset(&lim, uid, 0).await;

    lim.reserve(&ReserveParams {
        user_id: uid,
        est_credits: 40,
        cap_period: 5000,
        period_ttl_sec: 3600,
        ..Default::default()
    })
    .await
    .expect("reserve");
    lim.settle(uid, "plan", 40, 10).await.expect("settle");

    assert_eq!(
        raw_get(&format!("cwperiod:{uid}")).await.as_deref(),
        Some("10"),
        "the counter must end at the ACTUAL cost, not the estimate"
    );
}

#[tokio::test]
async fn topup_covers_an_over_cap_request_and_settles_back() {
    let lim = require_redis!();
    let uid = 1003;
    reset(&lim, uid, 0).await;

    lim.ensure_topup(uid, 500).await.expect("ensure topup");
    // Period cap 10; est 100 exceeds it -> with top-up enabled, falls back.
    let r = lim
        .reserve(&ReserveParams {
            user_id: uid,
            est_credits: 100,
            cap_period: 10,
            period_ttl_sec: 3600,
            top_up_enabled: true,
            ..Default::default()
        })
        .await
        .expect("reserve");
    assert!(r.ok, "reason={}", r.reason);
    assert_eq!(r.source, "topup");
    assert_eq!(
        raw_get(&format!("topup:{uid}")).await.as_deref(),
        Some("400")
    );

    lim.settle(uid, "topup", 100, 60).await.expect("settle");
    assert_eq!(
        raw_get(&format!("topup:{uid}")).await.as_deref(),
        Some("440"),
        "a topup settle credits the unused hold BACK to the balance"
    );
}

#[tokio::test]
async fn without_topup_an_over_cap_request_is_denied() {
    let lim = require_redis!();
    let uid = 1004;
    reset(&lim, uid, 0).await;

    let r = lim
        .reserve(&ReserveParams {
            user_id: uid,
            est_credits: 100,
            cap_period: 10,
            period_ttl_sec: 3600,
            ..Default::default()
        })
        .await
        .expect("reserve");
    assert!(!r.ok);
    assert_eq!(r.reason, "period_limit");
}

#[tokio::test]
async fn concurrency_cap_denies_then_recovers_after_settle() {
    let lim = require_redis!();
    let uid = 1009;
    reset(&lim, uid, 0).await;
    let p = ReserveParams {
        user_id: uid,
        est_credits: 1,
        cap_period: UNLIMITED,
        period_ttl_sec: 3600,
        max_concurrent: 1,
        ..Default::default()
    };

    assert!(lim.reserve(&p).await.expect("reserve").ok);
    let r2 = lim.reserve(&p).await.expect("reserve");
    assert!(!r2.ok);
    assert_eq!(r2.reason, "concurrency");

    // Settling releases the slot.
    lim.settle(uid, "plan", 1, 1).await.expect("settle");
    let r3 = lim.reserve(&p).await.expect("reserve");
    assert!(r3.ok, "reason={}", r3.reason);
}

#[tokio::test]
async fn requests_per_5h_cap() {
    let lim = require_redis!();
    let uid = 1005;
    reset(&lim, uid, 0).await;
    let p = ReserveParams {
        user_id: uid,
        est_credits: 1,
        cap_period: UNLIMITED,
        period_ttl_sec: 3600,
        max_req_5h: 2,
        ..Default::default()
    };

    for i in 0..2 {
        assert!(lim.reserve(&p).await.expect("reserve").ok, "req {i}");
        lim.settle(uid, "plan", 1, 1).await.expect("settle");
    }
    let r = lim.reserve(&p).await.expect("reserve");
    assert!(!r.ok);
    assert_eq!(r.reason, "requests");
}

/// The abuse caps are checked BEFORE the credit charge, and in this order, so a
/// concurrency denial never moves the credit counter.
#[tokio::test]
async fn denials_do_not_charge_credits() {
    let lim = require_redis!();
    let uid = 1010;
    reset(&lim, uid, 0).await;
    let p = ReserveParams {
        user_id: uid,
        est_credits: 100,
        cap_period: UNLIMITED,
        period_ttl_sec: 3600,
        max_concurrent: 1,
        ..Default::default()
    };
    lim.reserve(&p).await.expect("reserve"); // used=100
    let denied = lim.reserve(&p).await.expect("reserve");
    assert!(!denied.ok);
    assert_eq!(
        raw_get(&format!("cwperiod:{uid}")).await.as_deref(),
        Some("100"),
        "a concurrency denial must not charge credits"
    );
}

/// Regression test for "I renewed my plan but my credits stayed maxed out":
/// exhausting the allowance on one period must NOT carry over after a renewal sets
/// a new period id.
#[tokio::test]
async fn reserve_resets_on_period_renewal() {
    let lim = require_redis!();
    let uid = 1020;
    reset(&lim, uid, 0).await;

    let params = |pid: &str, est: i64| ReserveParams {
        user_id: uid,
        est_credits: est,
        cap_period: 50,
        period_ttl_sec: 3600,
        period_id: pid.into(),
        ..Default::default()
    };

    // Exhaust the 50-credit allowance on period P1.
    let r = lim.reserve(&params("P1", 50)).await.expect("reserve");
    assert!(r.ok);
    assert_eq!(r.used_period, 50);

    // Still P1 -> denied (the pre-renewal state).
    let d = lim.reserve(&params("P1", 1)).await.expect("reserve");
    assert!(!d.ok);
    assert_eq!(d.reason, "period_limit");

    // Renewal -> new period id -> counter resets -> usable again.
    let r2 = lim.reserve(&params("P2", 1)).await.expect("reserve");
    assert!(r2.ok, "reason={}", r2.reason);
    assert_eq!(r2.used_period, 1, "the counter must have reset");

    // Within the SAME new period usage keeps accumulating (no spurious reset).
    let r3 = lim.reserve(&params("P2", 1)).await.expect("reserve");
    assert!(r3.ok);
    assert_eq!(r3.used_period, 2);
}

/// An empty period id (free / no-expiry plan) must NOT trigger the reset branch,
/// or every request would zero the counter and the allowance would never bind.
#[tokio::test]
async fn an_empty_period_id_never_resets_the_counter() {
    let lim = require_redis!();
    let uid = 1021;
    reset(&lim, uid, 0).await;
    let p = ReserveParams {
        user_id: uid,
        est_credits: 10,
        cap_period: 100,
        period_ttl_sec: 3600,
        period_id: String::new(),
        ..Default::default()
    };
    lim.reserve(&p).await.expect("reserve");
    let r = lim.reserve(&p).await.expect("reserve");
    assert_eq!(r.used_period, 20, "usage must accumulate with no period id");
}

#[tokio::test]
async fn status_reports_usage_and_falls_back_for_a_missing_topup() {
    let lim = require_redis!();
    let uid = 1030;
    reset(&lim, uid, 0).await;

    // Nothing recorded yet.
    let st = lim.status(uid).await.expect("status");
    assert_eq!(st.used_period, 0);
    assert_eq!(
        st.topup_balance, -1,
        "-1 tells the caller to use the durable DB balance"
    );

    lim.reserve(&ReserveParams {
        user_id: uid,
        est_credits: 42,
        cap_period: 1000,
        period_ttl_sec: 3600,
        ..Default::default()
    })
    .await
    .expect("reserve");
    lim.ensure_topup(uid, 250).await.expect("ensure topup");

    let st = lim.status(uid).await.expect("status");
    assert_eq!(st.used_period, 42);
    assert_eq!(st.topup_balance, 250);
    assert!(
        st.reset_period > 0 && st.reset_period <= 3600,
        "reset={} want (0,3600]",
        st.reset_period
    );
}

// --- daily turn cap ---------------------------------------------------------

#[tokio::test]
async fn reserve_turn_is_unlimited_at_cap_zero() {
    let lim = require_redis!();
    let uid = 2001;
    reset(&lim, uid, 0).await;

    for i in 1..=5 {
        let r = lim.reserve_turn(uid, 0).await.expect("reserve turn");
        assert!(r.ok, "turn {i}");
        assert_eq!(r.used_today, i, "turns are still counted when unlimited");
    }
}

#[tokio::test]
async fn reserve_turn_denies_at_the_cap() {
    let lim = require_redis!();
    let uid = 2002;
    reset(&lim, uid, 0).await;

    assert!(lim.reserve_turn(uid, 2).await.expect("t1").ok);
    assert!(lim.reserve_turn(uid, 2).await.expect("t2").ok);
    let r3 = lim.reserve_turn(uid, 2).await.expect("t3");
    assert!(!r3.ok, "the third turn must be denied at cap 2");
    assert_eq!(r3.used_today, 2, "a denial must not increment the counter");
    // The daily TTL must be set: end-of-day, so within (0, 86400].
    assert!(
        r3.reset_seconds > 0 && r3.reset_seconds <= 86400,
        "reset={} want (0,86400]",
        r3.reset_seconds
    );
    assert_eq!(r3.limit, 2);
}

#[tokio::test]
async fn release_turn_refunds_and_floors_at_zero() {
    let lim = require_redis!();
    let uid = 2003;
    reset(&lim, uid, 0).await;

    lim.reserve_turn(uid, 5).await.expect("t1");
    lim.reserve_turn(uid, 5).await.expect("t2"); // used = 2
    lim.release_turn(uid).await.expect("release");

    let (used, reset) = lim.turns_today(uid).await.expect("turns today");
    assert_eq!(used, 1);
    assert!(reset > 0);

    // Over-releasing is a safe no-op rather than going negative.
    lim.release_turn(uid).await.expect("release");
    lim.release_turn(uid).await.expect("release");
    let (used, _) = lim.turns_today(uid).await.expect("turns today");
    assert_eq!(used, 0);
}

#[tokio::test]
async fn turns_today_reports_minus_one_when_unused() {
    let lim = require_redis!();
    let uid = 2042;
    reset(&lim, uid, 0).await;
    let (used, reset) = lim.turns_today(uid).await.expect("turns today");
    assert_eq!(used, 0);
    assert_eq!(
        reset, -1,
        "an unused day must report -1, not 0 -- the CLI renders it differently"
    );
}

// --- idempotent-by-logical-id turn accounting ------------------------------

#[tokio::test]
async fn reserve_turn_for_dedupes_retries() {
    let lim = require_redis!();
    let uid = 2100;
    reset(&lim, uid, 0).await;

    // Three attempts of the SAME logical request (retries, no release) must
    // reserve exactly ONE turn.
    for i in 0..3 {
        let r = lim
            .reserve_turn_for(uid, 5, "LID-1")
            .await
            .expect("reserve turn for");
        assert!(r.ok, "attempt {i}");
        assert_eq!(
            r.used_today, 1,
            "attempt {i}: retries must not double count"
        );
    }

    // A DISTINCT logical request counts separately.
    let r2 = lim
        .reserve_turn_for(uid, 5, "LID-2")
        .await
        .expect("reserve turn for");
    assert!(r2.ok);
    assert_eq!(r2.used_today, 2);

    let (used, _) = lim.turns_today(uid).await.expect("turns today");
    assert_eq!(used, 2, "two distinct logical requests");
}

#[tokio::test]
async fn release_turn_for_allows_a_retry_to_re_reserve() {
    let lim = require_redis!();
    let uid = 2101;
    reset(&lim, uid, 0).await;

    let r1 = lim
        .reserve_turn_for(uid, 5, "LID-1")
        .await
        .expect("reserve");
    assert!(r1.ok);
    assert_eq!(r1.used_today, 1);

    // Failure path: release drops the hold AND decrements.
    lim.release_turn_for(uid, "LID-1").await.expect("release");
    let (used, _) = lim.turns_today(uid).await.expect("turns today");
    assert_eq!(used, 0);

    // A retry of the same logical id re-reserves, because the hold was cleared.
    let r2 = lim
        .reserve_turn_for(uid, 5, "LID-1")
        .await
        .expect("reserve");
    assert!(r2.ok);
    assert_eq!(r2.used_today, 1);
}

#[tokio::test]
async fn an_empty_logical_id_falls_back_to_per_attempt_counting() {
    let lim = require_redis!();
    let uid = 2102;
    reset(&lim, uid, 0).await;

    lim.reserve_turn_for(uid, 0, "").await.expect("r1");
    lim.reserve_turn_for(uid, 0, "").await.expect("r2");
    let (used, _) = lim.turns_today(uid).await.expect("turns today");
    assert_eq!(used, 2, "an empty logical id counts per attempt");
}

/// A denial must NOT leave a hold behind, or the retry would be treated as
/// already-counted and sail past the cap.
#[tokio::test]
async fn a_denied_idempotent_reserve_leaves_no_hold() {
    let lim = require_redis!();
    let uid = 2103;
    reset(&lim, uid, 0).await;

    lim.reserve_turn_for(uid, 1, "LID-1").await.expect("r1"); // used=1, at cap
    let denied = lim
        .reserve_turn_for(uid, 1, "LID-2")
        .await
        .expect("r2 denied");
    assert!(!denied.ok);
    // The hold for LID-2 was deleted, so a later reserve under a raised cap works
    // rather than being mistaken for a retry that already holds a turn.
    let after = lim.reserve_turn_for(uid, 5, "LID-2").await.expect("r3");
    assert!(after.ok);
    assert_eq!(after.used_today, 2, "the retry must count a fresh turn");
}

// --- teams ------------------------------------------------------------------

/// Builds org params for a test's OWN org/user pair.
///
/// Each org test uses distinct ids because they all share one real Redis and cargo
/// runs them in parallel -- the Go originals each got a fresh in-process miniredis,
/// which hid this entirely.
fn org_params(org: i64, uid: i64, est: i64, bucket_cap: i64, pool_cap: i64) -> OrgReserveParams {
    OrgReserveParams {
        org_id: org,
        user_id: uid,
        est_billable: est,
        bucket_cap,
        pool_cap,
        period_ttl_sec: 3600,
        period_id: "p1".into(),
        ..Default::default()
    }
}

/// A charge that crosses out of the plan's own allowance and into credits the admin
/// BOUGHT must be labelled `"extra"`, so the ledger (and the admin) can tell
/// subscription usage from purchased usage.
///
/// REGRESSION: the 10th script argument (`planCap = poolCap - purchasedCap`) was
/// missing from the Rust port, so `plancap` defaulted to -1 inside the Lua and NO
/// charge was ever attributed to purchased credits. The Lua text was byte-identical to
/// Go's; only the argument list differed.
#[tokio::test]
async fn reserve_org_labels_a_charge_that_crosses_into_purchased_credits() {
    let lim = require_redis!();
    let (org, uid) = (3041, 3031);
    reset(&lim, uid, org).await;

    // 1000 plan credits + 400 purchased = a 1400 hard cap. A ZERO bucket quota sends
    // every charge straight to the shared pool, which is where the plan/purchased
    // boundary lives.
    let mut p = org_params(org, uid, 900, 0, 1400);
    p.purchased_cap = 400;

    // The first 900 fit inside the plan's own allowance.
    let first = lim.reserve_org(&p).await.unwrap();
    assert!(first.ok, "{first:?}");
    assert_eq!(
        first.source, "pool",
        "still inside the subscription's allowance"
    );

    // The next 300 crosses 1000, so part of it comes out of what was bought.
    let mut second_params = p.clone();
    second_params.est_billable = 300;
    let second = lim.reserve_org(&second_params).await.unwrap();
    assert!(second.ok, "{second:?}");
    assert_eq!(
        second.source, "extra",
        "a charge past the plan allowance must be attributed to purchased credits"
    );

    // And the hard cap still includes the purchased credits.
    let mut third = p.clone();
    third.est_billable = 500;
    let denied = lim.reserve_org(&third).await.unwrap();
    assert!(!denied.ok, "1200+500 exceeds the 1400 cap: {denied:?}");
    assert_eq!(denied.reason, "pool_limit");
}

/// An UNLIMITED pool has no plan boundary, so nothing can ever be labelled purchased.
#[tokio::test]
async fn an_unlimited_pool_never_labels_a_charge_as_purchased() {
    let lim = require_redis!();
    let (org, uid) = (3042, 3032);
    reset(&lim, uid, org).await;

    let mut p = org_params(org, uid, 5_000_000, 0, UNLIMITED);
    p.purchased_cap = 400;
    let got = lim.reserve_org(&p).await.unwrap();
    assert!(got.ok);
    assert_ne!(got.source, "extra");
}

#[tokio::test]
async fn reserve_org_charges_the_bucket_first() {
    let lim = require_redis!();
    let (org, uid) = (3021, 3007);
    reset(&lim, uid, org).await;

    let res = lim
        .reserve_org(&org_params(org, uid, 100, 500, 10_000))
        .await
        .expect("reserve org");
    assert!(res.ok);
    assert_eq!(res.source, "bucket");
    // Both tiers move on every accepted request -- the pool is what caps the team.
    assert_eq!(res.used_bucket, 100);
    assert_eq!(res.used_pool, 100);
}

#[tokio::test]
async fn reserve_org_overflows_to_the_pool_when_the_bucket_is_spent() {
    let lim = require_redis!();
    let (org, uid) = (3022, 3008);
    reset(&lim, uid, org).await;

    // Spend the whole bucket (cap 200).
    lim.reserve_org(&org_params(org, uid, 200, 200, 10_000))
        .await
        .expect("reserve org");
    let res = lim
        .reserve_org(&org_params(org, uid, 50, 200, 10_000))
        .await
        .expect("reserve org");
    assert!(
        res.ok,
        "bucket exhaustion must fall back to the pool, got deny reason={}",
        res.reason
    );
    assert_eq!(res.source, "pool");
    assert_eq!(res.used_pool, 250);
}

#[tokio::test]
async fn reserve_org_denies_when_the_pool_is_exhausted() {
    let lim = require_redis!();
    let (org, uid) = (3023, 3009);
    reset(&lim, uid, org).await;

    // Pool cap 300, member quota generous -- the pool must still stop them.
    lim.reserve_org(&org_params(org, uid, 300, 1_000_000, 300))
        .await
        .expect("reserve org");
    let res = lim
        .reserve_org(&org_params(org, uid, 1, 1_000_000, 300))
        .await
        .expect("reserve org");
    assert!(!res.ok, "expected denial once the pool is exhausted");
    assert_eq!(res.reason, "pool_limit");
}

#[tokio::test]
async fn a_zero_quota_member_still_draws_on_the_pool() {
    let lim = require_redis!();
    let (org, uid) = (3024, 3010);
    reset(&lim, uid, org).await;

    // bucket_quota = 0 means "no personal quota", not "cannot spend".
    let res = lim
        .reserve_org(&org_params(org, uid, 10, 0, 1000))
        .await
        .expect("reserve org");
    assert!(res.ok);
    assert_eq!(res.source, "pool");
}

#[tokio::test]
async fn reserve_org_honours_the_per_user_abuse_caps() {
    let lim = require_redis!();
    let (org, uid) = (3025, 3011);
    reset(&lim, uid, org).await;
    let mut p = org_params(org, uid, 10, 1000, 10_000);
    p.max_concurrent = 1;

    assert!(lim.reserve_org(&p).await.expect("first").ok);
    let res = lim.reserve_org(&p).await.expect("second");
    assert!(!res.ok);
    assert_eq!(
        res.reason, "concurrency",
        "concurrency is an abuse control on a PERSON, so it applies inside a team"
    );
}

#[tokio::test]
async fn settle_org_reconciles_both_tiers() {
    let lim = require_redis!();
    let (org, uid) = (3026, 3012);
    reset(&lim, uid, org).await;

    let res = lim
        .reserve_org(&org_params(org, uid, 1000, 5000, 10_000))
        .await
        .expect("reserve org");
    assert!(res.ok);
    // The real turn cost far less than the pre-flight estimate.
    lim.settle_org(org, uid, 1000, 120)
        .await
        .expect("settle org");

    let st = lim.org_status(org, uid).await.expect("org status");
    assert_eq!(st.used_bucket, 120);
    assert_eq!(st.used_pool, 120);
}

#[tokio::test]
async fn release_org_refunds_fully_and_never_goes_negative() {
    let lim = require_redis!();
    let (org, uid) = (3027, 3013);
    reset(&lim, uid, org).await;

    lim.reserve_org(&org_params(org, uid, 500, 5000, 10_000))
        .await
        .expect("reserve org");
    lim.release_org(org, uid, 500).await.expect("release");
    // A second (erroneous) refund must not create free credits.
    lim.release_org(org, uid, 500).await.expect("release");

    let st = lim.org_status(org, uid).await.expect("org status");
    assert_eq!(st.used_bucket, 0);
    assert_eq!(st.used_pool, 0, "a counter must never go negative");
}

#[tokio::test]
async fn ensure_org_counters_seed_from_the_database_only_when_absent() {
    let lim = require_redis!();
    let (org, uid) = (3028, 3014);
    reset(&lim, uid, org).await;

    // Cold start: MySQL says the team already spent 400 and the member 150.
    lim.ensure_org_pool_used(org, 400, 3600)
        .await
        .expect("seed pool");
    lim.ensure_org_bucket_used(org, uid, 150, 3600)
        .await
        .expect("seed bucket");
    let st = lim.org_status(org, uid).await.expect("org status");
    assert_eq!(st.used_pool, 400);
    assert_eq!(st.used_bucket, 150);

    // Live counters must win afterwards: a re-seed with a stale value is a no-op.
    lim.reserve_org(&org_params(org, uid, 100, 5000, 10_000))
        .await
        .expect("reserve org");
    lim.ensure_org_pool_used(org, 400, 3600)
        .await
        .expect("re-seed");
    let st = lim.org_status(org, uid).await.expect("org status");
    assert_eq!(
        st.used_pool, 500,
        "the live counter must win over a stale durable value"
    );
}

#[tokio::test]
async fn reserve_org_resets_the_bucket_on_a_period_change() {
    let lim = require_redis!();
    let (org, uid) = (3029, 3015);
    reset(&lim, uid, org).await;

    lim.reserve_org(&org_params(org, uid, 200, 200, 10_000))
        .await
        .expect("reserve org");
    // Renewal: a new period id must give the member a full quota again.
    let mut p2 = org_params(org, uid, 200, 200, 10_000);
    p2.period_id = "p2".into();
    let res = lim.reserve_org(&p2).await.expect("reserve org");
    assert!(res.ok);
    assert_eq!(
        res.source, "bucket",
        "after renewal the member's own quota pays again"
    );
    assert_eq!(res.used_bucket, 200, "the bucket counter was reset");
}

/// The pool counter is deliberately NOT reset by a period change: it is re-seeded
/// from MySQL, which the renewal wrote, so the durable number always wins.
#[tokio::test]
async fn a_period_change_does_not_reset_the_shared_pool() {
    let lim = require_redis!();
    let (org, uid) = (3030, 3016);
    reset(&lim, uid, org).await;

    lim.reserve_org(&org_params(org, uid, 200, 200, 10_000))
        .await
        .expect("reserve org");
    let mut p2 = org_params(org, uid, 10, 200, 10_000);
    p2.period_id = "p2".into();
    let res = lim.reserve_org(&p2).await.expect("reserve org");
    assert_eq!(
        res.used_pool, 210,
        "the pool must keep accumulating across a period change"
    );
}

// --- helpers ----------------------------------------------------------------

#[test]
fn period_ttl_floors_at_sixty_seconds() {
    // No period end at all -> 0, which makes the limiter use its 30-day default.
    assert_eq!(period_ttl_seconds(None), 0);
    // A period ending in an hour reports roughly an hour.
    let ttl = period_ttl_seconds(Some(chrono::Utc::now() + chrono::Duration::hours(1)));
    assert!((3595..=3600).contains(&ttl), "ttl={ttl}");
    // A period about to end (or already ended) floors at 60s, so a short TTL cannot
    // wipe the counter mid-request.
    assert_eq!(
        period_ttl_seconds(Some(chrono::Utc::now() + chrono::Duration::seconds(5))),
        60
    );
    assert_eq!(
        period_ttl_seconds(Some(chrono::Utc::now() - chrono::Duration::days(1))),
        60
    );
}

#[test]
fn period_id_is_the_period_end_as_unix_seconds() {
    assert_eq!(period_id(None), "");
    let at = chrono::DateTime::from_timestamp(1_800_000_000, 0).unwrap();
    assert_eq!(period_id(Some(at)), "1800000000");
}
