package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// Onboarding a NEW provider is where the provider test earns its keep: nothing is
// proven yet, so every answer has to name the field that is actually wrong. These
// tests cover the failures that look like something else — a web page served for a
// mistyped path, a provider that speaks a different wire format, and a key that a
// previous misconfiguration got condemned for.

// htmlUpstream serves a single-page app for every path, exactly as a provider's
// website does when the API path is misspelled.
func htmlUpstream() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" /><link rel="icon" href="/logo.png" />
<meta name="description" content="Claude Code, OpenAI Codex, Gemini Cli" /></head><body></body></html>`)
	}
}

// providerAt builds a harness whose provider row can be shaped per test (format,
// endpoint path, auth scheme) — onboarding is exactly about getting those right.
func providerAt(
	t *testing.T,
	upstream http.HandlerFunc,
	format, endpointPath string,
	keys []providerkeys.Key,
) (http.Handler, *fakeEnt, func()) {
	t.Helper()
	srv := httptest.NewServer(upstream)
	prov := store.Provider{
		ID: provIDLongCat, Name: "agent-router", Label: "Agent Router",
		Format: format, BaseURL: srv.URL, EndpointPath: endpointPath,
		AuthScheme: providercfg.AuthBearer, Enabled: true,
	}
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 900, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("claude-opus-4-7", prov, "claude-opus-4-8", 1)},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1},
		providerKeys: map[int64][]providerkeys.Key{provIDLongCat: keys},
	}
	h, _ := chatHarness(t, fe)
	return h, fe, srv.Close
}

// REPORTED: a provider configured with "/athropic/v1/messages" (a typo for
// "anthropic") served its website with HTTP 200, and the test said "format
// mismatch — check the provider's format setting" while ticking "key accepted".
// Both are wrong: the format was right, the PATH was misspelled, and an HTML page
// proves nothing about the credential. Following that advice makes things worse.
func TestProviderTestBlamesTheURLWhenTheAnswerIsAWebPage(t *testing.T) {
	h, _, done := providerAt(t, htmlUpstream(),
		providercfg.FormatAnthropicMessages, "/athropic/v1/messages", liveKey())
	defer done()

	code, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if res.Classification != testBadBaseURL {
		t.Fatalf("classification=%q, want %q — an HTML page is a wrong URL, not a wrong format",
			res.Classification, testBadBaseURL)
	}
	if strings.Contains(strings.ToLower(res.Message), "format setting") {
		t.Errorf("message sends the admin to the format setting: %q", res.Message)
	}
	if !strings.Contains(strings.ToLower(res.Message), "web page") {
		t.Errorf("message does not say what came back: %q", res.Message)
	}
	// The endpoint answered, but nothing authenticated and no model was judged.
	assertCheck(t, "reachable", res.Checks.Reachable, boolPtr(true))
	assertCheck(t, "keyAccepted", res.Checks.KeyAccepted, nil)
	assertCheck(t, "modelAccepted", res.Checks.ModelAccepted, nil)
	// And it must show the URL it actually called, so the admin can compare it with
	// the provider's documentation — without being told their path is "wrong", since
	// a provider may serve this format at any path it likes.
	if !strings.Contains(res.Suggestion, "/athropic/v1/messages") {
		t.Errorf("suggestion does not show the URL that was called: %q", res.Suggestion)
	}
	if strings.Contains(res.Suggestion, "Did you mean") {
		t.Errorf("suggestion prescribes a path: %q", res.Suggestion)
	}
}

// A provider that serves the Anthropic format at a completely custom path is a
// legitimate, common setup. It must pass with no complaint about the path.
func TestProviderTestAcceptsAnyPathTheProviderActuallyServes(t *testing.T) {
	const custom = "/relay/claude/v3"
	h, _, done := providerAt(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != custom {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":{"message":"not found"}}`)
			return
		}
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[{"type":"text","text":"pong"}]}`)
	}, providercfg.FormatAnthropicMessages, custom, liveKey())
	defer done()

	code, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if !res.OK || res.Classification != testOK {
		t.Fatalf("result=%s (%s), want a pass — the path is the provider's to choose",
			res.Classification, res.Message)
	}
	if !strings.HasSuffix(res.Endpoint, custom) {
		t.Errorf("endpoint=%q, want it to end with the configured path %q", res.Endpoint, custom)
	}
	if res.Suggestion != "" {
		t.Errorf("a healthy provider must get no advice, got %q", res.Suggestion)
	}
}

// The gateway must never substitute its own idea of a path. Whatever the admin
// typed is what gets called, for every format — that is the whole contract, and a
// provider is free to serve the Anthropic or OpenAI body shape anywhere.
func TestProviderTestCallsExactlyTheConfiguredPath(t *testing.T) {
	for _, c := range []struct {
		format string
		path   string
	}{
		{providercfg.FormatAnthropicMessages, "/athropic/v1/messages"},
		{providercfg.FormatAnthropicMessages, "/some/vendor/route"},
		{providercfg.FormatOpenAIChat, "/openai/deep/path/completions"},
		{providercfg.FormatOpenAIResponses, "/r"},
	} {
		t.Run(c.format+c.path, func(t *testing.T) {
			var called string
			h, _, done := providerAt(t, func(w http.ResponseWriter, r *http.Request) {
				called = r.URL.Path
				_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[]}`)
			}, c.format, c.path, liveKey())
			defer done()

			if _, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`); res.Endpoint == "" {
				t.Fatalf("no endpoint reported")
			}
			if called != c.path {
				t.Errorf("upstream saw path %q, want exactly the configured %q", called, c.path)
			}
		})
	}
}

// A JSON answer in a DIFFERENT known format is the real "format mismatch", and the
// test should name the format the provider actually speaks instead of leaving the
// admin to try all four.
func TestProviderTestNamesTheFormatTheProviderActuallySpeaks(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			"openai chat completions",
			`{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,` +
				`"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],` +
				`"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
			providercfg.FormatOpenAIChat,
		},
		{
			"openai responses",
			`{"id":"resp_1","object":"response","status":"completed",` +
				`"output":[{"type":"message","content":[{"type":"output_text","text":"pong"}]}],` +
				`"usage":{"input_tokens":3,"output_tokens":1}}`,
			providercfg.FormatOpenAIResponses,
		},
		{
			"google genai",
			`{"candidates":[{"content":{"parts":[{"text":"pong"}],"role":"model"},` +
				`"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}`,
			providercfg.FormatGenAI,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, _, done := providerAt(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, c.body)
			}, providercfg.FormatAnthropicMessages, "", liveKey())
			defer done()

			_, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`)
			if res.Classification != testFormatMismatch {
				t.Fatalf("classification=%q, want %q", res.Classification, testFormatMismatch)
			}
			if !strings.Contains(res.Suggestion, c.want) {
				t.Errorf("suggestion=%q, want it to name %q", res.Suggestion, c.want)
			}
		})
	}
}

// REPORTED: one 401 against a misconfigured URL took key #7 out of rotation for
// good, and every later per-model test answered "no usable API key for this
// provider" in 3ms without calling anything. During onboarding a 401 is at least as
// likely to mean "wrong URL" or "wrong auth scheme" as "wrong key", so a TEST must
// never condemn a credential — real traffic, which runs on proven configuration,
// still does.
func TestProviderTestDoesNotCondemnAKeyOnUnprovenConfig(t *testing.T) {
	h, fe, done := providerAt(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"invalid api key"}}`)
	}, providercfg.FormatAnthropicMessages, "", liveKey())
	defer done()

	_, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`)
	if res.Classification != testBadAPIKey {
		t.Fatalf("classification=%q, want %q", res.Classification, testBadAPIKey)
	}
	// The verdict is reported…
	assertCheck(t, "keyAccepted", res.Checks.KeyAccepted, boolPtr(false))
	// …but the key is still available, so the admin can fix the URL and retry.
	if n := len(fe.Keys().Pick(provIDLongCat)); n != 1 {
		t.Fatalf("usable keys=%d, want 1 — a test must not remove a key from rotation", n)
	}
}

// A 429 is different: the provider itself said "later", and the cooldown expires on
// its own, so it stays.
func TestProviderTestStillCoolsARateLimitedKey(t *testing.T) {
	h, fe, done := providerAt(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"rate limit"}}`)
	}, providercfg.FormatAnthropicMessages, "", liveKey())
	defer done()

	_, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`)
	if res.Classification != testRateLimited {
		t.Fatalf("classification=%q, want %q", res.Classification, testRateLimited)
	}
	if n := len(fe.Keys().Pick(provIDLongCat)); n != 0 {
		t.Fatalf("usable keys=%d, want 0 while cooling down", n)
	}
}

// REPORTED (the dead end): with the only key already condemned, a per-model test
// refused to run at all — "no usable API key for this provider — add one, or test a
// specific key by id" — so fixing the URL could never be verified. A test is how a
// key gets its verdict overturned, so it must USE the condemned key and say so.
func TestProviderTestFallsBackToACondemnedKeyInsteadOfRefusing(t *testing.T) {
	h, fe, done := providerAt(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[{"type":"text","text":"pong"}]}`)
	}, providercfg.FormatAnthropicMessages, "", liveKey())
	defer done()

	// The state the reported gateway was in: the one key is out of rotation.
	fe.Keys().MarkInvalid(provIDLongCat, 31, "HTTP 401")
	if n := len(fe.Keys().Pick(provIDLongCat)); n != 0 {
		t.Fatalf("precondition: usable keys=%d, want 0", n)
	}

	code, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200 — the test must run so the key can be re-proven", code)
	}
	if res.KeyID != 31 {
		t.Fatalf("keyId=%d, want the condemned key 31 to have been used", res.KeyID)
	}
	if !res.OK {
		t.Fatalf("result=%+v, want a pass", res)
	}
	// Passing is proof the credential works, so it returns to rotation.
	if n := len(fe.Keys().Pick(provIDLongCat)); n != 1 {
		t.Fatalf("usable keys=%d after a successful test, want 1 (rehabilitated)", n)
	}
}

// When the fallback is used, the answer must say which key and why it was skipped —
// otherwise a pass looks like the provider is healthy when rotation still is not.
func TestProviderTestReportsThatItUsedASkippedKey(t *testing.T) {
	h, fe, done := providerAt(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"invalid api key"}}`)
	}, providercfg.FormatAnthropicMessages, "", liveKey())
	defer done()
	fe.Keys().MarkInvalid(provIDLongCat, 31, "HTTP 401")

	_, res := runProviderTest(t, h, "admin", `{"providerId":2,"modelCode":"claude-opus-4-7"}`)
	low := strings.ToLower(res.Suggestion + " " + res.Message)
	if !strings.Contains(low, "out of rotation") && !strings.Contains(low, "not in rotation") {
		t.Errorf("nothing says the key it used is out of rotation: message=%q suggestion=%q",
			res.Message, res.Suggestion)
	}
}

// A provider with NO keys at all is still an error — there is nothing to test with.
func TestProviderTestStillRefusesWhenThereAreNoKeys(t *testing.T) {
	h, _, done := providerAt(t, htmlUpstream(),
		providercfg.FormatAnthropicMessages, "", []providerkeys.Key{})
	defer done()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_provider-test",
		strings.NewReader(`{"providerId":2,"modelCode":"claude-opus-4-7"}`))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 900, "admin"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "add") {
		t.Errorf("message should tell the admin to add a key: %s", rec.Body.String())
	}
}
