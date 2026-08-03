//! The Redis-backed credit and abuse limiter.
//!
//! Port of the Go gateway's `internal/credits/limiter.go`.
//!
//! # The Lua scripts are copied VERBATIM
//!
//! All eight scripts below are byte-for-byte the Go originals, comments included.
//! They are the atomicity boundary for every credit decision the gateway makes, so
//! a re-implementation -- however faithful-looking -- would be a new
//! implementation to audit. Two gateways (Go and Rust) can therefore run against
//! one Redis during the canary and reach identical decisions, and the cached
//! `EVALSHA` digests are even the same.
//!
//! # Counters
//!
//! | key | meaning | TTL |
//! |---|---|---|
//! | `cwperiod:<uid>` | billable tokens used this billing period | until period end (30d fallback) |
//! | `cwperiodid:<uid>` | the period this counter belongs to | same as above |
//! | `conc:<uid>` | in-flight streams | 10 min (self-heals a leaked slot) |
//! | `req5h:<uid>` | requests in the last 5h | 5h |
//! | `topup:<uid>` | mirror of the durable top-up balance | 5 min (re-synced from MySQL) |
//! | `orgbucket:<org>:<uid>` | a team member's per-seat usage | period |
//! | `orgbucketpid:<org>:<uid>` | that bucket's period id | period |
//! | `orgpool:<org>` | the team's shared usage -- the hard cap | period |
//! | `turns:<uid>:<YYYYMMDD>` | turns used today | midnight UTC |
//! | `turnhold:<uid>:<logicalID>` | this logical request already holds a turn | midnight UTC |

use chrono::{DateTime, Datelike, Duration as ChronoDuration, TimeZone, Utc};
use redis::aio::ConnectionManager;
use redis::Script;

/// Disables a credit cap.
pub const UNLIMITED: i64 = -1;

/// The window for the requests/5h abuse cap.
const WIN_5H_SECS: i64 = 5 * 60 * 60;
/// Self-heal TTL for the concurrency counter: a stream that dies without settling
/// releases its slot within this window instead of leaking it forever.
const CONC_TTL_SECS: i64 = 10 * 60;
/// Re-sync TTL for the top-up mirror.
const TOPUP_TTL_SECS: i64 = 5 * 60;
/// Fallback period TTL when the caller does not know when the period ends.
const DEFAULT_PERIOD_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// Enforce concurrency/request caps, then charge the per-period balance if it
/// fits, else the top-up balance (if enabled), else deny.
/// Returns `{ok, reason, source, usedPeriod, ttlPeriod}`.
const RESERVE_SCRIPT: &str = r#"
local est=tonumber(ARGV[1]); local capp=tonumber(ARGV[2])
local maxc=tonumber(ARGV[3]); local maxr=tonumber(ARGV[4])
local win5=tonumber(ARGV[5]); local cttl=tonumber(ARGV[6]); local pttl=tonumber(ARGV[7])
local topup=tonumber(ARGV[8])
local pid=ARGV[9]

-- Reset the per-period usage counter when the billing period changed. A plan
-- renewal/upgrade sets a new currentPeriodEnd → a new period id in
-- KEYS[5]=cwperiodid:<uid>. On change we ZERO the used counter so the renewed
-- plan starts with a FULL allowance instead of inheriting the exhausted count.
-- (The key's natural TTL still resets it at period end for auto-rollovers; this
-- handles MANUAL early renewal, where the old counter would otherwise stay
-- maxed out until the original period expired.) Skipped when pid is empty
-- (free/no-expiry) to preserve prior behavior.
if pid ~= '' and redis.call('GET',KEYS[5]) ~= pid then
  redis.call('SET',KEYS[1],'0')
  redis.call('SET',KEYS[5],pid)
  if pttl>0 then
    redis.call('EXPIRE',KEYS[1],pttl)
    redis.call('EXPIRE',KEYS[5],pttl)
  end
end

local usedp=tonumber(redis.call('GET',KEYS[1]) or '0')
local conc=tonumber(redis.call('GET',KEYS[2]) or '0')
local req=tonumber(redis.call('GET',KEYS[3]) or '0')
local tb=redis.call('GET',KEYS[4])

local function deny(reason) return {0,reason,'',usedp,redis.call('TTL',KEYS[1])} end

if maxc>0 and conc>=maxc then return deny('concurrency') end
if maxr>0 and req>=maxr then return deny('requests') end

local source=''
if capp<0 or usedp+est<=capp then
  local n=redis.call('INCRBY',KEYS[1],est); if n==est then redis.call('EXPIRE',KEYS[1],pttl) end
  usedp=n; source='plan'
elseif topup==1 and tb and tonumber(tb)>=est then
  redis.call('DECRBY',KEYS[4],est); source='topup'
else
  return deny('period_limit')
end

redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],cttl)
local nr=redis.call('INCR',KEYS[3]); if nr==1 then redis.call('EXPIRE',KEYS[3],win5) end
return {1,'ok',source,usedp,redis.call('TTL',KEYS[1])}
"#;

/// Reconcile a reservation to actuals (period balance or top-up per source) and
/// release one concurrency slot.
/// `KEYS=[cwperiod, conc, topup]`; `ARGV=[source, est, actual]`.
const SETTLE_SCRIPT: &str = r#"
local source=ARGV[1]; local est=tonumber(ARGV[2]); local actual=tonumber(ARGV[3])
if source=='plan' then
  redis.call('INCRBY',KEYS[1],actual-est)
elseif source=='topup' then
  redis.call('INCRBY',KEYS[3],est-actual)
end
local c=redis.call('DECR',KEYS[2]); if c<0 then redis.call('SET',KEYS[2],0) end
return 1
"#;

/// Enforce the abuse caps, then the POOL (hard cap), then classify the charge as
/// bucket vs pool. Both counters are incremented on every accepted request.
///
/// `KEYS = [memberUsed, conc, req5h, poolUsed, memberPeriodID]`
/// `ARGV = [est, bucketCap, poolCap, maxConc, maxReq5h, win5h, concTTL, periodTTL, periodID]`
const ORG_RESERVE_SCRIPT: &str = r#"
local est=tonumber(ARGV[1]); local bcap=tonumber(ARGV[2]); local pcap=tonumber(ARGV[3])
local maxc=tonumber(ARGV[4]); local maxr=tonumber(ARGV[5])
local win5=tonumber(ARGV[6]); local cttl=tonumber(ARGV[7]); local pttl=tonumber(ARGV[8])
local pid=ARGV[9]
local plancap=tonumber(ARGV[10] or '-1')

-- A renewal moves the period id: zero the member's bucket counter so the new
-- period starts with a full quota instead of inheriting an exhausted count. The
-- pool counter is NOT reset here — it is re-seeded from MySQL (which the renewal
-- wrote) by EnsureOrgPoolUsed, so the durable number always wins.
if pid ~= '' and redis.call('GET',KEYS[5]) ~= pid then
  redis.call('SET',KEYS[1],'0')
  redis.call('SET',KEYS[5],pid)
  if pttl>0 then
    redis.call('EXPIRE',KEYS[1],pttl)
    redis.call('EXPIRE',KEYS[5],pttl)
  end
end

local ub=tonumber(redis.call('GET',KEYS[1]) or '0')
local conc=tonumber(redis.call('GET',KEYS[2]) or '0')
local req=tonumber(redis.call('GET',KEYS[3]) or '0')
local up=tonumber(redis.call('GET',KEYS[4]) or '0')

local function deny(reason) return {0,reason,'',ub,up,redis.call('TTL',KEYS[4])} end

if maxc>0 and conc>=maxc then return deny('concurrency') end
if maxr>0 and req>=maxr then return deny('requests') end

-- The pool is the only hard limit: when it cannot cover the hold, nobody on the
-- team can spend, no matter what their personal quota says. pcap already includes
-- whatever credits the team bought this period.
if pcap>=0 and up+est>pcap then return deny('pool_limit') end

local source='pool'
if bcap<0 or ub+est<=bcap then source='bucket' end
-- Past the plan's own allowance the team is spending what it BOUGHT. Reported so
-- the ledger (and the admin) can tell subscription usage from purchased usage.
-- Deliberately overrides 'bucket': the member's soft quota says who may spend,
-- while this says whose money it was.
if plancap>=0 and up+est>plancap then source='extra' end

ub=redis.call('INCRBY',KEYS[1],est)
if ub==est and pttl>0 then redis.call('EXPIRE',KEYS[1],pttl) end
up=redis.call('INCRBY',KEYS[4],est)
if up==est and pttl>0 then redis.call('EXPIRE',KEYS[4],pttl) end

redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],cttl)
local nr=redis.call('INCR',KEYS[3]); if nr==1 then redis.call('EXPIRE',KEYS[3],win5) end
return {1,'ok',source,ub,up,redis.call('TTL',KEYS[4])}
"#;

/// Reconcile a team reservation to actuals on BOTH counters and release the
/// member's concurrency slot.
/// `KEYS = [memberUsed, conc, poolUsed]`; `ARGV = [est, actual]`
const ORG_SETTLE_SCRIPT: &str = r#"
local est=tonumber(ARGV[1]); local actual=tonumber(ARGV[2])
local d=actual-est
redis.call('INCRBY',KEYS[1],d)
redis.call('INCRBY',KEYS[3],d)
-- A refund must never leave a negative counter behind (it would read as free
-- credits for the rest of the period).
if tonumber(redis.call('GET',KEYS[1]) or '0')<0 then redis.call('SET',KEYS[1],0) end
if tonumber(redis.call('GET',KEYS[3]) or '0')<0 then redis.call('SET',KEYS[3],0) end
local c=redis.call('DECR',KEYS[2]); if c<0 then redis.call('SET',KEYS[2],0) end
return 1
"#;

/// When cap > 0, deny if used >= cap; otherwise INCR and set the end-of-day TTL on
/// first write. Returns `{ok, used, ttl}`.
const RESERVE_TURN_SCRIPT: &str = r#"
local cap=tonumber(ARGV[1]); local ttl=tonumber(ARGV[2])
local used=tonumber(redis.call('GET',KEYS[1]) or '0')
if cap>0 and used>=cap then
  return {0, used, redis.call('TTL',KEYS[1])}
end
local n=redis.call('INCR',KEYS[1])
if n==1 then redis.call('EXPIRE',KEYS[1],ttl) end
return {1, n, redis.call('TTL',KEYS[1])}
"#;

/// Decrement the day counter, flooring at 0. A missing key (new day) is a no-op.
const RELEASE_TURN_SCRIPT: &str = r#"
local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if n<=0 then return 0 end
return redis.call('DECR',KEYS[1])
"#;

/// `KEYS=[dayCounter, hold]`; `ARGV=[cap, dayTTL, holdTTL]`.
/// Returns `{ok, used, ttl, reused}`.
const RESERVE_TURN_IDEM_SCRIPT: &str = r#"
local cap=tonumber(ARGV[1]); local ttl=tonumber(ARGV[2]); local holdttl=tonumber(ARGV[3])
if redis.call('SETNX',KEYS[2],'1')==0 then
  -- This logical request already holds a turn: reuse it (no double count).
  local used=tonumber(redis.call('GET',KEYS[1]) or '0')
  return {1, used, redis.call('TTL',KEYS[1]), 1}
end
redis.call('EXPIRE',KEYS[2],holdttl)
local used=tonumber(redis.call('GET',KEYS[1]) or '0')
if cap>0 and used>=cap then
  redis.call('DEL',KEYS[2])  -- don't hold on a denial
  return {0, used, redis.call('TTL',KEYS[1]), 0}
end
local n=redis.call('INCR',KEYS[1])
if n==1 then redis.call('EXPIRE',KEYS[1],ttl) end
return {1, n, redis.call('TTL',KEYS[1]), 0}
"#;

/// `KEYS=[dayCounter, hold]`. Drops the hold (so a retry re-reserves) and
/// decrements the day counter, flooring at 0.
const RELEASE_TURN_IDEM_SCRIPT: &str = r#"
redis.call('DEL',KEYS[2])
local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if n<=0 then return 0 end
return redis.call('DECR',KEYS[1])
"#;

/// Inputs to a pre-flight reservation.
#[derive(Debug, Clone, Default)]
pub struct ReserveParams {
    pub user_id: i64,
    /// The hold, in billable tokens.
    pub est_credits: i64,
    /// Per-period allowance; [`UNLIMITED`] to skip.
    pub cap_period: i64,
    /// Seconds until the period resets (`currentPeriodEnd`).
    pub period_ttl_sec: i64,
    /// 0 = unlimited.
    pub max_concurrent: i64,
    /// 0 = unlimited.
    pub max_req_5h: i64,
    /// Allow drawing from the top-up balance when the period is exhausted.
    pub top_up_enabled: bool,
    /// Identifies the current billing period (`currentPeriodEnd`). When it changes
    /// (a renewal/upgrade), the used-credit counter is reset so the new period
    /// starts with a full allowance. Empty = no period (free/no-expiry).
    pub period_id: String,
}

/// The decision, the charge source, and period state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReserveResult {
    pub ok: bool,
    /// `"ok"` | `"concurrency"` | `"requests"` | `"period_limit"`.
    pub reason: String,
    /// `"plan"` | `"topup"` (when `ok`).
    pub source: String,
    pub used_period: i64,
    /// Seconds until the period resets; negative when Redis reports no TTL.
    pub reset_period: i64,
}

/// Live period usage for a user (for `GET /v1/credits` and the CLI display).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Status {
    pub used_period: i64,
    /// -1 when not present in Redis (the caller falls back to the DB value).
    pub topup_balance: i64,
    /// Seconds until the period resets.
    pub reset_period: i64,
}

/// Inputs to a team member's pre-flight reservation.
#[derive(Debug, Clone, Default)]
pub struct OrgReserveParams {
    pub org_id: i64,
    pub user_id: i64,
    /// The hold, in billable tokens.
    pub est_billable: i64,
    /// The member's own quota in billable tokens; [`UNLIMITED`] to skip the soft
    /// tier (the request is then always sourced from the pool).
    pub bucket_cap: i64,
    /// The team's allowance in billable tokens; [`UNLIMITED`] only for a plan with
    /// no credit allowance at all.
    pub pool_cap: i64,
    /// How much of [`Self::pool_cap`] came from PURCHASED credits rather than the
    /// plan's own allowance.
    ///
    /// It gates nothing -- the script subtracts it to know when a charge has crossed
    /// out of what the subscription paid for and into what the admin bought, so the
    /// ledger can tell subscription usage from purchased usage. Expressed as the
    /// purchased AMOUNT rather than as a boundary so a team with no purchased credits
    /// can never accidentally label plan usage as purchased.
    pub purchased_cap: i64,
    pub period_ttl_sec: i64,
    pub period_id: String,
    pub max_concurrent: i64,
    pub max_req_5h: i64,
}

/// The decision plus which tier paid.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrgReserveResult {
    pub ok: bool,
    /// `"ok"` | `"concurrency"` | `"requests"` | `"pool_limit"`.
    pub reason: String,
    /// `"bucket"` when the member's own quota covered the hold, `"pool"` when it
    /// overflowed into the shared allowance. Recorded on the ledger.
    pub source: String,
    pub used_bucket: i64,
    pub used_pool: i64,
    pub reset_pool: i64,
}

/// Live team usage for one member.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OrgStatus {
    pub used_bucket: i64,
    pub used_pool: i64,
    /// Seconds until the pool counter resets; -1 when unset.
    pub reset_pool: i64,
}

/// A daily-turn reservation decision.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TurnResult {
    pub ok: bool,
    pub used_today: i64,
    /// The cap applied (<= 0 means unlimited).
    pub limit: i64,
    /// Seconds until the daily counter resets (00:00 UTC).
    pub reset_seconds: i64,
}

/// Enforces a per-billing-period credit balance plus concurrency and request abuse
/// caps using Redis.
///
/// The period balance depletes over the billing period and resets only at renewal
/// (key TTL = time until `currentPeriodEnd`) -- there is no weekly reset. A durable
/// top-up balance is the fallback.
#[derive(Clone)]
pub struct Limiter {
    conn: ConnectionManager,
    /// Injectable so day-rollover behaviour is testable without waiting.
    now: fn() -> DateTime<Utc>,
}

impl std::fmt::Debug for Limiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Limiter")
    }
}

/// `[cwperiod, conc, req5h, topup, cwperiodid]` for a user.
fn keys_for(uid: i64) -> [String; 5] {
    [
        format!("cwperiod:{uid}"),
        format!("conc:{uid}"),
        format!("req5h:{uid}"),
        format!("topup:{uid}"),
        format!("cwperiodid:{uid}"),
    ]
}

/// `[memberUsed, conc, req5h, poolUsed, memberPeriodID]` for a seat.
///
/// Concurrency and the 5h request cap stay PER USER (they are abuse controls on a
/// person, not on a team), while the pool counter is shared by the whole org.
fn org_keys(org_id: i64, user_id: i64) -> [String; 5] {
    [
        format!("orgbucket:{org_id}:{user_id}"),
        format!("conc:{user_id}"),
        format!("req5h:{user_id}"),
        format!("orgpool:{org_id}"),
        format!("orgbucketpid:{org_id}:{user_id}"),
    ]
}

/// The per-user per-day counter key (UTC calendar day).
fn turn_key(uid: i64, now: DateTime<Utc>) -> String {
    format!("turns:{uid}:{}", now.format("%Y%m%d"))
}

/// Marks that a given logical request currently holds a daily turn.
fn turn_hold_key(uid: i64, logical_id: &str) -> String {
    format!("turnhold:{uid}:{logical_id}")
}

/// Seconds remaining until 00:00 UTC tomorrow (always >= 1) -- the daily counter's
/// TTL.
fn seconds_until_end_of_utc_day(now: DateTime<Utc>) -> i64 {
    let midnight = Utc
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .unwrap_or(now);
    let tomorrow = midnight + ChronoDuration::days(1);
    (tomorrow - now).num_seconds().max(1)
}

/// The Redis TTL for the period balance: time until the subscription renews.
///
/// 0 lets the limiter fall back to its 30-day default. Port of the server's
/// `periodTTLSeconds`.
pub fn period_ttl_seconds(period_end: Option<DateTime<Utc>>) -> i64 {
    match period_end {
        None => 0,
        Some(pe) => {
            let s = (pe - Utc::now()).num_seconds();
            // Floored at 60s: a period about to end must not produce a 1-second TTL
            // that wipes the counter mid-request.
            s.max(60)
        }
    }
}

/// A stable identifier for the current billing period (its end instant, as unix
/// seconds). Empty when there is no period (free / no-expiry).
///
/// When it changes -- a plan renewal/upgrade sets a new `currentPeriodEnd` -- the
/// limiter resets the used-credit counter so the renewed plan starts fresh instead
/// of inheriting the exhausted count.
pub fn period_id(period_end: Option<DateTime<Utc>>) -> String {
    match period_end {
        None => String::new(),
        Some(pe) => pe.timestamp().to_string(),
    }
}

/// Reads an integer out of a Lua reply, tolerating the several shapes Redis uses.
fn to_i64(v: Option<&redis::Value>) -> i64 {
    match v {
        Some(redis::Value::Int(n)) => *n,
        Some(redis::Value::BulkString(b)) => String::from_utf8_lossy(b).parse().unwrap_or(0),
        Some(redis::Value::SimpleString(s)) => s.parse().unwrap_or(0),
        Some(redis::Value::Double(d)) => *d as i64,
        _ => 0,
    }
}

/// Reads a string out of a Lua reply.
fn to_string(v: Option<&redis::Value>) -> String {
    match v {
        Some(redis::Value::BulkString(b)) => String::from_utf8_lossy(b).to_string(),
        Some(redis::Value::SimpleString(s)) => s.clone(),
        Some(redis::Value::Int(n)) => n.to_string(),
        _ => String::new(),
    }
}

impl Limiter {
    /// Builds a limiter on a Redis URL, with the standard abuse-cap windows.
    pub async fn connect(redis_url: &str) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(redis_url)?;
        let conn = ConnectionManager::new(client).await?;
        Ok(Self {
            conn,
            now: Utc::now,
        })
    }

    /// Builds a limiter on an existing connection.
    pub fn new(conn: ConnectionManager) -> Self {
        Self {
            conn,
            now: Utc::now,
        }
    }

    /// Pre-loads every script so the first real request pays `EVALSHA` rather than
    /// shipping the source.
    ///
    /// `redis-rs` already falls back from `EVALSHA` to `EVAL` on `NOSCRIPT`, so this
    /// is an optimisation and a boot-time sanity check (a syntax error surfaces
    /// here, not on a user's first chat) rather than a correctness requirement.
    /// Deletes every per-(org, member) counter, so a team test starts clean.
    #[doc(hidden)]
    pub async fn reset_org_for_tests(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<(), redis::RedisError> {
        let k = org_keys(org_id, user_id);
        let mut conn = self.conn.clone();
        let mut pipe = redis::pipe();
        for key in k.iter() {
            pipe.del(key);
        }
        pipe.query_async::<()>(&mut conn).await
    }

    /// Deletes every per-user counter, so a test starts from a known state.
    ///
    /// Test seam only: production never resets a user's counters, because that would
    /// hand back credits the user already spent.
    #[doc(hidden)]
    pub async fn reset_user_for_tests(&self, user_id: i64) -> Result<(), redis::RedisError> {
        let k = keys_for(user_id);
        let now = (self.now)();
        let mut conn = self.conn.clone();
        let mut pipe = redis::pipe();
        for key in k.iter() {
            pipe.del(key);
        }
        pipe.del(turn_key(user_id, now));
        pipe.query_async::<()>(&mut conn).await
    }

    pub async fn load_scripts(&self) -> Result<(), redis::RedisError> {
        let mut conn = self.conn.clone();
        for src in [
            RESERVE_SCRIPT,
            SETTLE_SCRIPT,
            ORG_RESERVE_SCRIPT,
            ORG_SETTLE_SCRIPT,
            RESERVE_TURN_SCRIPT,
            RELEASE_TURN_SCRIPT,
            RESERVE_TURN_IDEM_SCRIPT,
            RELEASE_TURN_IDEM_SCRIPT,
        ] {
            redis::cmd("SCRIPT")
                .arg("LOAD")
                .arg(src)
                .query_async::<String>(&mut conn)
                .await?;
        }
        Ok(())
    }

    /// Seeds the Redis top-up mirror from the MySQL balance if absent.
    pub async fn ensure_topup(
        &self,
        user_id: i64,
        balance_from_db: i64,
    ) -> Result<(), redis::RedisError> {
        let k = keys_for(user_id);
        let mut conn = self.conn.clone();
        redis::cmd("SET")
            .arg(&k[3])
            .arg(balance_from_db)
            .arg("NX")
            .arg("EX")
            .arg(TOPUP_TTL_SECS)
            .query_async::<()>(&mut conn)
            .await
    }

    /// Attempts to reserve `est_credits` against the per-period balance (or top-up).
    pub async fn reserve(&self, p: &ReserveParams) -> Result<ReserveResult, redis::RedisError> {
        let pttl = if p.period_ttl_sec <= 0 {
            DEFAULT_PERIOD_TTL_SECS
        } else {
            p.period_ttl_sec
        };
        let k = keys_for(p.user_id);
        let mut conn = self.conn.clone();

        let raw: Vec<redis::Value> = Script::new(RESERVE_SCRIPT)
            .key(&k[0])
            .key(&k[1])
            .key(&k[2])
            .key(&k[3])
            .key(&k[4])
            .arg(p.est_credits)
            .arg(p.cap_period)
            .arg(p.max_concurrent)
            .arg(p.max_req_5h)
            .arg(WIN_5H_SECS)
            .arg(CONC_TTL_SECS)
            .arg(pttl)
            .arg(i64::from(p.top_up_enabled))
            .arg(p.period_id.as_str())
            .invoke_async(&mut conn)
            .await?;

        Ok(ReserveResult {
            ok: to_i64(raw.first()) == 1,
            reason: to_string(raw.get(1)),
            source: to_string(raw.get(2)),
            used_period: to_i64(raw.get(3)),
            reset_period: to_i64(raw.get(4)),
        })
    }

    /// Reconciles a reservation to the actual credits consumed (per source) and
    /// releases the concurrency slot.
    ///
    /// Always call this from a detached task: the request context may already be
    /// cancelling when the stream ends.
    pub async fn settle(
        &self,
        user_id: i64,
        source: &str,
        est_credits: i64,
        actual_credits: i64,
    ) -> Result<(), redis::RedisError> {
        let k = keys_for(user_id);
        let mut conn = self.conn.clone();
        Script::new(SETTLE_SCRIPT)
            .key(&k[0])
            .key(&k[1])
            .key(&k[3])
            .arg(source)
            .arg(est_credits)
            .arg(actual_credits)
            .invoke_async::<()>(&mut conn)
            .await
    }

    /// Refunds a reservation entirely (actual = 0) and frees the slot.
    pub async fn release(
        &self,
        user_id: i64,
        source: &str,
        est_credits: i64,
    ) -> Result<(), redis::RedisError> {
        self.settle(user_id, source, est_credits, 0).await
    }

    /// Reads the current period counter, TTL and top-up for a user.
    pub async fn status(&self, user_id: i64) -> Result<Status, redis::RedisError> {
        let k = keys_for(user_id);
        let mut conn = self.conn.clone();
        let (used, topup, ttl): (Option<i64>, Option<i64>, i64) = redis::pipe()
            .get(&k[0])
            .get(&k[3])
            .ttl(&k[0])
            .query_async(&mut conn)
            .await?;

        Ok(Status {
            used_period: used.unwrap_or(0),
            // -1 when absent, so the caller knows to fall back to the DB balance.
            topup_balance: topup.unwrap_or(-1),
            // Go converts Redis's -1/-2 sentinel through a nanosecond Duration,
            // which truncates to 0 seconds. There is deliberately no `> 0` guard
            // here (unlike TurnsToday/OrgStatus), so a missing key reports 0.
            reset_period: ttl.max(0),
        })
    }

    // --- teams --------------------------------------------------------------

    /// Seeds the Redis pool counter from the DURABLE MySQL value if absent.
    ///
    /// Without this, a gateway restart mid-period would start the pool back at zero
    /// and over-grant the team; with it, MySQL is the source of truth on every cold
    /// start and Redis is only the fast path in between.
    pub async fn ensure_org_pool_used(
        &self,
        org_id: i64,
        used_from_db: i64,
        ttl_sec: i64,
    ) -> Result<(), redis::RedisError> {
        let ttl = if ttl_sec <= 0 {
            DEFAULT_PERIOD_TTL_SECS
        } else {
            ttl_sec
        };
        let k = org_keys(org_id, 0);
        let mut conn = self.conn.clone();
        redis::cmd("SET")
            .arg(&k[3])
            .arg(used_from_db)
            .arg("NX")
            .arg("EX")
            .arg(ttl)
            .query_async::<()>(&mut conn)
            .await
    }

    /// Seeds a member's bucket counter from MySQL (quota minus what is left).
    pub async fn ensure_org_bucket_used(
        &self,
        org_id: i64,
        user_id: i64,
        used_from_db: i64,
        ttl_sec: i64,
    ) -> Result<(), redis::RedisError> {
        let ttl = if ttl_sec <= 0 {
            DEFAULT_PERIOD_TTL_SECS
        } else {
            ttl_sec
        };
        let k = org_keys(org_id, user_id);
        let mut conn = self.conn.clone();
        redis::cmd("SET")
            .arg(&k[0])
            .arg(used_from_db)
            .arg("NX")
            .arg("EX")
            .arg(ttl)
            .query_async::<()>(&mut conn)
            .await
    }

    /// Holds `est_billable` against the member's bucket and the org pool.
    pub async fn reserve_org(
        &self,
        p: &OrgReserveParams,
    ) -> Result<OrgReserveResult, redis::RedisError> {
        let pttl = if p.period_ttl_sec <= 0 {
            DEFAULT_PERIOD_TTL_SECS
        } else {
            p.period_ttl_sec
        };
        let plan_cap = if p.pool_cap >= 0 {
            (p.pool_cap - p.purchased_cap).max(0)
        } else {
            UNLIMITED
        };
        let k = org_keys(p.org_id, p.user_id);
        let mut conn = self.conn.clone();

        let raw: Vec<redis::Value> = Script::new(ORG_RESERVE_SCRIPT)
            .key(&k[0])
            .key(&k[1])
            .key(&k[2])
            .key(&k[3])
            .key(&k[4])
            .arg(p.est_billable)
            .arg(p.bucket_cap)
            .arg(p.pool_cap)
            .arg(p.max_concurrent)
            .arg(p.max_req_5h)
            .arg(WIN_5H_SECS)
            .arg(CONC_TTL_SECS)
            .arg(pttl)
            .arg(p.period_id.as_str())
            // ARGV[10]: the plan's OWN allowance = the cap minus what was bought. An
            // unlimited pool has no such line (nothing can overflow into purchased
            // credits), so it stays UNLIMITED and the script never labels a charge
            // "extra".
            .arg(plan_cap)
            .invoke_async(&mut conn)
            .await?;

        Ok(OrgReserveResult {
            ok: to_i64(raw.first()) == 1,
            reason: to_string(raw.get(1)),
            source: to_string(raw.get(2)),
            used_bucket: to_i64(raw.get(3)),
            used_pool: to_i64(raw.get(4)),
            reset_pool: to_i64(raw.get(5)),
        })
    }

    /// Reconciles a team reservation to the actual billable tokens consumed and
    /// frees the member's concurrency slot.
    pub async fn settle_org(
        &self,
        org_id: i64,
        user_id: i64,
        est_billable: i64,
        actual_billable: i64,
    ) -> Result<(), redis::RedisError> {
        let k = org_keys(org_id, user_id);
        let mut conn = self.conn.clone();
        Script::new(ORG_SETTLE_SCRIPT)
            .key(&k[0])
            .key(&k[1])
            .key(&k[3])
            .arg(est_billable)
            .arg(actual_billable)
            .invoke_async::<()>(&mut conn)
            .await
    }

    /// Refunds a team reservation entirely (actual = 0).
    pub async fn release_org(
        &self,
        org_id: i64,
        user_id: i64,
        est_billable: i64,
    ) -> Result<(), redis::RedisError> {
        self.settle_org(org_id, user_id, est_billable, 0).await
    }

    /// Reads the member's bucket counter and the org pool counter.
    pub async fn org_status(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<OrgStatus, redis::RedisError> {
        let k = org_keys(org_id, user_id);
        let mut conn = self.conn.clone();
        let (bucket, pool, ttl): (Option<i64>, Option<i64>, i64) = redis::pipe()
            .get(&k[0])
            .get(&k[3])
            .ttl(&k[3])
            .query_async(&mut conn)
            .await?;

        Ok(OrgStatus {
            used_bucket: bucket.unwrap_or(0),
            used_pool: pool.unwrap_or(0),
            // Unlike `status`, Go guards on `d > 0` here, so an absent counter
            // reports -1 rather than 0.
            reset_pool: if ttl > 0 { ttl } else { -1 },
        })
    }

    // --- per-day turn cap ---------------------------------------------------

    /// Atomically counts one turn against the per-day cap.
    ///
    /// `cap <= 0` is unlimited (still counted, so usage can be displayed). Denies
    /// once the cap is reached.
    pub async fn reserve_turn(
        &self,
        user_id: i64,
        cap: i64,
    ) -> Result<TurnResult, redis::RedisError> {
        let now = (self.now)();
        let ttl = seconds_until_end_of_utc_day(now);
        let mut conn = self.conn.clone();

        let raw: Vec<redis::Value> = Script::new(RESERVE_TURN_SCRIPT)
            .key(turn_key(user_id, now))
            .arg(cap)
            .arg(ttl)
            .invoke_async(&mut conn)
            .await?;

        Ok(TurnResult {
            ok: to_i64(raw.first()) == 1,
            used_today: to_i64(raw.get(1)),
            limit: cap,
            reset_seconds: to_i64(raw.get(2)),
        })
    }

    /// Refunds a previously reserved turn (used when the request did not actually
    /// proceed, e.g. a credit denial). Floors at 0; safe across a day rollover.
    pub async fn release_turn(&self, user_id: i64) -> Result<(), redis::RedisError> {
        let now = (self.now)();
        let mut conn = self.conn.clone();
        Script::new(RELEASE_TURN_SCRIPT)
            .key(turn_key(user_id, now))
            .invoke_async::<()>(&mut conn)
            .await
    }

    /// [`Limiter::reserve_turn`], deduped by `logical_id` so retries of the same
    /// logical request reserve at most one turn.
    ///
    /// The CLI retries a failed request several times, and each physical attempt
    /// hits the gateway. Counting every attempt would let a single logical request
    /// burn many daily turns. An empty `logical_id` falls back to the per-attempt
    /// form.
    pub async fn reserve_turn_for(
        &self,
        user_id: i64,
        cap: i64,
        logical_id: &str,
    ) -> Result<TurnResult, redis::RedisError> {
        if logical_id.is_empty() {
            return self.reserve_turn(user_id, cap).await;
        }
        let now = (self.now)();
        let ttl = seconds_until_end_of_utc_day(now);
        let mut conn = self.conn.clone();

        let raw: Vec<redis::Value> = Script::new(RESERVE_TURN_IDEM_SCRIPT)
            .key(turn_key(user_id, now))
            .key(turn_hold_key(user_id, logical_id))
            .arg(cap)
            .arg(ttl)
            .arg(ttl)
            .invoke_async(&mut conn)
            .await?;

        Ok(TurnResult {
            ok: to_i64(raw.first()) == 1,
            used_today: to_i64(raw.get(1)),
            limit: cap,
            reset_seconds: to_i64(raw.get(2)),
        })
    }

    /// Refunds a turn reserved via [`Limiter::reserve_turn_for`] and clears the hold
    /// so a subsequent retry of the same logical request can reserve again.
    pub async fn release_turn_for(
        &self,
        user_id: i64,
        logical_id: &str,
    ) -> Result<(), redis::RedisError> {
        if logical_id.is_empty() {
            return self.release_turn(user_id).await;
        }
        let now = (self.now)();
        let mut conn = self.conn.clone();
        Script::new(RELEASE_TURN_IDEM_SCRIPT)
            .key(turn_key(user_id, now))
            .key(turn_hold_key(user_id, logical_id))
            .invoke_async::<()>(&mut conn)
            .await
    }

    /// The current per-day turn count and seconds-until-reset, for display.
    ///
    /// `reset_seconds` is -1 when no turns have been used today.
    pub async fn turns_today(&self, user_id: i64) -> Result<(i64, i64), redis::RedisError> {
        let now = (self.now)();
        let k = turn_key(user_id, now);
        let mut conn = self.conn.clone();
        let (used, ttl): (Option<i64>, i64) =
            redis::pipe().get(&k).ttl(&k).query_async(&mut conn).await?;
        Ok((used.unwrap_or(0), if ttl > 0 { ttl } else { -1 }))
    }
}
