package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// teamAccessToken mints a token carrying the optional TEAM claims.
func teamAccessToken(t *testing.T, userID, orgID int64, orgRole string) string {
	t.Helper()
	c := jwt.MapClaims{
		"sub":     userID,
		"role":    "user",
		"type":    "access",
		"orgId":   orgID,
		"orgRole": orgRole,
		"exp":     time.Now().Add(time.Hour).Unix(),
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// fakeOrgSource is the team-billing half of the harness: one canned
// OrgMemberState, no MySQL. It is the same narrow interface the resolver takes in
// production (orgcredits.Source), so what these tests exercise is the real
// reserve path, not a reimplementation of it.
type fakeOrgSource struct {
	state *store.OrgMemberState
	err   error
}

func (f *fakeOrgSource) OrgMemberState(_ context.Context, _, _ int64) (*store.OrgMemberState, error) {
	return f.state, f.err
}

// teamHarness is chatHarness plus a resolvable team.
func teamHarness(
	t *testing.T,
	fe *fakeEnt,
	org *store.OrgMemberState,
) (http.Handler, *credits.Limiter) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	lim := credits.NewLimiter(rdb)
	cfg := &config.Config{JWTSecret: testSecret}
	return newHandler(cfg, fe, lim, nil, nil, &fakeOrgSource{state: org}), lim
}

// activeTeam is a billable team: active org, active seat, an active plan with a
// credit allowance, and a pool. `extra` is what the admin BOUGHT this period.
func activeTeam(planCredits, poolTotal, poolUsed, extra int64) *store.OrgMemberState {
	end := time.Now().Add(24 * time.Hour)
	return &store.OrgMemberState{
		OrgID:         21,
		OrgStatus:     "active",
		MemberStatus:  "active",
		MemberRole:    "member",
		SubStatus:     "active",
		HasPlan:       true,
		PeriodEnd:     &end,
		Plan:          store.Plan{Code: "team", Name: "Team", CreditsPerPeriod: i64(planCredits)},
		BucketQuota:   0, // no personal quota: draw straight on the pool
		BucketCredits: 0,
		PoolTotal:     poolTotal,
		PoolUsed:      poolUsed,
		PoolExtra:     extra,
	}
}

// teamModel is a hosted model the TEAM plan may call. Model access follows the
// ORG's plan (the gateway recomputes it from the live catalog for the team's plan
// code), so a team test has to grant it to "team" rather than to the member's own
// plan.
func teamModel(upstreamURL string) store.HostedModel {
	m := hostedModel("m1", deepseekProvider(upstreamURL), "real-model", 1)
	m.AllowedPlanCodes = []string{"team"}
	return m
}

// The point of team credits: when the plan's own allowance is spent, purchased
// credits keep the team working. Without them this request is a 429, which is
// exactly the wall this feature exists to remove.
func TestTeamPurchasedCreditsKeepServingAfterThePlanAllowanceIsSpent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`))
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{teamModel(upstream.URL)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	// Plan allowance 10, ALL of it already spent, 100 purchased credits left.
	h, _ := teamHarness(t, fe, activeTeam(10, 10, 10, 100))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"m1","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+teamAccessToken(t, 77, 21, "member"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200 (purchased credits must be spendable); body=%s",
			rec.Code, rec.Body.String())
	}
}

// …and the cap is still a cap. With the plan allowance AND the purchased credits
// gone, the team is refused — and the message has to name both ways out, since a
// member can do neither themselves.
func TestTeamIsRefusedOncePlanAndPurchasedCreditsAreBothSpent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an exhausted team must not reach the upstream")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{teamModel(upstream.URL)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	// 10 plan + 5 purchased, 15 already used: nothing left in either tier.
	h, _ := teamHarness(t, fe, activeTeam(10, 10, 15, 5))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"m1","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+teamAccessToken(t, 77, 21, "member"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d want 429; body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "buy more credits") {
		t.Errorf("the denial must tell the member their admin can buy credits: %s", body)
	}
	if !strings.Contains(body, "renew or upgrade") {
		t.Errorf("the denial must also keep the plan route: %s", body)
	}
}

// A team that bought nothing must behave exactly as it did before this feature:
// the plan's allowance is the cap, and the denial is the same one.
func TestTeamWithoutPurchasedCreditsIsUnchanged(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an exhausted team must not reach the upstream")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{teamModel(upstream.URL)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := teamHarness(t, fe, activeTeam(10, 10, 10, 0))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"m1","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+teamAccessToken(t, 77, 21, "member"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d want 429; body=%s", rec.Code, rec.Body.String())
	}
}

// A member of a team that bought credits must SEE them on /v1/credits. The CLI
// shows this on every turn, so a purchased balance that did not appear here would
// look to the whole team like the admin's money vanished.
func TestTeamCreditsReportsThePurchasedAllowanceSeparately(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	// Plan allowance 100 (all spent), 400 purchased, 100 used so far → the whole
	// plan tier is gone and none of the purchased tier is.
	h, _ := teamHarness(t, fe, activeTeam(100, 100, 100, 400))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/credits", nil)
	req.Header.Set("Authorization", "Bearer "+teamAccessToken(t, 77, 21, "member"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Scope            string   `json:"scope"`
		RemainingCredits *float64 `json:"remainingCredits"`
		Team             struct {
			PlanCredits        int64  `json:"planCredits"`
			PurchasedCredits   int64  `json:"purchasedCredits"`
			PurchasedRemaining int64  `json:"purchasedRemaining"`
			CreditsExpireAt    string `json:"creditsExpireAt"`
		} `json:"team"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Scope != "team" {
		t.Fatalf("scope = %q, want team", body.Scope)
	}
	// The headline number must include the purchased credits, or a member sees 0
	// left while the team has 400.
	if body.RemainingCredits == nil || *body.RemainingCredits != 400 {
		t.Errorf("remainingCredits = %v, want 400", body.RemainingCredits)
	}
	if body.Team.PlanCredits != 100 || body.Team.PurchasedCredits != 400 {
		t.Errorf("split = plan %d / purchased %d, want 100/400",
			body.Team.PlanCredits, body.Team.PurchasedCredits)
	}
	if body.Team.PurchasedRemaining != 400 {
		t.Errorf("purchasedRemaining = %d, want 400 (the plan tier absorbed all the usage)",
			body.Team.PurchasedRemaining)
	}
	// Purchased credits expire with the period, so the client can warn about it.
	if body.Team.CreditsExpireAt == "" {
		t.Error("creditsExpireAt must be reported so a client can say when they lapse")
	}
}

// A team claim must never be able to BREAK a request. When team billing cannot be
// resolved — no database handle in this build, a removed seat, a suspended team,
// a lapsed team plan — the member is exactly what they now are: an individual
// user on their own subscription. This test pins that fallback using the harness
// with no store (s.orgs == nil), which is the same code path a stale claim takes.
func TestOrgClaimFallsBackToIndividualBilling(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`))
	}))
	defer upstream.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{
				hostedModel("m1", deepseekProvider(upstream.URL), "real-model", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"m1","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+teamAccessToken(t, 77, 21, "member"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200; body=%s", rec.Code, rec.Body.String())
	}
}

// GET /v1/credits with a team claim but no resolvable team must still answer the
// individual view rather than erroring — the CLI shows credits on every turn, so
// this endpoint failing would look like a broken account.
func TestCreditsWithOrgClaimFallsBackToIndividualView(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 77, Status: "active",
			Plan:         store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			TopupBalance: 12,
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/credits", nil)
	req.Header.Set("Authorization", "Bearer "+teamAccessToken(t, 77, 21, "member"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["plan"] != "pro" {
		t.Errorf("plan = %v, want pro (individual fallback)", body["plan"])
	}
	if _, hasScope := body["scope"]; hasScope {
		t.Errorf("individual response must not claim team scope: %v", body["scope"])
	}
}
