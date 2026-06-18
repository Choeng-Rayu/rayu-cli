package credits

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Unlimited disables a credit cap (plan with no creditsPerWeek/creditsPer5h).
const Unlimited = int64(-1)

// Limiter enforces fixed 5h + weekly credit windows plus concurrency and
// request caps using Redis, with a durable top-up balance fallback. Windows
// reset via key TTL; the top-up mirror re-syncs from MySQL on a short TTL.
type Limiter struct {
	rdb      redis.UniversalClient
	win5h    time.Duration
	winWk    time.Duration
	concTTL  time.Duration
	topupTTL time.Duration
}

// NewLimiter builds a limiter with the standard 5h/weekly windows.
func NewLimiter(rdb redis.UniversalClient) *Limiter {
	return &Limiter{
		rdb:      rdb,
		win5h:    5 * time.Hour,
		winWk:    7 * 24 * time.Hour,
		concTTL:  10 * time.Minute,
		topupTTL: 5 * time.Minute,
	}
}

// ReserveParams are the inputs to a pre-flight reservation.
type ReserveParams struct {
	UserID        int64
	EstCredits    int64
	Cap5h         int64 // Unlimited to skip
	CapWeek       int64 // Unlimited to skip
	MaxConcurrent int   // 0 = unlimited
	MaxReq5h      int   // 0 = unlimited
	TopUpEnabled  bool  // allow drawing from the top-up balance when windows are full
}

// ReserveResult reports the decision, the charge source, and window state.
type ReserveResult struct {
	OK        bool
	Reason    string // "ok" | "concurrency" | "requests" | "5h_limit" | "weekly_limit"
	Source    string // "plan" | "topup" (when OK)
	Used5h    int64
	UsedWeek  int64
	Reset5h   int64
	ResetWeek int64
}

// keysFor returns [cw5h, cwwk, conc, req5h, topup] for a user.
func keysFor(uid int64) []string {
	u := strconv.FormatInt(uid, 10)
	return []string{"cw5h:" + u, "cwwk:" + u, "conc:" + u, "req5h:" + u, "topup:" + u}
}

// reserveScript: enforces concurrency/request caps, then charges the plan window
// if it fits, else the top-up balance (if enabled and sufficient), else denies.
// Returns {ok, reason, source, used5h, usedWeek, ttl5h, ttlWeek}.
var reserveScript = redis.NewScript(`
local est=tonumber(ARGV[1]); local cap5=tonumber(ARGV[2]); local capw=tonumber(ARGV[3])
local maxc=tonumber(ARGV[4]); local maxr=tonumber(ARGV[5])
local win5=tonumber(ARGV[6]); local winw=tonumber(ARGV[7]); local cttl=tonumber(ARGV[8])
local topup=tonumber(ARGV[9])

local used5=tonumber(redis.call('GET',KEYS[1]) or '0')
local usedw=tonumber(redis.call('GET',KEYS[2]) or '0')
local conc=tonumber(redis.call('GET',KEYS[3]) or '0')
local req=tonumber(redis.call('GET',KEYS[4]) or '0')
local tb=redis.call('GET',KEYS[5])

local function ttls() return redis.call('TTL',KEYS[1]), redis.call('TTL',KEYS[2]) end
local function deny(reason) local a,b=ttls(); return {0,reason,'',used5,usedw,a,b} end

if maxc>0 and conc>=maxc then return deny('concurrency') end
if maxr>0 and req>=maxr then return deny('requests') end

local source=''
local planOK = (cap5<0 or used5+est<=cap5) and (capw<0 or usedw+est<=capw)
if planOK then
  local n5=redis.call('INCRBY',KEYS[1],est); if n5==est then redis.call('EXPIRE',KEYS[1],win5) end
  local nw=redis.call('INCRBY',KEYS[2],est); if nw==est then redis.call('EXPIRE',KEYS[2],winw) end
  used5=n5; usedw=nw
  source='plan'
elseif topup==1 and tb and tonumber(tb)>=est then
  redis.call('DECRBY',KEYS[5],est)
  source='topup'
else
  local reason='weekly_limit'
  if cap5>=0 and used5+est>cap5 then reason='5h_limit' end
  return deny(reason)
end

redis.call('INCR',KEYS[3]); redis.call('EXPIRE',KEYS[3],cttl)
local nr=redis.call('INCR',KEYS[4]); if nr==1 then redis.call('EXPIRE',KEYS[4],win5) end
local a,b=ttls()
return {1,'ok',source,used5,usedw,a,b}
`)

// settleScript reconciles a reservation to actuals (refunding the plan window or
// the top-up balance per source) and releases one concurrency slot.
// KEYS=[cw5h,cwwk,conc,topup]; ARGV=[source, est, actual].
var settleScript = redis.NewScript(`
local source=ARGV[1]; local est=tonumber(ARGV[2]); local actual=tonumber(ARGV[3])
if source=='plan' then
  redis.call('INCRBY',KEYS[1],actual-est)
  redis.call('INCRBY',KEYS[2],actual-est)
elseif source=='topup' then
  redis.call('INCRBY',KEYS[4],est-actual)
end
local c=redis.call('DECR',KEYS[3]); if c<0 then redis.call('SET',KEYS[3],0) end
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

// EnsureTopup seeds the Redis top-up mirror from the MySQL balance if absent,
// with a short TTL so purchases + ledger consumption periodically re-sync.
func (l *Limiter) EnsureTopup(ctx context.Context, userID, balanceFromDB int64) error {
	k := keysFor(userID)
	return l.rdb.SetNX(ctx, k[4], balanceFromDB, l.topupTTL).Err()
}

// Reserve attempts to reserve EstCredits, charging the plan window or top-up.
func (l *Limiter) Reserve(ctx context.Context, p ReserveParams) (ReserveResult, error) {
	topup := 0
	if p.TopUpEnabled {
		topup = 1
	}
	raw, err := reserveScript.Run(ctx, l.rdb, keysFor(p.UserID),
		p.EstCredits, p.Cap5h, p.CapWeek, p.MaxConcurrent, p.MaxReq5h,
		int(l.win5h.Seconds()), int(l.winWk.Seconds()), int(l.concTTL.Seconds()), topup,
	).Result()
	if err != nil {
		return ReserveResult{}, err
	}
	arr, ok := raw.([]any)
	if !ok || len(arr) < 7 {
		return ReserveResult{}, fmt.Errorf("unexpected reserve reply: %v", raw)
	}
	reason, _ := arr[1].(string)
	source, _ := arr[2].(string)
	return ReserveResult{
		OK:        toInt(arr[0]) == 1,
		Reason:    reason,
		Source:    source,
		Used5h:    toInt(arr[3]),
		UsedWeek:  toInt(arr[4]),
		Reset5h:   toInt(arr[5]),
		ResetWeek: toInt(arr[6]),
	}, nil
}

// Settle reconciles a reservation to the actual credits consumed (per source)
// and releases the concurrency slot. Use a background context.
func (l *Limiter) Settle(ctx context.Context, userID int64, source string, estCredits, actualCredits int64) error {
	k := keysFor(userID)
	return settleScript.Run(ctx, l.rdb, []string{k[0], k[1], k[2], k[4]}, source, estCredits, actualCredits).Err()
}

// Release refunds a reservation entirely (actual=0) and frees the slot.
func (l *Limiter) Release(ctx context.Context, userID int64, source string, estCredits int64) error {
	return l.Settle(ctx, userID, source, estCredits, 0)
}

// Status is the live window usage for a user (for GET /v1/credits + CLI display).
type Status struct {
	Used5h       int64
	UsedWeek     int64
	TopupBalance int64 // -1 when not present in Redis (caller falls back to DB)
	Reset5h      int64 // seconds until the 5h window resets; <0 if none
	ResetWeek    int64
}

// Status reads the current window counters and TTLs for a user.
func (l *Limiter) Status(ctx context.Context, userID int64) (Status, error) {
	k := keysFor(userID)
	pipe := l.rdb.Pipeline()
	g5 := pipe.Get(ctx, k[0])
	gw := pipe.Get(ctx, k[1])
	gt := pipe.Get(ctx, k[4])
	t5 := pipe.TTL(ctx, k[0])
	tw := pipe.TTL(ctx, k[1])
	_, _ = pipe.Exec(ctx) // per-command redis.Nil is expected for missing keys

	getInt := func(c *redis.StringCmd) int64 {
		v, err := c.Int64()
		if err != nil {
			return 0
		}
		return v
	}
	topup := int64(-1)
	if v, err := gt.Int64(); err == nil {
		topup = v
	}
	ttl := func(c *redis.DurationCmd) int64 {
		d, err := c.Result()
		if err != nil {
			return -1
		}
		return int64(d.Seconds())
	}
	return Status{
		Used5h:       getInt(g5),
		UsedWeek:     getInt(gw),
		TopupBalance: topup,
		Reset5h:      ttl(t5),
		ResetWeek:    ttl(tw),
	}, nil
}
