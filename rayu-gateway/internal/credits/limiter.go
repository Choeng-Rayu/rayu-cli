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
	UserID       int64
	EstCredits   int64
	CapPeriod    int64 // per-period allowance; Unlimited to skip
	PeriodTTLSec int   // seconds until the period resets (currentPeriodEnd)
	MaxConcurrent int  // 0 = unlimited
	MaxReq5h      int  // 0 = unlimited
	TopUpEnabled bool  // allow drawing from the top-up balance when the period is exhausted
}

// ReserveResult reports the decision, the charge source, and period state.
type ReserveResult struct {
	OK          bool
	Reason      string // "ok" | "concurrency" | "requests" | "period_limit"
	Source      string // "plan" | "topup" (when OK)
	UsedPeriod  int64
	ResetPeriod int64 // seconds until the period resets; <0 if none
}

// keysFor returns [cwperiod, conc, req5h, topup] for a user.
func keysFor(uid int64) []string {
	u := strconv.FormatInt(uid, 10)
	return []string{"cwperiod:" + u, "conc:" + u, "req5h:" + u, "topup:" + u}
}

// reserveScript: enforce concurrency/request caps, then charge the per-period
// balance if it fits, else the top-up balance (if enabled), else deny.
// Returns {ok, reason, source, usedPeriod, ttlPeriod}.
var reserveScript = redis.NewScript(`
local est=tonumber(ARGV[1]); local capp=tonumber(ARGV[2])
local maxc=tonumber(ARGV[3]); local maxr=tonumber(ARGV[4])
local win5=tonumber(ARGV[5]); local cttl=tonumber(ARGV[6]); local pttl=tonumber(ARGV[7])
local topup=tonumber(ARGV[8])

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
		int(l.win5h.Seconds()), int(l.concTTL.Seconds()), pttl, topup,
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