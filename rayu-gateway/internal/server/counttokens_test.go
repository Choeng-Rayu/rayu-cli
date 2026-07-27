package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// /context in the CLI calls messages.countTokens() once per context section. That
// endpoint used to 404 here, and the SDK's fallback is to send a REAL
// max_tokens=1 completion — roughly twenty billed requests per /context, which
// also tripped the concurrency limiter and made the command fail. These tests pin
// the two things that matter: it answers in the shape the SDK parses, and it
// costs the user nothing.

func countTokensHarness(t *testing.T, userID int64) (http.Handler, *credits.Limiter) {
	t.Helper()
	// No upstream is registered: a count must never call one.
	prov := longcatProvider("http://127.0.0.1:1") // unreachable on purpose
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: userID, Status: "active",
			Plan: store.Plan{
				Code: "pro", Name: "Pro",
				CreditsPerPeriod: i64(50), MaxDailyTurns: i64(5),
			},
			AllowedModels: []store.HostedModel{
				hostedModel("longcat-2", prov, "LongCat-2.0", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, lim := chatHarness(t, fe)
	return h, lim
}

func postCount(t *testing.T, h http.Handler, userID int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages/count_tokens",
		strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, userID))
	h.ServeHTTP(rec, req)
	return rec
}

func TestCountTokensAnswersInTheSDKShape(t *testing.T) {
	h, _ := countTokensHarness(t, 71)

	rec := postCount(t, h, 71, `{"model":"longcat-2","messages":[
		{"role":"user","content":"summarise the parser module in detail please"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		InputTokens *int `json:"input_tokens"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
	}
	// The SDK requires input_tokens to be a number; a missing/null field makes it
	// treat the whole count as unavailable and fall back to billed probing.
	if out.InputTokens == nil {
		t.Fatalf("response has no numeric input_tokens: %s", rec.Body.String())
	}
	if *out.InputTokens <= 0 {
		t.Fatalf("input_tokens=%d, want >0 for a non-empty conversation", *out.InputTokens)
	}
	if got := rec.Header().Get("x-rayu-token-count"); got != "estimate" {
		t.Errorf("x-rayu-token-count=%q, want \"estimate\" so operators know the source", got)
	}
}

// The whole point: counting must not consume credits or a daily turn, and must
// not call an upstream (the provider here is unreachable — a proxied count would
// fail or hang).
func TestCountTokensCostsNothing(t *testing.T) {
	h, lim := countTokensHarness(t, 72)

	for i := 0; i < 25; i++ {
		rec := postCount(t, h, 72, `{"model":"longcat-2","messages":[
			{"role":"user","content":"a fairly long message that would cost credits if this were a completion"}]}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("call %d: status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}

	st, err := lim.Status(t.Context(), 72)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d after 25 counts, want 0 (counting is metadata)", st.UsedPeriod)
	}
	used, _, _ := lim.TurnsToday(t.Context(), 72)
	if used != 0 {
		t.Fatalf("turnsUsedToday=%d after 25 counts, want 0", used)
	}
}

// Access still applies: a model the plan cannot use must not be countable, and an
// unparseable body is a 400 rather than a confidently wrong number.
func TestCountTokensValidatesModelAndBody(t *testing.T) {
	h, _ := countTokensHarness(t, 73)

	if rec := postCount(t, h, 73, `{"model":"not-my-model","messages":[]}`); rec.Code != http.StatusForbidden {
		t.Errorf("foreign model got %d, want 403", rec.Code)
	}
	if rec := postCount(t, h, 73, `not json at all`); rec.Code != http.StatusBadRequest {
		t.Errorf("invalid JSON got %d, want 400", rec.Code)
	}
	// An empty conversation is legal and costs nothing to answer.
	rec := postCount(t, h, 73, `{"model":"longcat-2","messages":[]}`)
	if rec.Code != http.StatusOK {
		t.Errorf("empty conversation got %d, want 200", rec.Code)
	}
}

// Tools ride along on every agent request, so the count has to grow with them —
// otherwise /context under-reports the largest fixed cost in the window.
func TestCountTokensGrowsWithToolsAndHistory(t *testing.T) {
	h, _ := countTokensHarness(t, 74)

	read := func(body string) int {
		rec := postCount(t, h, 74, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var out struct {
			InputTokens int `json:"input_tokens"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.InputTokens
	}

	small := read(`{"model":"longcat-2","messages":[{"role":"user","content":"hi"}]}`)
	withTools := read(`{"model":"longcat-2","messages":[{"role":"user","content":"hi"}],
		"tools":[{"name":"read_file","description":"Read a file from disk","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}]}`)
	longer := read(`{"model":"longcat-2","messages":[
		{"role":"user","content":"` + strings.Repeat("explain this code carefully ", 50) + `"}]}`)

	if withTools <= small {
		t.Errorf("tools did not increase the count (%d → %d)", small, withTools)
	}
	if longer <= withTools {
		t.Errorf("a longer conversation did not increase the count (%d → %d)", withTools, longer)
	}
}
