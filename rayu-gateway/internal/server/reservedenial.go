package server

import (
	"net/http"
	"strconv"

	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

// RayuLimitHeader names the machine-readable reserve-denial reason so a client
// can classify the 429 without parsing prose. Mirrors the existing
// X-Rayu-Limit: daily_turn_limit contract.
const RayuLimitHeader = "X-Rayu-Limit"

// TransientRetryAfterSeconds is the Retry-After we advertise for a denial that
// clears on its own within seconds — a concurrency slot frees as soon as one of
// the user's in-flight requests finishes.
const TransientRetryAfterSeconds = 2

// ShortWindowRetryAfterSeconds is the Retry-After for the requests-per-5h abuse
// cap. The exact window TTL is not returned by the limiter, so advertise a
// conservative minute: long enough not to hammer, short enough that a client
// that is merely bursting recovers on its own.
const ShortWindowRetryAfterSeconds = 60

// writeReserveDenial renders a limiter denial as a 429 whose message, Retry-After
// and reason header MATCH THE ACTUAL REASON.
//
// WHY: every denial used to be written as "credit limit reached: <reason>" with
// Retry-After set to seconds-until-billing-period-reset. The limiter's reasons
// are "concurrency" | "requests" | "period_limit" (plus "bucket_limit" /
// "pool_limit" for teams), so a user who simply had more requests in flight than
// maxConcurrentStreams (default 3 — one CLI turn fans out to subagents, side
// queries and quota checks) received a BILLING error telling them their credits
// were exhausted and would renew "in about 26 days", while their balance was
// half unused. That is the single most misleading response this service can
// produce: it sends a paying customer to the pricing page to fix a problem that
// resolves itself in one second.
//
// scope is optional (pass "team" for the org path) and is echoed so a client can
// tell a personal limit from a team one.
func writeReserveDenial(w http.ResponseWriter, reason string, resetSeconds int64, overrideMsg string, scope ...string) {
	msg := overrideMsg
	retryAfter := resetSeconds
	transient := false

	switch reason {
	case "concurrency":
		transient = true
		retryAfter = TransientRetryAfterSeconds
		if msg == "" {
			msg = "too many concurrent requests for this account — retry shortly. This is a concurrency limit, not your credit balance."
		}
	case "requests":
		transient = true
		retryAfter = ShortWindowRetryAfterSeconds
		if msg == "" {
			msg = "too many requests in a short window — retry shortly. This is a rate limit, not your credit balance."
		}
	default:
		// period_limit / bucket_limit / pool_limit and any future reason: a real
		// balance state, so the period reset is the correct Retry-After.
		if msg == "" {
			msg = "credit limit reached: " + reason
		}
	}

	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.FormatInt(retryAfter, 10))
	}
	if reason != "" {
		w.Header().Set(RayuLimitHeader, reason)
	}

	body := map[string]any{
		"error":     map[string]any{"message": msg, "type": "rate_limit_exceeded"},
		"reason":    reason,
		"transient": transient,
	}
	// resetSeconds keeps its original meaning (period reset) so existing clients
	// that render a renewal ETA are unaffected; it is omitted for a transient
	// denial, where a billing reset is not what the client should show.
	if !transient {
		body["resetSeconds"] = resetSeconds
	}
	if len(scope) > 0 && scope[0] != "" {
		body["scope"] = scope[0]
	}
	httpx.WriteJSON(w, http.StatusTooManyRequests, body)
}
