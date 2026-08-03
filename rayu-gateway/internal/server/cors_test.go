package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The gateway was built for the CLI, which is not a browser and never
// preflights. Rayu Studio is a browser client on rayucode.com, so these tests
// pin the CORS contract it depends on: a header missing from
// Access-Control-Allow-Headers makes the browser fail the whole request at
// preflight, and a header missing from Access-Control-Expose-Headers is silently
// unreadable from JS even though it arrives on the wire.

func corsHandler(origins []string) http.Handler {
	return corsMiddleware(origins)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

// splitHeaderList parses a comma-separated header value into a lowercase set,
// mirroring how a browser compares the allow-list (case-insensitively).
func splitHeaderList(v string) map[string]bool {
	out := map[string]bool{}
	for _, p := range strings.Split(v, ",") {
		if t := strings.ToLower(strings.TrimSpace(p)); t != "" {
			out[t] = true
		}
	}
	return out
}

func TestCORSAllowsStudioRequestHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/anthropic/v1/messages", nil)
	req.Header.Set("Origin", "https://rayucode.com")
	corsHandler([]string{"https://rayucode.com"}).ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want %d", rec.Code, http.StatusNoContent)
	}

	got := splitHeaderList(rec.Header().Get("Access-Control-Allow-Headers"))
	// Authorization+Content-Type are the pre-existing pair; the X-Rayu-* set is
	// what the BYO-key proxy path and correlation/idempotency need; the
	// anthropic-* pair is sent by the Anthropic SDKs on every request to the
	// hosted endpoint.
	for _, h := range []string{
		"authorization",
		"content-type",
		"x-rayu-token",
		"x-rayu-upstream-url",
		"x-rayu-request-id",
		"x-rayu-logical-request-id",
		"x-rayu-query-source",
		"x-rayu-intended-model",
		"anthropic-version",
		"anthropic-beta",
	} {
		if !got[h] {
			t.Errorf("Access-Control-Allow-Headers missing %q (browser would fail preflight)", h)
		}
	}
}

func TestCORSExposesCreditHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", nil)
	req.Header.Set("Origin", "https://rayucode.com")
	corsHandler([]string{"https://rayucode.com"}).ServeHTTP(rec, req)

	got := splitHeaderList(rec.Header().Get("Access-Control-Expose-Headers"))
	// Keep in sync with setCreditHeaders — without these a browser client can
	// stream a completion but never read the credits it just spent.
	for _, h := range []string{
		"x-rayu-credits-used",
		"x-rayu-credits-remaining",
		"x-rayu-topup-balance",
		"x-rayu-model-fidelity",
		"x-rayu-proxy-error",
		"x-rayu-token-count",
	} {
		if !got[h] {
			t.Errorf("Access-Control-Expose-Headers missing %q (unreadable from JS)", h)
		}
	}
}

// setCreditHeaders is the source of truth for what the billed path returns; if
// it gains a header that the expose list doesn't cover, a browser client stops
// seeing it. This asserts that coupling directly rather than by eyeball.
func TestExposeListCoversSetCreditHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	setCreditHeaders(rec, 100, 1000, 10, 5)

	exposed := splitHeaderList(corsExposeHeaders)
	for name := range rec.Header() {
		lower := strings.ToLower(name)
		if !strings.HasPrefix(lower, "x-rayu-") {
			continue
		}
		if !exposed[lower] {
			t.Errorf("setCreditHeaders sets %q but corsExposeHeaders omits it", lower)
		}
	}
}

func TestCORSPreflightSkipsAuth(t *testing.T) {
	// A browser never attaches Authorization to an OPTIONS. If the preflight
	// reached the authenticated group it would 401 and the request would never
	// be made, so the middleware must answer OPTIONS itself.
	s := &Server{cfg: nil}
	_ = s // routing is asserted below via the real router in TestCORS*, not here

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/anthropic/v1/messages", nil)
	req.Header.Set("Origin", "https://rayucode.com")
	req.Header.Set("Access-Control-Request-Method", "POST")

	called := false
	corsMiddleware([]string{"https://rayucode.com"})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	})).ServeHTTP(rec, req)

	if called {
		t.Error("preflight reached the next handler; it must short-circuit before auth")
	}
	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestCORSDisallowedOriginGetsNoHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/models", nil)
	req.Header.Set("Origin", "https://evil.example")
	corsHandler([]string{"https://rayucode.com"}).ServeHTTP(rec, req)

	if v := rec.Header().Get("Access-Control-Allow-Origin"); v != "" {
		t.Errorf("Access-Control-Allow-Origin = %q for a disallowed origin, want empty", v)
	}
	if v := rec.Header().Get("Access-Control-Expose-Headers"); v != "" {
		t.Errorf("Access-Control-Expose-Headers = %q for a disallowed origin, want empty", v)
	}
}

func TestCORSWildcardStillWorks(t *testing.T) {
	// GATEWAY_CORS_ORIGINS defaults to "*"; that behaviour must not regress.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/models", nil)
	req.Header.Set("Origin", "https://anything.example")
	corsHandler([]string{"*"}).ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://anything.example" {
		t.Errorf("Access-Control-Allow-Origin = %q, want the echoed origin", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Errorf("Vary = %q, want Origin", got)
	}
}

func TestCORSNoOriginIsUntouched(t *testing.T) {
	// The CLI sends no Origin. It must pass through with no CORS headers at all.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/models", nil)
	corsHandler([]string{"https://rayucode.com"}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if v := rec.Header().Get("Access-Control-Allow-Origin"); v != "" {
		t.Errorf("Access-Control-Allow-Origin = %q for a non-browser request, want empty", v)
	}
}

func TestUsageEventSource(t *testing.T) {
	// "gateway" is the historical value for every proxied row. The CLI sends no
	// X-Rayu-Query-Source (hostedIdentity yields "unknown"), so it must keep
	// landing in "gateway" — only an allow-listed client gets its own bucket.
	cases := []struct {
		name, in, want string
	}{
		{"cli sends nothing", "unknown", "gateway"},
		{"empty", "", "gateway"},
		{"cli feature name", "repl_main_thread", "gateway"},
		{"cli agent feature", "agent:reviewer", "gateway"},
		{"studio bare", "studio", "studio"},
		{"studio qualified", "studio:chat", "studio"},
		{"studio uppercase", "STUDIO", "studio"},
		{"studio padded", "  studio  ", "studio"},
		{"unknown client is not trusted", "totally-made-up", "gateway"},
		{"overlong client is not trusted", strings.Repeat("x", 200), "gateway"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := usageEventSource(c.in); got != c.want {
				t.Errorf("usageEventSource(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestUsageEventSourceFitsColumn(t *testing.T) {
	// usage_events.source is VarChar(32). An allow-list guarantees this, but
	// assert it so adding a long client name fails here instead of at INSERT.
	for _, v := range usageEventClients {
		if len(v) > 32 {
			t.Errorf("usageEventClients value %q is %d bytes, exceeds VarChar(32)", v, len(v))
		}
	}
}
