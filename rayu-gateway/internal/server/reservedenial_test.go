package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A concurrency denial is NOT a billing state. Before this, every limiter denial
// was written as "credit limit reached: <reason>" with Retry-After set to
// seconds-until-billing-period-reset, so a user with half their credits unused
// was told their credits were exhausted and would renew "in about 26 days".
func TestWriteReserveDenial_ConcurrencyIsTransient(t *testing.T) {
	rec := httptest.NewRecorder()
	// 26 days, the kind of period reset that used to land in Retry-After.
	writeReserveDenial(rec, "concurrency", 2_246_400, "")

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Get(RayuLimitHeader); got != "concurrency" {
		t.Fatalf("%s = %q, want concurrency", RayuLimitHeader, got)
	}
	if got := rec.Header().Get("Retry-After"); got != fmt.Sprint(TransientRetryAfterSeconds) {
		t.Fatalf("Retry-After = %q, want %d", got, TransientRetryAfterSeconds)
	}

	var body struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
		Reason       string `json:"reason"`
		Transient    bool   `json:"transient"`
		ResetSeconds *int64 `json:"resetSeconds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if !body.Transient {
		t.Fatal("transient = false, want true")
	}
	if body.Reason != "concurrency" {
		t.Fatalf("reason = %q, want concurrency", body.Reason)
	}
	if body.ResetSeconds != nil {
		t.Fatalf("resetSeconds present (%d) for a transient denial", *body.ResetSeconds)
	}
	// The exact string the CLI keys off must not appear.
	if contains(body.Error.Message, "credit limit reached") {
		t.Fatalf("message still claims a credit limit: %q", body.Error.Message)
	}
	if !contains(body.Error.Message, "concurren") {
		t.Fatalf("message does not name the real cause: %q", body.Error.Message)
	}
}

func TestWriteReserveDenial_RequestsCapIsTransient(t *testing.T) {
	rec := httptest.NewRecorder()
	writeReserveDenial(rec, "requests", 2_246_400, "")

	if got := rec.Header().Get("Retry-After"); got != fmt.Sprint(ShortWindowRetryAfterSeconds) {
		t.Fatalf("Retry-After = %q, want %d", got, ShortWindowRetryAfterSeconds)
	}
	if contains(rec.Body.String(), "credit limit reached") {
		t.Fatalf("message still claims a credit limit: %s", rec.Body.String())
	}
}

// A real balance exhaustion keeps the billing message, the period reset, and the
// resetSeconds field the CLI renders as a renewal ETA.
func TestWriteReserveDenial_PeriodLimitKeepsBillingSemantics(t *testing.T) {
	rec := httptest.NewRecorder()
	writeReserveDenial(rec, "period_limit", 3600, "")

	if got := rec.Header().Get("Retry-After"); got != "3600" {
		t.Fatalf("Retry-After = %q, want 3600", got)
	}
	if got := rec.Header().Get(RayuLimitHeader); got != "period_limit" {
		t.Fatalf("%s = %q, want period_limit", RayuLimitHeader, got)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if body["transient"] != false {
		t.Fatalf("transient = %v, want false", body["transient"])
	}
	if _, ok := body["resetSeconds"]; !ok {
		t.Fatal("resetSeconds missing for a period limit")
	}
	if !contains(rec.Body.String(), "credit limit reached") {
		t.Fatalf("period limit lost its billing message: %s", rec.Body.String())
	}
}

// The team path keeps its bespoke pool message and gains the scope marker.
func TestWriteReserveDenial_TeamPoolOverride(t *testing.T) {
	rec := httptest.NewRecorder()
	writeReserveDenial(rec, "pool_limit", 600, "your team's credit pool is exhausted", "team")

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if body["scope"] != "team" {
		t.Fatalf("scope = %v, want team", body["scope"])
	}
	if !contains(rec.Body.String(), "team's credit pool is exhausted") {
		t.Fatalf("override message lost: %s", rec.Body.String())
	}
}

func TestIsClientGone(t *testing.T) {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()

	cases := []struct {
		name string
		ctx  context.Context
		err  error
		want bool
	}{
		{
			// The production log: client hung up, transport reports it.
			name: "client canceled + transport context canceled",
			ctx:  canceled,
			err:  fmt.Errorf(`Post "https://ollama.com/v1/messages": %w`, context.Canceled),
			want: true,
		},
		{
			// A genuine upstream stall must stay an upstream error.
			name: "live ctx + upstream header timeout",
			ctx:  context.Background(),
			err:  errors.New("http2: timeout awaiting response headers"),
			want: false,
		},
		{
			name: "live ctx + cancellation from an inner timeout",
			ctx:  context.Background(),
			err:  context.Canceled,
			want: false,
		},
		{
			name: "client canceled but unrelated error",
			ctx:  canceled,
			err:  errors.New("connection reset by peer"),
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isClientGone(tc.ctx, tc.err); got != tc.want {
				t.Fatalf("isClientGone = %v, want %v", got, tc.want)
			}
		})
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
