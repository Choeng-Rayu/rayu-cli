package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// The provider test exists so an admin never has to learn from a USER that a
// provider is misconfigured. These tests pin the two things that make it
// trustworthy: it runs the real request path (same adapter, same key), and it
// classifies the failure into the field that needs fixing — while charging
// nothing and never revealing a key.

// testHarness builds a router whose provider serves whatever the upstream handler
// does, with one admin-testable model and the given keys.
func providerTestHarness(
	t *testing.T,
	upstream http.HandlerFunc,
	keys []providerkeys.Key,
) (http.Handler, *fakeEnt, func()) {
	t.Helper()
	srv := httptest.NewServer(upstream)
	prov := longcatProvider(srv.URL)
	model := hostedModel("longcat-2", prov, "LongCat-2.0", 1)
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 900, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50)},
			AllowedModels: []store.HostedModel{model},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: keys},
	}
	h, _ := chatHarness(t, fe)
	return h, fe, srv.Close
}

func runProviderTest(t *testing.T, h http.Handler, role string, body string) (int, providerTestResult) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_provider-test", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 900, role))
	h.ServeHTTP(rec, req)
	var out providerTestResult
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
		}
	}
	return rec.Code, out
}

func liveKey() []providerkeys.Key {
	return []providerkeys.Key{
		{ID: 31, Secret: "sk-live-secret", Masked: "sk-li…(14)", Enabled: true, Status: providerkeys.StatusActive},
	}
}

func TestProviderTestSucceedsThroughTheRealAdapter(t *testing.T) {
	var gotAuth, gotBody string
	h, _, done := providerTestHarness(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant",`+
			`"content":[{"type":"text","text":"pong"}],"usage":{"input_tokens":3,"output_tokens":1}}`)
	}, liveKey())
	defer done()

	code, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"longcat-2"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if !res.OK || res.Classification != testOK {
		t.Fatalf("classification=%q ok=%v, want ok", res.Classification, res.OK)
	}
	// The real key must have been presented to the real endpoint.
	if gotAuth != "Bearer sk-live-secret" {
		t.Errorf("upstream saw Authorization=%q — the test must use the stored key", gotAuth)
	}
	// The upstream model id, not the Rayu code (model fidelity), and a 1-token ask.
	if !strings.Contains(gotBody, `"LongCat-2.0"`) {
		t.Errorf("upstream body did not carry the upstream model id: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"max_tokens":1`) {
		t.Errorf("test request was not minimal: %s", gotBody)
	}
	if res.UpstreamModelID != "LongCat-2.0" || res.ModelCode != "longcat-2" {
		t.Errorf("result identifies model %q/%q", res.ModelCode, res.UpstreamModelID)
	}
	if res.KeyID != 31 || res.MaskedKey != "sk-li…(14)" {
		t.Errorf("result must identify the key by id + mask, got id=%d mask=%q", res.KeyID, res.MaskedKey)
	}
	if res.LatencyMs < 0 {
		t.Errorf("latencyMs=%d", res.LatencyMs)
	}
}

// A test must never charge the admin: no credit reserve, no daily turn.
func TestProviderTestChargesNothing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}],`+
			`"usage":{"input_tokens":9000,"output_tokens":9000}}`)
	}))
	defer srv.Close()
	prov := longcatProvider(srv.URL)
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 901, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(50), MaxDailyTurns: i64(5)},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", prov, "LongCat-2.0", 1)},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: liveKey()},
	}
	h, lim := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_provider-test",
		strings.NewReader(`{"providerId":2}`))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 901, "admin"))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d: %s", rec.Code, rec.Body.String())
	}

	st, err := lim.Status(t.Context(), 901)
	if err != nil {
		t.Fatal(err)
	}
	if st.UsedPeriod != 0 {
		t.Fatalf("usedPeriod=%d, want 0 (a provider test must be unbilled)", st.UsedPeriod)
	}
	used, _, _ := lim.TurnsToday(t.Context(), 901)
	if used != 0 {
		t.Fatalf("turnsUsedToday=%d, want 0", used)
	}
}

func TestProviderTestClassifiesFailures(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		want    string
		// mustSay is a fragment the message has to contain, so the classification
		// is not just a label with an unhelpful body.
		mustSay string
	}{
		{
			name: "rejected key",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":{"message":"invalid api key"}}`)
			},
			want: testBadAPIKey, mustSay: "rejected",
		},
		{
			name: "unknown model",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"message":"model not found: LongCat-2.0"}}`)
			},
			want: testUnknownModel, mustSay: "model",
		},
		{
			name: "wrong endpoint",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `<html><body>404 Not Found</body></html>`)
			},
			want: testBadBaseURL, mustSay: "404",
		},
		{
			name: "throttled",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error"}}`)
			},
			want: testRateLimited, mustSay: "throttled",
		},
		{
			name: "200 in the wrong shape",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `"just a string"`)
			},
			want: testFormatMismatch, mustSay: "shape",
		},
		{
			name: "provider is down",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = io.WriteString(w, `upstream unavailable`)
			},
			want: testUpstreamError, mustSay: "502",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, fe, done := providerTestHarness(t, tc.handler, liveKey())
			defer done()
			code, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"longcat-2"}`)
			// A FAILED test is still a successful API call: the dashboard needs the
			// classification, not an HTTP error it has to interpret.
			if code != http.StatusOK {
				t.Fatalf("status=%d, want 200 with a classification", code)
			}
			if res.Classification != tc.want {
				t.Fatalf("classification=%q (%s), want %q", res.Classification, res.Message, tc.want)
			}
			if res.OK {
				t.Error("ok=true on a failure")
			}
			if !strings.Contains(strings.ToLower(res.Message), tc.mustSay) {
				t.Errorf("message %q does not mention %q", res.Message, tc.mustSay)
			}
			if strings.Contains(res.Message, "sk-live-secret") || strings.Contains(res.Suggestion, "sk-live-secret") {
				t.Errorf("the API key leaked into the result: %+v", res)
			}
			// Per-key health is real: a 401 must take the key out of rotation and a
			// 429 must cool it down, so the next USER request skips it.
			snap := fe.Keys().SnapshotFor(provIDLongCat)
			switch tc.want {
			case testBadAPIKey:
				if snap[0].Status != providerkeys.StatusInvalid {
					t.Errorf("key status=%s after a 401, want invalid", snap[0].Status)
				}
			case testRateLimited:
				if snap[0].Status != providerkeys.StatusRateLimited {
					t.Errorf("key status=%s after a 429, want rate_limited", snap[0].Status)
				}
			}
		})
	}
}

// An unreachable host is an admin typo in baseUrl, not a provider outage.
func TestProviderTestReportsAnUnreachableBaseURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	closedURL := srv.URL
	srv.Close() // nothing is listening now → connection refused

	prov := longcatProvider(closedURL)
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 902, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", prov, "LongCat-2.0", 1)},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: liveKey()},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_provider-test", strings.NewReader(`{"providerId":2}`))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 902, "admin"))
	h.ServeHTTP(rec, req)
	var res providerTestResult
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Classification != testBadBaseURL {
		t.Fatalf("classification=%q (%s), want %s", res.Classification, res.Message, testBadBaseURL)
	}
}

// A rejected model id is usually a typo of one that already works, so the result
// points at the nearest configured id instead of "check the docs".
func TestProviderTestSuggestsTheNearestModelID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"invalid model"}}`)
	}))
	defer srv.Close()
	prov := longcatProvider(srv.URL)
	good := hostedModel("longcat-2", prov, "LongCat-2.0", 1)
	typo := hostedModel("longcat-typo", prov, "LongCat-2.O", 1) // letter O, not zero
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 903, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{good, typo},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: liveKey()},
	}
	h, _ := chatHarness(t, fe)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_provider-test",
		strings.NewReader(`{"providerId":2,"modelCode":"longcat-typo"}`))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 903, "admin"))
	h.ServeHTTP(rec, req)
	var res providerTestResult
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Classification != testUnknownModel {
		t.Fatalf("classification=%q (%s)", res.Classification, res.Message)
	}
	if !strings.Contains(res.Suggestion, "LongCat-2.0") {
		t.Fatalf("suggestion=%q, want it to name the nearest configured model id", res.Suggestion)
	}
}

// A key that Pick would skip must still be testable by id — that is how an admin
// verifies a replacement or a recovered key.
func TestProviderTestCanTargetAnUnusableKey(t *testing.T) {
	var seen []string
	h, fe, done := providerTestHarness(t, func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
	}, []providerkeys.Key{
		{ID: 41, Secret: "sk-healthy", Masked: "sk-he…", Priority: 0, Enabled: true, Status: providerkeys.StatusActive},
		{ID: 42, Secret: "sk-was-bad", Masked: "sk-wa…", Priority: 1, Enabled: true, Status: providerkeys.StatusInvalid},
	})
	defer done()

	code, res := runProviderTest(t, h, "superadmin", `{"providerId":2,"apiKeyId":42}`)
	if code != http.StatusOK || !res.OK {
		t.Fatalf("status=%d classification=%q (%s)", code, res.Classification, res.Message)
	}
	if len(seen) != 1 || seen[0] != "sk-was-bad" {
		t.Fatalf("upstream saw keys %v, want only the targeted key", seen)
	}
	// Passing puts it back in rotation: otherwise an admin fixes a key and the
	// gateway keeps ignoring it until the next config refresh.
	if got := fe.Keys().Usable(provIDLongCat); got != 2 {
		t.Errorf("usable keys=%d, want 2 (the tested key recovered)", got)
	}
}

// A failure tells an admin what broke; the checklist tells them what WORKED,
// which is what narrows a misconfiguration to one field. The Bedrock case that
// prompted this: every model id was rejected, so it looked like a bad key or a
// bad model name, when in fact the endpoint answered and accepted the key and
// only the model id was refused.
func TestProviderTestReportsWhichStageSucceeded(t *testing.T) {
	cases := []struct {
		name                              string
		handler                           http.HandlerFunc
		reachable, keyAccepted, modelSeen *bool
	}{
		{
			name: "success: everything passed",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
			},
			reachable: boolPtr(true), keyAccepted: boolPtr(true), modelSeen: boolPtr(true),
		},
		{
			name: "unknown model: endpoint and key are fine",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"message":"The model 'x' does not exist"}}`)
			},
			reachable: boolPtr(true), keyAccepted: boolPtr(true), modelSeen: boolPtr(false),
		},
		{
			name: "rejected key: the endpoint still exists",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			// The model was never judged, so it stays unknown (null).
			reachable: boolPtr(true), keyAccepted: boolPtr(false), modelSeen: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _, done := providerTestHarness(t, tc.handler, liveKey())
			defer done()
			_, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"longcat-2"}`)
			assertCheck(t, "reachable", res.Checks.Reachable, tc.reachable)
			assertCheck(t, "keyAccepted", res.Checks.KeyAccepted, tc.keyAccepted)
			assertCheck(t, "modelAccepted", res.Checks.ModelAccepted, tc.modelSeen)
		})
	}
}

// An unreachable host must not claim anything about the key or the model — that
// would send an admin editing fields that were never exercised.
func TestProviderTestChecksAreUnknownWhenUnreachable(t *testing.T) {
	checks := checksFor(testBadBaseURL, 0, io.ErrUnexpectedEOF)
	if checks.Reachable == nil || *checks.Reachable {
		t.Errorf("reachable=%v, want false", checks.Reachable)
	}
	if checks.KeyAccepted != nil || checks.ModelAccepted != nil {
		t.Errorf("key/model must be unknown when nothing answered: %+v", checks)
	}
}

// The hint that would have saved the Bedrock debugging session: when a model id
// is refused, say that a wrong endpoint looks exactly the same.
func TestUnknownModelSuggestionQuestionsTheEndpoint(t *testing.T) {
	h, _, done := providerTestHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"message":"The model 'x' does not exist"}}`)
	}, liveKey())
	defer done()

	_, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"longcat-2"}`)
	if res.Classification != testUnknownModel {
		t.Fatalf("classification=%q", res.Classification)
	}
	if !strings.Contains(res.Suggestion, "base URL") {
		t.Fatalf("suggestion never questions the endpoint: %q", res.Suggestion)
	}
}

func assertCheck(t *testing.T, name string, got, want *bool) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Errorf("%s=%v, want null (not determinable)", name, *got)
	case want != nil && got == nil:
		t.Errorf("%s=null, want %v", name, *want)
	case want != nil && got != nil && *want != *got:
		t.Errorf("%s=%v, want %v", name, *got, *want)
	}
}

// REGRESSION: "Add key & test" (and "Add model & test") failed with 400 for up to
// CONFIG_REFRESH_SECONDS, because the key had just been written to the database
// and the gateway's 30s config snapshot had not picked it up yet — so the test
// said "unknown API key for this provider" about a key the admin was looking at.
// A first miss now triggers ONE immediate reload and a retry.
func TestProviderTestSeesAKeySavedASecondAgo(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
	}))
	defer upstream.Close()

	prov := longcatProvider(upstream.URL)
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 910, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", prov, "LongCat-2.0", 1)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
		// The snapshot the gateway is holding: ONE key. Key 99 exists in the
		// "database" but is not in the snapshot yet.
		providerKeys: map[int64][]providerkeys.Key{
			provIDLongCat: {
				{ID: 50, Secret: "sk-old", Masked: "sk-ol…", Enabled: true, Status: providerkeys.StatusActive},
			},
		},
		// onReload stands in for the config refresh reading the new row.
		onReload: func(f *fakeEnt) {
			f.Keys().Replace(provIDLongCat, []providerkeys.Key{
				{ID: 50, Secret: "sk-old", Masked: "sk-ol…", Enabled: true, Status: providerkeys.StatusActive},
				{ID: 99, Secret: "sk-brand-new", Masked: "sk-br…", Priority: 1, Enabled: true, Status: providerkeys.StatusActive},
			})
		},
	}
	h, _ := chatHarness(t, fe)

	code, res := runProviderTest(t, h, "admin", `{"providerId":2,"apiKeyId":99}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200 — a key saved a moment ago must be testable immediately", code)
	}
	if !res.OK || res.KeyID != 99 {
		t.Fatalf("result=%+v, want the just-added key 99 to have been tested", res)
	}
	if fe.reloads != 1 {
		t.Errorf("reloads=%d, want exactly 1 (refresh on miss, not on every test)", fe.reloads)
	}
}

// Every test refreshes the snapshot FIRST, including the happy path.
//
// This deliberately replaces the earlier "only refresh when a lookup misses"
// contract. Refreshing only on a miss is undetectable for an EDIT: an admin who
// changes a model's upstream id (or a provider's base URL / auth scheme) still
// has a row under the same code, so nothing misses, nothing refreshes, and the
// test silently exercises the configuration that was just replaced. A test that
// reports on stale config is worse than no test, and the saving — a few queries
// on a human-triggered action capped at 20/min — is not worth that.
func TestProviderTestAlwaysRefreshesBeforeTesting(t *testing.T) {
	h, fe, done := providerTestHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
	}, liveKey())
	defer done()

	if code, _ := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"longcat-2"}`); code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if fe.reloads != 1 {
		t.Errorf("reloads=%d, want exactly 1 — refresh up front, once per test", fe.reloads)
	}
}

// REGRESSION (the reported bug): "I save the model configuration, then I test it,
// and it still uses the old configuration until I wait ~5 minutes."
//
// Editing a model keeps its Rayu code, so the stale snapshot still RESOLVES it —
// there is no lookup miss to trigger a refresh. The test therefore has to refresh
// unconditionally, before resolving anything, or it sends the previous upstream
// model id to the provider and reports success for configuration the admin has
// already replaced.
func TestProviderTestSeesAModelEditedASecondAgo(t *testing.T) {
	var sentBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		sentBody = string(b)
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
	}))
	defer upstream.Close()

	prov := longcatProvider(upstream.URL)
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 911, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro"},
			// The snapshot the gateway is holding: the PRE-EDIT upstream model id.
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", prov, "LongCat-OLD", 1)},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: liveKey()},
		// The database already has the admin's edit; this is the refresh reading it.
		onReload: func(f *fakeEnt) {
			f.ent.AllowedModels[0].UpstreamModelID = "LongCat-2.0-NEW"
		},
	}
	h, _ := chatHarness(t, fe)

	code, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"longcat-2"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if !strings.Contains(sentBody, `"LongCat-2.0-NEW"`) {
		t.Fatalf("upstream was sent the STALE model id — body=%s", sentBody)
	}
	if res.UpstreamModelID != "LongCat-2.0-NEW" {
		t.Errorf("result reports upstreamModelId=%q, want the just-saved id", res.UpstreamModelID)
	}
}

// The same staleness applies to the provider ROW: an edited base URL, endpoint
// path or auth scheme is resolved from the snapshot before any lookup can miss,
// so without an up-front refresh the test authenticates the old way against the
// old host — and reports the old endpoint back to the admin.
func TestProviderTestSeesAProviderConnectionEditedASecondAgo(t *testing.T) {
	staleHits := 0
	stale := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		staleHits++
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
	}))
	defer stale.Close()

	var freshAuth, freshAPIKey string
	fresh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		freshAuth = r.Header.Get("Authorization")
		freshAPIKey = r.Header.Get("x-api-key")
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
	}))
	defer fresh.Close()

	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 912, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", longcatProvider(stale.URL), "LongCat-2.0", 1)},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: liveKey()},
		// The admin repointed the provider at a new host and switched it from
		// bearer auth to x-api-key.
		onReload: func(f *fakeEnt) {
			f.ent.AllowedModels[0].Provider.BaseURL = fresh.URL
			f.ent.AllowedModels[0].Provider.AuthScheme = providercfg.AuthXAPIKey
		},
	}
	h, _ := chatHarness(t, fe)

	code, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"longcat-2"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if staleHits != 0 {
		t.Errorf("the OLD base URL was called %d time(s) — the test used stale config", staleHits)
	}
	if freshAPIKey != "sk-live-secret" {
		t.Errorf("new host saw x-api-key=%q, want the stored key under the just-saved auth scheme", freshAPIKey)
	}
	if freshAuth != "" {
		t.Errorf("new host also saw Authorization=%q — the old auth scheme was used", freshAuth)
	}
	if !strings.HasPrefix(res.Endpoint, fresh.URL) {
		t.Errorf("result reports endpoint=%q, want the just-saved base URL %q", res.Endpoint, fresh.URL)
	}
}

// When the refresh itself fails (database unreachable) the test still runs against
// the last known snapshot — but if a lookup then misses, the admin must be told
// WHY, otherwise "model does not belong to this provider" points them at a model
// that is in fact saved correctly.
func TestProviderTestExplainsAFailedRefresh(t *testing.T) {
	h, fe, done := providerTestHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"pong"}]}`)
	}, liveKey())
	defer done()
	fe.reloadErr = errors.New("dial tcp 10.0.0.9:3306: connect: connection refused")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_provider-test",
		strings.NewReader(`{"providerId":2,"modelCode":"not-in-the-snapshot"}`))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 900, "admin"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "not-in-the-snapshot") {
		t.Errorf("error lost the original cause: %s", body)
	}
	if !strings.Contains(body, "could not refresh") || !strings.Contains(body, "connection refused") {
		t.Errorf("error does not say the refresh failed: %s", body)
	}
}

func TestProviderTestIsAdminOnlyAndValidated(t *testing.T) {
	h, _, done := providerTestHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called for a rejected request")
	}, liveKey())
	defer done()

	if code, _ := runProviderTest(t, h, "user", `{"providerId":2}`); code != http.StatusForbidden {
		t.Errorf("regular user got %d, want 403", code)
	}
	if code, _ := runProviderTest(t, h, "admin", `{}`); code != http.StatusBadRequest {
		t.Errorf("missing providerId got %d, want 400", code)
	}
	if code, _ := runProviderTest(t, h, "admin", `{"providerId":999}`); code != http.StatusNotFound {
		t.Errorf("unknown provider got %d, want 404", code)
	}
	if code, _ := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"not-mine"}`); code != http.StatusBadRequest {
		t.Errorf("model of another provider got %d, want 400", code)
	}
}

// The rate limit protects UPSTREAMS from a held-down button, so it must trigger
// before the provider's own abuse detection does.
func TestProviderTestRateLimitsPerAdmin(t *testing.T) {
	lim := newTestLimiter()
	now := time.Now()
	for i := 0; i < providerTestPerAdmin; i++ {
		if ok, _ := lim.allow(7, now); !ok {
			t.Fatalf("attempt %d blocked while inside the budget", i+1)
		}
	}
	ok, wait := lim.allow(7, now)
	if ok {
		t.Fatal("the budget did not cap the admin")
	}
	if wait <= 0 || wait > providerTestWindow {
		t.Errorf("retry-after=%v, want within the window", wait)
	}
	// Another admin has their own budget.
	if ok, _ := lim.allow(8, now); !ok {
		t.Error("a second admin was blocked by the first admin's usage")
	}
	// The window slides.
	if ok, _ := lim.allow(7, now.Add(providerTestWindow+time.Second)); !ok {
		t.Error("the budget never recovers")
	}
}
