package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

const testSecret = "test-secret"

func accessToken(t *testing.T, userID int64) string {
	t.Helper()
	c := jwt.MapClaims{
		"sub":  userID,
		"role": "user",
		"type": "access",
		"exp":  time.Now().Add(time.Hour).Unix(),
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func testServer() *Server {
	// No entitlements/limiter/store needed for the proxy path (store is nil, so
	// tracking is skipped). Only the JWT secret matters.
	return &Server{cfg: &config.Config{JWTSecret: testSecret}}
}

func newProxyReq(token, upstream, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/proxy", strings.NewReader(body))
	if token != "" {
		req.Header.Set("X-Rayu-Token", token)
	}
	if upstream != "" {
		req.Header.Set("X-Rayu-Upstream-URL", upstream)
	}
	return req
}

func TestHandleProxyAuth(t *testing.T) {
	s := testServer()
	cases := []struct {
		name  string
		token string
	}{
		{"missing token", ""},
		{"invalid token", "not.a.jwt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			s.handleProxy(rec, newProxyReq(tc.token, "https://api.example.com/v1/chat/completions", "{}"))
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d, want 401", rec.Code)
			}
			if rec.Header().Get("X-Rayu-Proxy-Error") == "" {
				t.Fatal("missing X-Rayu-Proxy-Error header (CLI needs it to fail safe)")
			}
		})
	}
}

func TestHandleProxyValidation(t *testing.T) {
	s := testServer()
	tok := accessToken(t, 7)
	cases := []struct {
		name     string
		upstream string
		want     int
	}{
		{"missing upstream", "", http.StatusBadRequest},
		{"non-https", "http://api.example.com/v1", http.StatusForbidden},
		{"ssrf localhost", "https://localhost/v1", http.StatusForbidden},
		{"ssrf loopback ip", "https://127.0.0.1/v1", http.StatusForbidden},
		{"ssrf private ip", "https://10.0.0.5/v1", http.StatusForbidden},
		{"ssrf metadata", "https://169.254.169.254/latest/meta-data", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			s.handleProxy(rec, newProxyReq(tok, tc.upstream, "{}"))
			if rec.Code != tc.want {
				t.Fatalf("status=%d, want %d", rec.Code, tc.want)
			}
			if rec.Header().Get("X-Rayu-Proxy-Error") == "" {
				t.Fatal("missing X-Rayu-Proxy-Error header")
			}
		})
	}
}

func TestHandleProxyForwardsAndTags(t *testing.T) {
	// Relax the SSRF guard so we can forward to a loopback httptest upstream.
	old := validateUpstreamURL
	validateUpstreamURL = func(string) error { return nil }
	defer func() { validateUpstreamURL = old }()

	var sawAuth, sawRayuToken string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawRayuToken = r.Header.Get("X-Rayu-Token") // must NOT be forwarded
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	s := testServer()
	req := newProxyReq(accessToken(t, 7), upstream.URL, `{"model":"gpt-x"}`)
	req.Header.Set("Authorization", "Bearer user-key") // provider key to forward
	req.Header.Set("X-Rayu-Provider", "openai")
	rec := httptest.NewRecorder()
	s.handleProxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", rec.Code)
	}
	if rec.Header().Get("X-Rayu-Proxied") != "1" {
		t.Fatal("missing X-Rayu-Proxied marker on a successfully proxied response")
	}
	if rec.Header().Get("X-Rayu-Proxy-Error") != "" {
		t.Fatalf("unexpected proxy-error header: %q", rec.Header().Get("X-Rayu-Proxy-Error"))
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Fatalf("body=%q", rec.Body.String())
	}
	if sawAuth != "Bearer user-key" {
		t.Fatalf("upstream auth=%q, want forwarded provider key", sawAuth)
	}
	if sawRayuToken != "" {
		t.Fatalf("X-Rayu-Token leaked to upstream: %q", sawRayuToken)
	}
}

func TestHandleProxyFailSafeOnUnreachable(t *testing.T) {
	old := validateUpstreamURL
	validateUpstreamURL = func(string) error { return nil }
	defer func() { validateUpstreamURL = old }()

	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := dead.URL
	dead.Close() // nothing listening now

	s := testServer()
	rec := httptest.NewRecorder()
	s.handleProxy(rec, newProxyReq(accessToken(t, 7), url, "{}"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d, want 502", rec.Code)
	}
	if rec.Header().Get("X-Rayu-Proxy-Error") == "" {
		t.Fatal("missing X-Rayu-Proxy-Error header on gateway-origin failure")
	}
	if rec.Header().Get("X-Rayu-Proxied") != "" {
		t.Fatal("X-Rayu-Proxied must NOT be set on a gateway-origin failure")
	}
}

func TestValidateUpstreamURLGuard(t *testing.T) {
	// Exercise the real guard (default value of the var).
	ok := []string{"https://api.openai.com/v1/chat/completions", "https://integrate.api.nvidia.com/v1"}
	for _, u := range ok {
		if err := validateUpstreamURL(u); err != nil {
			t.Errorf("validate(%q) = %v, want nil", u, err)
		}
	}
	bad := []string{"http://api.openai.com", "https://localhost", "https://127.0.0.1", "https://10.1.2.3", "ftp://x"}
	for _, u := range bad {
		if err := validateUpstreamURL(u); err == nil {
			t.Errorf("validate(%q) = nil, want error", u)
		}
	}
}

// TestInflightLimiterShedsAtCapacity proves graceful load-shedding: with a cap of
// 1, while one request holds the slot a second concurrent request is rejected
// FAST with a clean, retryable 503 provider_unavailable (the CLI's friendly
// "temporarily unavailable" message) — not queued, not a silent origin failure.
func TestInflightLimiterShedsAtCapacity(t *testing.T) {
	l := newInflightLimiter(1)
	entered := make(chan struct{})
	release := make(chan struct{})
	h := l.wrap(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
		w.WriteHeader(http.StatusOK)
	})

	go h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", nil))
	<-entered // the single slot is now held

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("at capacity: status=%d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), httpx.ProviderUnavailableType) {
		t.Fatalf("body=%q, want a clean provider_unavailable", rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatalf("expected Retry-After on the shed 503")
	}
	close(release)
}

// TestInflightLimiterUnlimited: RAYU_MAX_INFLIGHT=0 disables shedding entirely.
func TestInflightLimiterUnlimited(t *testing.T) {
	l := newInflightLimiter(0)
	if l.sem != nil {
		t.Fatal("max<=0 must mean unlimited (nil semaphore)")
	}
	called := 0
	h := l.wrap(func(w http.ResponseWriter, _ *http.Request) { called++; w.WriteHeader(http.StatusOK) })
	for i := 0; i < 5; i++ {
		h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/x", nil))
	}
	if called != 5 {
		t.Fatalf("unlimited limiter should pass every request through, got %d/5", called)
	}
}
