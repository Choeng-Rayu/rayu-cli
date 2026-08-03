//! Resolves and caches a TEAM member's billing state (the org's plan, the member's
//! per-seat bucket, and the shared credit pool).
//!
//! Port of the Go gateway's `internal/orgcredits`.
//!
//! It is separate from [`crate::entitlements`] on purpose. That cache answers "what
//! may this USER do", keyed by user id, and every existing handler depends on that
//! shape. Team billing is keyed by (org, member) and only matters for the small
//! subset of requests whose JWT carries an `orgId` claim, so bolting it onto the user
//! cache would have made the common path pay for a feature it never uses -- and would
//! have forced every test fake of that cache to grow a method.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use dashmap::DashMap;
use rayu_core::store::{OrgMemberState, Store};

/// Bounds the single database read on a cache miss, mirroring the user entitlement
/// cache: the gateway must be the component that answers first, rather than hanging
/// until a reverse proxy times out.
const RESOLVE_DEADLINE: Duration = Duration::from_secs(3);

/// A zero/negative TTL falls back to this, so a misconfiguration cannot turn every
/// request into a database read.
const DEFAULT_TTL: Duration = Duration::from_secs(30);

/// The slice of the store this module needs.
///
/// Narrowing it here keeps the resolver testable without a live MySQL.
#[async_trait::async_trait]
pub trait Source: Send + Sync {
    async fn org_member_state(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<Option<OrgMemberState>, String>;
}

#[async_trait::async_trait]
impl Source for Store {
    async fn org_member_state(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<Option<OrgMemberState>, String> {
        Store::org_member_state(self, org_id, user_id)
            .await
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone)]
struct Entry {
    /// `None` is a CACHED negative: the user holds no seat in that org.
    state: Option<OrgMemberState>,
    expires_at: chrono::DateTime<Utc>,
}

/// Caches per-(org, member) state for a short TTL.
pub struct Resolver {
    src: Arc<dyn Source>,
    ttl: Duration,
    entries: DashMap<(i64, i64), Entry>,
}

impl std::fmt::Debug for Resolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("orgcredits::Resolver")
            .field("ttl", &self.ttl)
            .field("cached", &self.entries.len())
            .finish()
    }
}

impl Resolver {
    pub fn new(src: Arc<dyn Source>, ttl: Duration) -> Self {
        Self {
            src,
            ttl: if ttl.is_zero() { DEFAULT_TTL } else { ttl },
            entries: DashMap::new(),
        }
    }

    /// Returns the member's team billing state, or `Ok(None)` when the user holds no
    /// seat in that org.
    ///
    /// A `None` result is the deliberate fallback for a STALE claim: an access token
    /// lives up to an hour, so a member removed five minutes ago still presents an
    /// `orgId`. Rather than failing their request, the caller bills them individually
    /// -- which is exactly what they now are.
    pub async fn resolve(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<Option<OrgMemberState>, String> {
        if org_id <= 0 {
            return Ok(None);
        }
        let k = (org_id, user_id);
        let now = Utc::now();
        if let Some(e) = self.entries.get(&k) {
            if e.expires_at > now {
                return Ok(e.state.clone());
            }
        }

        let state = match tokio::time::timeout(
            RESOLVE_DEADLINE,
            self.src.org_member_state(org_id, user_id),
        )
        .await
        {
            Ok(r) => r?,
            Err(_) => return Err("team state resolve timed out".to_string()),
        };

        self.entries.insert(
            k,
            Entry {
                state: state.clone(),
                expires_at: now
                    + chrono::Duration::from_std(self.ttl).unwrap_or(chrono::Duration::seconds(30)),
            },
        );
        // Piggy-back the sweep on writes: nothing else removes entries, so a
        // long-running gateway would otherwise keep one per member forever.
        self.entries.retain(|_, v| v.expires_at > now);
        Ok(state)
    }

    /// Drops a cached entry so the next [`Resolver::resolve`] re-reads MySQL.
    ///
    /// Called after a settle changes the bucket/pool, so the numbers a member sees
    /// follow their own spending instead of lagging a whole TTL behind it.
    pub fn invalidate(&self, org_id: i64, user_id: i64) {
        self.entries.remove(&(org_id, user_id));
    }

    /// How many entries are held (tests and diagnostics).
    pub fn cached(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        reads: AtomicUsize,
        state: Option<OrgMemberState>,
        fail: bool,
    }

    #[async_trait::async_trait]
    impl Source for Fake {
        async fn org_member_state(
            &self,
            _org_id: i64,
            _user_id: i64,
        ) -> Result<Option<OrgMemberState>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err("db down".into());
            }
            Ok(self.state.clone())
        }
    }

    fn seat(org_id: i64) -> OrgMemberState {
        OrgMemberState {
            org_id,
            org_status: "active".into(),
            member_status: "active".into(),
            member_role: "member".into(),
            sub_status: "active".into(),
            has_plan: true,
            bucket_quota: 100,
            bucket_credits: 60,
            pool_total: 1000,
            pool_used: 250,
            pool_extra: 500,
            ..Default::default()
        }
    }

    fn resolver(fake: Arc<Fake>, ttl: Duration) -> Resolver {
        Resolver::new(fake, ttl)
    }

    #[tokio::test]
    async fn a_second_call_within_the_ttl_is_served_from_cache() {
        let fake = Arc::new(Fake {
            reads: AtomicUsize::new(0),
            state: Some(seat(7)),
            fail: false,
        });
        let r = resolver(fake.clone(), Duration::from_secs(30));
        assert!(r.resolve(7, 1).await.unwrap().is_some());
        assert!(r.resolve(7, 1).await.unwrap().is_some());
        assert_eq!(
            fake.reads.load(Ordering::SeqCst),
            1,
            "the second call must not touch the database"
        );
        assert_eq!(r.cached(), 1);
    }

    /// A stale claim (member removed) must resolve to None so the caller falls back to
    /// individual billing rather than failing the request.
    #[tokio::test]
    async fn a_missing_seat_resolves_to_none_and_is_cached() {
        let fake = Arc::new(Fake {
            reads: AtomicUsize::new(0),
            state: None,
            fail: false,
        });
        let r = resolver(fake.clone(), Duration::from_secs(30));
        assert!(r.resolve(7, 1).await.unwrap().is_none());
        assert!(r.resolve(7, 1).await.unwrap().is_none());
        assert_eq!(
            fake.reads.load(Ordering::SeqCst),
            1,
            "a negative result is cached too, or a stale token would hammer MySQL"
        );
    }

    #[tokio::test]
    async fn an_absent_org_claim_never_reads_the_database() {
        let fake = Arc::new(Fake {
            reads: AtomicUsize::new(0),
            state: Some(seat(7)),
            fail: false,
        });
        let r = resolver(fake.clone(), Duration::from_secs(30));
        assert!(r.resolve(0, 1).await.unwrap().is_none());
        assert!(r.resolve(-5, 1).await.unwrap().is_none());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn invalidate_forces_a_re_read() {
        let fake = Arc::new(Fake {
            reads: AtomicUsize::new(0),
            state: Some(seat(7)),
            fail: false,
        });
        let r = resolver(fake.clone(), Duration::from_secs(30));
        r.resolve(7, 1).await.unwrap();
        r.invalidate(7, 1);
        r.resolve(7, 1).await.unwrap();
        assert_eq!(
            fake.reads.load(Ordering::SeqCst),
            2,
            "after a settle the member must see their own spending immediately"
        );
    }

    #[tokio::test]
    async fn an_expired_entry_is_re_read_and_swept() {
        let fake = Arc::new(Fake {
            reads: AtomicUsize::new(0),
            state: Some(seat(7)),
            fail: false,
        });
        // A 1ns TTL expires before the next call can run.
        let r = resolver(fake.clone(), Duration::from_nanos(1));
        r.resolve(7, 1).await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        r.resolve(7, 1).await.unwrap();
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    }

    /// A zero TTL must not turn every request into a database read.
    #[tokio::test]
    async fn a_zero_ttl_falls_back_to_the_default() {
        let fake = Arc::new(Fake {
            reads: AtomicUsize::new(0),
            state: Some(seat(7)),
            fail: false,
        });
        let r = resolver(fake.clone(), Duration::ZERO);
        assert_eq!(r.ttl, DEFAULT_TTL);
        r.resolve(7, 1).await.unwrap();
        r.resolve(7, 1).await.unwrap();
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    }

    /// A database failure must be reported, NOT cached: the caller logs it and bills
    /// individually, and the next request tries again.
    #[tokio::test]
    async fn a_failure_is_reported_and_not_cached() {
        let fake = Arc::new(Fake {
            reads: AtomicUsize::new(0),
            state: None,
            fail: true,
        });
        let r = resolver(fake.clone(), Duration::from_secs(30));
        assert!(r.resolve(7, 1).await.is_err());
        assert_eq!(r.cached(), 0, "a failure must not be cached");
        assert!(r.resolve(7, 1).await.is_err());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    }

    /// The two pool figures are what an admin acts on, so the arithmetic is pinned.
    #[test]
    fn pool_and_purchased_remaining_account_for_bought_credits() {
        let mut s = seat(7);
        // 1000 plan + 500 bought - 250 spent.
        assert_eq!(s.pool_remaining(), 1250);
        // Spending fills the plan's allowance first, so nothing purchased is touched.
        assert_eq!(s.purchased_remaining(), 500);

        // Now spend past the plan allowance into the purchased credits.
        s.pool_used = 1200;
        assert_eq!(s.pool_remaining(), 300);
        assert_eq!(
            s.purchased_remaining(),
            300,
            "200 of the 500 bought credits are gone"
        );

        // Fully exhausted: never negative.
        s.pool_used = 9_999;
        assert_eq!(s.pool_remaining(), 0);
        assert_eq!(s.purchased_remaining(), 0);

        // A team that bought nothing has nothing purchased left.
        s.pool_extra = 0;
        s.pool_used = 0;
        assert_eq!(s.purchased_remaining(), 0);
        assert_eq!(s.pool_remaining(), 1000);
    }
}
