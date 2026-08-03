package credits

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Unlimited disables a credit cap.
const Unlimited = int64(-1)

// Limiter enforces a per-billing-period credit balance plus concurrency and
// request abuse caps using Redis. The period balance depletes over the billing
// period and resets only at renewal (key TTL = time until currentPeriodEnd) —
// there is no weekly reset. A durable top-up balance is the fallback.
type Limiter struct {
	rdb      redis.UniversalClient
	win5h    time.Duration // window for the requests/5h abuse cap
	concTTL  time.Duration // self-heal TTL for the concurrency counter
	topupTTL time.Duration // re-sync TTL for the top-up mirror
}

// NewLimiter builds a limiter with the standard abuse-cap windows.
func NewLimiter(rdb redis.UniversalClient) *Limiter {
	return &Limiter{
		rdb:      rdb,
		win5h:    5 * time.Hour,
		concTTL:  10 * time.Minute,
		topupTTL: 5 * time.Minute,
	}
}

// ReserveParams are the inputs to a pre-flight reservation.
type ReserveParams struct {
	UserID        int64
	EstCredits    int64
	CapPeriod     int64 // per-period allowance; Unlimited to skip
	PeriodTTLSec  int   // seconds until the period resets (currentPeriodEnd)
	MaxConcurrent int   // 0 = unlimited
	MaxReq5h      int   // 0 = unlimited
	TopUpEnabled  bool  // allow drawing from the top-up balance when the period is exhausted
	// PeriodID identifies the current billing period (currentPeriodEnd). When it
	// changes (a renewal/upgrade), the used-credit counter is reset so the new
	// period starts with a full allowance. Empty = no period (free/no-expiry).
	PeriodID string
}

// ReserveResult reports the decision, the charge source, and period state.
type ReserveResult struct {
	OK          bool
	Reason      string // "ok" | "concurrency" | "requests" | "period_limit"
	Source      string // "plan" | "topup" (when OK)
	UsedPeriod  int64
	ResetPeriod int64 // seconds until the period resets; <0 if none
}

// keysFor returns [cwperiod, conc, req5h, topup, cwperiodid] for a user.
func keysFor(uid int64) []string {
	u := strconv.FormatInt(uid, 10)
	return []string{"cwperiod:" + u, "conc:" + u, "req5h:" + u, "topup:" + u, "cwperiodid:" + u}
}

// reserveScript: enforce concurrency/request caps, then charge the per-period
// balance if it fits, else the top-up balance (if enabled), else deny.
// Returns {ok, reason, source, usedPeriod, ttlPeriod}.
var reserveScript = redis.NewScript(`
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
`)

// settleScript reconciles a reservation to actuals (period balance or top-up
// per source) and releases one concurrency slot.
// KEYS=[cwperiod, conc, topup]; ARGV=[source, est, actual].
var settleScript = redis.NewScript(`
local source=ARGV[1]; local est=tonumber(ARGV[2]); local actual=tonumber(ARGV[3])
if source=='plan' then
  redis.call('INCRBY',KEYS[1],actual-est)
elseif source=='topup' then
  redis.call('INCRBY',KEYS[3],est-actual)
end
local c=redis.call('DECR',KEYS[2]); if c<0 then redis.call('SET',KEYS[2],0) end
return 1
`)

func toInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	default:
		return 0
	}
}

// EnsureTopup seeds the Redis top-up mirror from the MySQL balance if absent.
func (l *Limiter) EnsureTopup(ctx context.Context, userID, balanceFromDB int64) error {
	k := keysFor(userID)
	return l.rdb.SetNX(ctx, k[3], balanceFromDB, l.topupTTL).Err()
}

// Reserve attempts to reserve EstCredits against the per-period balance (or top-up).
func (l *Limiter) Reserve(ctx context.Context, p ReserveParams) (ReserveResult, error) {
	topup := 0
	if p.TopUpEnabled {
		topup = 1
	}
	pttl := p.PeriodTTLSec
	if pttl <= 0 {
		pttl = int((30 * 24 * time.Hour).Seconds()) // default 30d if unknown
	}
	raw, err := reserveScript.Run(ctx, l.rdb, keysFor(p.UserID),
		p.EstCredits, p.CapPeriod, p.MaxConcurrent, p.MaxReq5h,
		int(l.win5h.Seconds()), int(l.concTTL.Seconds()), pttl, topup, p.PeriodID,
	).Result()
	if err != nil {
		return ReserveResult{}, err
	}
	arr, ok := raw.([]any)
	if !ok || len(arr) < 5 {
		return ReserveResult{}, fmt.Errorf("unexpected reserve reply: %v", raw)
	}
	reason, _ := arr[1].(string)
	source, _ := arr[2].(string)
	return ReserveResult{
		OK:          toInt(arr[0]) == 1,
		Reason:      reason,
		Source:      source,
		UsedPeriod:  toInt(arr[3]),
		ResetPeriod: toInt(arr[4]),
	}, nil
}

// Settle reconciles a reservation to the actual credits consumed (per source)
// and releases the concurrency slot. Use a background context.
func (l *Limiter) Settle(ctx context.Context, userID int64, source string, estCredits, actualCredits int64) error {
	k := keysFor(userID)
	return settleScript.Run(ctx, l.rdb, []string{k[0], k[1], k[3]}, source, estCredits, actualCredits).Err()
}

// Release refunds a reservation entirely (actual=0) and frees the slot.
func (l *Limiter) Release(ctx context.Context, userID int64, source string, estCredits int64) error {
	return l.Settle(ctx, userID, source, estCredits, 0)
}

// Status is the live period usage for a user (for GET /v1/credits + CLI display).
type Status struct {
	UsedPeriod   int64
	TopupBalance int64 // -1 when not present in Redis (caller falls back to DB)
	ResetPeriod  int64 // seconds until the period resets; <0 if none
}

// Status reads the current period counter + TTL + top-up for a user.
func (l *Limiter) Status(ctx context.Context, userID int64) (Status, error) {
	k := keysFor(userID)
	pipe := l.rdb.Pipeline()
	gp := pipe.Get(ctx, k[0])
	gt := pipe.Get(ctx, k[3])
	tp := pipe.TTL(ctx, k[0])
	_, _ = pipe.Exec(ctx) // per-command redis.Nil is expected for missing keys

	used := int64(0)
	if v, err := gp.Int64(); err == nil {
		used = v
	}
	topup := int64(-1)
	if v, err := gt.Int64(); err == nil {
		topup = v
	}
	reset := int64(-1)
	if d, err := tp.Result(); err == nil {
		reset = int64(d.Seconds())
	}
	return Status{UsedPeriod: used, TopupBalance: topup, ResetPeriod: reset}, nil
}

// --- Team (organization) reservations --------------------------------------
//
// A team member is billed against TWO tiers at once: their own per-seat bucket
// (a soft quota) and the org's shared pool (the hard cap). Both counters move on
// every charge, which is what lets a team invite unlimited members and still be
// capped by exactly one number — the pool.
//
// This is deliberately a separate script from the individual reserve rather than
// a flag on it: the individual path's second tier (top-up) is a per-user BALANCE
// that only pays when the plan tier is full, while the pool is a per-ORG counter
// that pays on every request. Overloading one script with both meanings is how
// billing code grows bugs nobody can read.

// orgKeys returns [memberUsed, conc, req5h, poolUsed, memberPeriodID] for a seat.
// Concurrency and the 5h request cap stay PER USER (they are abuse controls on a
// person, not on a team), while the pool counter is shared by the whole org.
func orgKeys(orgID, userID int64) []string {
	o := strconv.FormatInt(orgID, 10)
	u := strconv.FormatInt(userID, 10)
	return []string{
		"orgbucket:" + o + ":" + u,
		"conc:" + u,
		"req5h:" + u,
		"orgpool:" + o,
		"orgbucketpid:" + o + ":" + u,
	}
}

// OrgReserveParams are the inputs to a team member's pre-flight reservation.
type OrgReserveParams struct {
	OrgID  int64
	UserID int64
	// EstBillable is the pre-flight hold in billable tokens (see credits.go).
	EstBillable int64
	// BucketCap is the member's own quota in billable tokens; Unlimited to skip
	// the soft tier (the request is then always sourced from the pool).
	BucketCap int64
	// PoolCap is the team's remaining allowance in billable tokens; Unlimited
	// only for a plan with no credit allowance at all. It INCLUDES anything the
	// team bought this period — purchased credits raise the hard cap.
	PoolCap int64
	// PurchasedCap is how much of PoolCap came from PURCHASED credits rather than
	// from the plan (billable tokens; 0 when the team bought nothing).
	//
	// It gates nothing. Subtracted from PoolCap it gives the line at which a
	// charge stops being "what the subscription paid for" and becomes "what the
	// admin bought", which is what the ledger records and what the dashboard
	// reports back to the buyer. Expressed as the purchased amount rather than as
	// that line so the ZERO VALUE is correct: a caller that knows nothing about
	// purchased credits can never accidentally label plan usage as purchased.
	PurchasedCap  int64
	PeriodTTLSec  int
	PeriodID      string
	MaxConcurrent int
	MaxReq5h      int
}

// OrgReserveResult reports the decision plus which tier paid.
type OrgReserveResult struct {
	OK     bool
	Reason string // "ok" | "concurrency" | "requests" | "pool_limit"
	// Source is "bucket" when the member's own quota covered the hold, "pool"
	// when it overflowed into the plan's shared allowance, and "extra" when it
	// went past that into credits the team bought. Recorded on the ledger.
	Source     string
	UsedBucket int64
	UsedPool   int64
	ResetPool  int64 // seconds until the pool counter resets; <0 if none
}

// orgReserveScript enforces the abuse caps, then the POOL (hard cap), then
// classifies the charge as bucket vs pool vs extra. Both counters are incremented
// on every accepted request.
//
// KEYS = [memberUsed, conc, req5h, poolUsed, memberPeriodID]
// ARGV = [est, bucketCap, poolCap, maxConc, maxReq5h, win5h, concTTL, periodTTL, periodID, planPoolCap]
var orgReserveScript = redis.NewScript(`
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
`)

// orgSettleScript reconciles a team reservation to actuals on BOTH counters and
// releases the member's concurrency slot.
// KEYS = [memberUsed, conc, poolUsed]; ARGV = [est, actual]
var orgSettleScript = redis.NewScript(`
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
`)

// EnsureOrgPoolUsed seeds the Redis pool counter from the DURABLE MySQL value if
// it is absent. Without this, a gateway restart mid-period would start the pool
// back at zero and over-grant the team; with it, MySQL is the source of truth on
// every cold start and Redis is only the fast path in between.
func (l *Limiter) EnsureOrgPoolUsed(ctx context.Context, orgID, usedFromDB int64, ttlSec int) error {
	if ttlSec <= 0 {
		ttlSec = int((30 * 24 * time.Hour).Seconds())
	}
	k := orgKeys(orgID, 0)
	return l.rdb.SetNX(ctx, k[3], usedFromDB, time.Duration(ttlSec)*time.Second).Err()
}

// EnsureOrgBucketUsed seeds a member's bucket counter from MySQL (quota minus
// what is left) for the same reason as EnsureOrgPoolUsed.
func (l *Limiter) EnsureOrgBucketUsed(ctx context.Context, orgID, userID, usedFromDB int64, ttlSec int) error {
	if ttlSec <= 0 {
		ttlSec = int((30 * 24 * time.Hour).Seconds())
	}
	k := orgKeys(orgID, userID)
	return l.rdb.SetNX(ctx, k[0], usedFromDB, time.Duration(ttlSec)*time.Second).Err()
}

// ReserveOrg holds EstBillable against the member's bucket and the org pool.
func (l *Limiter) ReserveOrg(ctx context.Context, p OrgReserveParams) (OrgReserveResult, error) {
	pttl := p.PeriodTTLSec
	if pttl <= 0 {
		pttl = int((30 * 24 * time.Hour).Seconds())
	}
	// The plan's own allowance = the cap minus what was bought. An unlimited pool
	// has no such line (nothing can overflow into purchased credits), so it stays
	// Unlimited and the script never labels a charge "extra".
	planCap := Unlimited
	if p.PoolCap >= 0 {
		planCap = p.PoolCap - p.PurchasedCap
		if planCap < 0 {
			planCap = 0
		}
	}
	raw, err := orgReserveScript.Run(ctx, l.rdb, orgKeys(p.OrgID, p.UserID),
		p.EstBillable, p.BucketCap, p.PoolCap, p.MaxConcurrent, p.MaxReq5h,
		int(l.win5h.Seconds()), int(l.concTTL.Seconds()), pttl, p.PeriodID,
		planCap,
	).Result()
	if err != nil {
		return OrgReserveResult{}, err
	}
	arr, ok := raw.([]any)
	if !ok || len(arr) < 6 {
		return OrgReserveResult{}, fmt.Errorf("unexpected org reserve reply: %v", raw)
	}
	reason, _ := arr[1].(string)
	source, _ := arr[2].(string)
	return OrgReserveResult{
		OK:         toInt(arr[0]) == 1,
		Reason:     reason,
		Source:     source,
		UsedBucket: toInt(arr[3]),
		UsedPool:   toInt(arr[4]),
		ResetPool:  toInt(arr[5]),
	}, nil
}

// SettleOrg reconciles a team reservation to the actual billable tokens consumed
// and frees the member's concurrency slot. Use a background context.
func (l *Limiter) SettleOrg(ctx context.Context, orgID, userID, estBillable, actualBillable int64) error {
	k := orgKeys(orgID, userID)
	return orgSettleScript.Run(ctx, l.rdb, []string{k[0], k[1], k[3]}, estBillable, actualBillable).Err()
}

// ReleaseOrg refunds a team reservation entirely (actual = 0).
func (l *Limiter) ReleaseOrg(ctx context.Context, orgID, userID, estBillable int64) error {
	return l.SettleOrg(ctx, orgID, userID, estBillable, 0)
}

// OrgStatus is the live team usage for one member (GET /v1/credits).
type OrgStatus struct {
	UsedBucket int64
	UsedPool   int64
	ResetPool  int64 // seconds until the pool counter resets; -1 when unset
}

// OrgStatus reads the member's bucket counter and the org pool counter.
func (l *Limiter) OrgStatus(ctx context.Context, orgID, userID int64) (OrgStatus, error) {
	k := orgKeys(orgID, userID)
	pipe := l.rdb.Pipeline()
	gb := pipe.Get(ctx, k[0])
	gp := pipe.Get(ctx, k[3])
	tp := pipe.TTL(ctx, k[3])
	_, _ = pipe.Exec(ctx) // redis.Nil for a missing key is expected

	out := OrgStatus{ResetPool: -1}
	if v, err := gb.Int64(); err == nil {
		out.UsedBucket = v
	}
	if v, err := gp.Int64(); err == nil {
		out.UsedPool = v
	}
	if d, err := tp.Result(); err == nil && d > 0 {
		out.ResetPool = int64(d.Seconds())
	}
	return out, nil
}

// --- Per-day turn cap (maxDailyTurns) -------------------------------------
//
// A separate, simpler limiter than the credit balance: it counts "turns"
// (chat/proxy requests) per user per UTC day and denies once the plan's
// maxDailyTurns cap is reached. The counter key expires at 00:00 UTC so it
// resets daily without a cron. A cap <= 0 means unlimited (turns are still
// counted so usage can be displayed).

// turnKey is the per-user per-day counter key (UTC calendar day).
func turnKey(uid int64, now time.Time) string {
	return "turns:" + strconv.FormatInt(uid, 10) + ":" + now.UTC().Format("20060102")
}

// secondsUntilEndOfUTCDay returns seconds remaining until 00:00 UTC tomorrow
// (always >= 1) — used as the daily counter's TTL.
func secondsUntilEndOfUTCDay(now time.Time) int {
	n := now.UTC()
	tomorrow := time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
	s := int(tomorrow.Sub(n).Seconds())
	if s < 1 {
		s = 1
	}
	return s
}

// TurnResult reports a daily-turn reservation decision.
type TurnResult struct {
	OK           bool
	UsedToday    int64
	Limit        int64 // the cap applied (<= 0 means unlimited)
	ResetSeconds int64 // seconds until the daily counter resets (00:00 UTC)
}

// reserveTurnScript: when cap > 0, deny if used >= cap; otherwise INCR and set
// the end-of-day TTL on first write. Returns {ok, used, ttl}.
var reserveTurnScript = redis.NewScript(`
local cap=tonumber(ARGV[1]); local ttl=tonumber(ARGV[2])
local used=tonumber(redis.call('GET',KEYS[1]) or '0')
if cap>0 and used>=cap then
  return {0, used, redis.call('TTL',KEYS[1])}
end
local n=redis.call('INCR',KEYS[1])
if n==1 then redis.call('EXPIRE',KEYS[1],ttl) end
return {1, n, redis.call('TTL',KEYS[1])}
`)

// ReserveTurn atomically counts one turn against the per-day cap. cap <= 0 is
// unlimited (still counted). Denies (OK=false) once the cap is reached.
func (l *Limiter) ReserveTurn(ctx context.Context, userID, cap int64) (TurnResult, error) {
	now := time.Now()
	ttl := secondsUntilEndOfUTCDay(now)
	raw, err := reserveTurnScript.Run(ctx, l.rdb, []string{turnKey(userID, now)}, cap, ttl).Result()
	if err != nil {
		return TurnResult{}, err
	}
	arr, ok := raw.([]any)
	if !ok || len(arr) < 3 {
		return TurnResult{}, fmt.Errorf("unexpected reserveTurn reply: %v", raw)
	}
	return TurnResult{
		OK:           toInt(arr[0]) == 1,
		UsedToday:    toInt(arr[1]),
		Limit:        cap,
		ResetSeconds: toInt(arr[2]),
	}, nil
}

// releaseTurnScript decrements the day counter, flooring at 0. A missing key
// (new day) is a no-op.
var releaseTurnScript = redis.NewScript(`
local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if n<=0 then return 0 end
return redis.call('DECR',KEYS[1])
`)

// ReleaseTurn refunds a previously reserved turn (used when the request did not
// actually proceed, e.g. a credit denial). Floors at 0; safe across day rollover.
func (l *Limiter) ReleaseTurn(ctx context.Context, userID int64) error {
	now := time.Now()
	return releaseTurnScript.Run(ctx, l.rdb, []string{turnKey(userID, now)}).Err()
}

// --- Idempotent-by-logical-request-id turn accounting ---------------------
//
// The CLI retries a failed request (transient upstream 5xx/429/connection blip)
// several times, and each physical attempt hits /v1/proxy. Counting every
// attempt would let a single logical request burn many daily turns. These
// variants dedupe by a stable logical request id: the FIRST attempt reserves,
// repeat attempts that still HOLD the reservation reuse it (no double count),
// and a release (on failure) drops the hold so the next retry re-reserves — so
// one logical request consumes at most one turn regardless of retry count.

// turnHoldKey marks that a given logical request currently holds a daily turn.
func turnHoldKey(uid int64, logicalID string) string {
	return "turnhold:" + strconv.FormatInt(uid, 10) + ":" + logicalID
}

// reserveTurnIdemScript: KEYS=[dayCounter, hold]; ARGV=[cap, dayTTL, holdTTL].
// Returns {ok, used, ttl, reused}.
var reserveTurnIdemScript = redis.NewScript(`
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
`)

// ReserveTurnFor is ReserveTurn, deduped by logicalID so retries of the same
// logical request reserve at most one turn. Empty logicalID falls back to the
// per-attempt ReserveTurn.
func (l *Limiter) ReserveTurnFor(ctx context.Context, userID, cap int64, logicalID string) (TurnResult, error) {
	if logicalID == "" {
		return l.ReserveTurn(ctx, userID, cap)
	}
	now := time.Now()
	ttl := secondsUntilEndOfUTCDay(now)
	raw, err := reserveTurnIdemScript.Run(ctx, l.rdb,
		[]string{turnKey(userID, now), turnHoldKey(userID, logicalID)},
		cap, ttl, ttl,
	).Result()
	if err != nil {
		return TurnResult{}, err
	}
	arr, ok := raw.([]any)
	if !ok || len(arr) < 3 {
		return TurnResult{}, fmt.Errorf("unexpected reserveTurnFor reply: %v", raw)
	}
	return TurnResult{
		OK:           toInt(arr[0]) == 1,
		UsedToday:    toInt(arr[1]),
		Limit:        cap,
		ResetSeconds: toInt(arr[2]),
	}, nil
}

// releaseTurnIdemScript: KEYS=[dayCounter, hold]. Drops the hold (so a retry
// re-reserves) and decrements the day counter, flooring at 0.
var releaseTurnIdemScript = redis.NewScript(`
redis.call('DEL',KEYS[2])
local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if n<=0 then return 0 end
return redis.call('DECR',KEYS[1])
`)

// ReleaseTurnFor refunds a turn reserved via ReserveTurnFor and clears the hold
// so a subsequent retry of the same logical request can reserve again. Empty
// logicalID falls back to ReleaseTurn.
func (l *Limiter) ReleaseTurnFor(ctx context.Context, userID int64, logicalID string) error {
	if logicalID == "" {
		return l.ReleaseTurn(ctx, userID)
	}
	now := time.Now()
	return releaseTurnIdemScript.Run(ctx, l.rdb,
		[]string{turnKey(userID, now), turnHoldKey(userID, logicalID)}).Err()
}

// TurnsToday returns the current per-day turn count and seconds-until-reset for
// display (GET /v1/credits). resetSeconds is -1 when no turns have been used today.
func (l *Limiter) TurnsToday(ctx context.Context, userID int64) (used, resetSeconds int64, err error) {
	now := time.Now()
	k := turnKey(userID, now)
	pipe := l.rdb.Pipeline()
	g := pipe.Get(ctx, k)
	tp := pipe.TTL(ctx, k)
	_, _ = pipe.Exec(ctx) // redis.Nil for a missing key is expected
	resetSeconds = -1
	if v, e := g.Int64(); e == nil {
		used = v
	}
	if d, e := tp.Result(); e == nil && d > 0 {
		resetSeconds = int64(d.Seconds())
	}
	return used, resetSeconds, nil
}
