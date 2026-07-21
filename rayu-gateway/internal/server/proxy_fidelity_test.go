package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
)

func TestModelFromUpstreamURL(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want string
	}{
		{
			"opus streaming",
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-4-6-v1/invoke-with-response-stream",
			"us.anthropic.claude-opus-4-6-v1",
		},
		{
			"haiku non-streaming",
			"https://bedrock-runtime.ap-southeast-1.amazonaws.com/model/global.anthropic.claude-haiku-4-5-20251001-v1:0/invoke",
			"global.anthropic.claude-haiku-4-5-20251001-v1:0",
		},
		{
			"non-bedrock url",
			"https://api.deepseek.com/anthropic/v1/messages",
			"",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := modelFromUpstreamURL(c.url); got != c.want {
				t.Fatalf("modelFromUpstreamURL(%q)=%q want %q", c.url, got, c.want)
			}
		})
	}
}

func TestModelFamilyOfAndMismatch(t *testing.T) {
	if modelFamilyOf("us.anthropic.claude-opus-4-6-v1") != "opus" {
		t.Fatal("opus family")
	}
	if modelFamilyOf("claude-sonnet-4-6") != "sonnet" {
		t.Fatal("sonnet family")
	}
	if modelFamilyOf("deepseek-v4-pro") != "other" {
		t.Fatal("other family")
	}
	// Definite cross-family -> mismatch.
	if !familyMismatch("claude-sonnet-4-6", "us.anthropic.claude-opus-4-6-v1") {
		t.Fatal("expected sonnet->opus mismatch")
	}
	// Same family -> no mismatch.
	if familyMismatch("claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6-v1:0") {
		t.Fatal("same family must not mismatch")
	}
	// Opaque / unknown -> never a mismatch.
	if familyMismatch("claude-sonnet-4-6", "my-custom-deployment") {
		t.Fatal("opaque value must not mismatch")
	}
	if familyMismatch("", "us.anthropic.claude-opus-4-6-v1") {
		t.Fatal("empty intended must not mismatch")
	}
}

type fakeTimeoutErr struct{}

func (fakeTimeoutErr) Error() string { return "i/o timeout" }
func (fakeTimeoutErr) Timeout() bool { return true }

func TestClassifyBodyReadError(t *testing.T) {
	if s, l := classifyBodyReadError(&http.MaxBytesError{Limit: 8}, nil); s != http.StatusRequestEntityTooLarge || l != "too large" {
		t.Fatalf("too-large: got (%d,%q)", s, l)
	}
	if s, l := classifyBodyReadError(fakeTimeoutErr{}, nil); s != http.StatusRequestTimeout || l != "timeout" {
		t.Fatalf("timeout(net): got (%d,%q)", s, l)
	}
	if s, l := classifyBodyReadError(context.Canceled, context.DeadlineExceeded); s != http.StatusRequestTimeout || l != "timeout" {
		t.Fatalf("timeout(ctx): got (%d,%q)", s, l)
	}
	if s, l := classifyBodyReadError(context.Canceled, nil); s != http.StatusBadRequest || l != "unreadable" {
		t.Fatalf("generic: got (%d,%q)", s, l)
	}
}

// When RAYU_ENFORCE_MODEL_FIDELITY is on, a request whose intended model family
// differs from the model actually routed (Bedrock URL path) is rejected with
// 409 BEFORE any upstream call — the exact "selected Sonnet, routed Opus" bug.
func TestHandleProxyFidelityRejectWhenEnforced(t *testing.T) {
	s := &Server{cfg: &config.Config{JWTSecret: testSecret, EnforceModelFidelity: true}}
	bedrockOpus := "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-4-6-v1/invoke-with-response-stream"
	req := newProxyReq(accessToken(t, 20), bedrockOpus, `{"max_tokens":1,"messages":[]}`)
	req.Header.Set("X-Rayu-Intended-Model", "claude-sonnet-4-6")
	req.Header.Set("X-Rayu-Provider", "bedrock-anthropic")
	rec := httptest.NewRecorder()
	s.handleProxy(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d, want 409 (fidelity reject)", rec.Code)
	}
	if rec.Header().Get("X-Rayu-Model-Fidelity") != "mismatch" {
		t.Fatal("missing X-Rayu-Model-Fidelity=mismatch marker")
	}
	if rec.Header().Get("X-Rayu-Proxy-Error") == "" {
		t.Fatal("expected X-Rayu-Proxy-Error so the CLI treats it as gateway-origin")
	}
}

// Default (enforcement OFF): a family mismatch is LOGGED but still forwarded, so
// existing traffic is never broken by the new check.
func TestHandleProxyFidelityLogOnlyByDefault(t *testing.T) {
	old := validateUpstreamURL
	validateUpstreamURL = func(string) error { return nil }
	defer func() { validateUpstreamURL = old }()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	s := testServer() // EnforceModelFidelity defaults to false
	req := newProxyReq(accessToken(t, 20), upstream.URL, `{"model":"us.anthropic.claude-opus-4-6-v1"}`)
	req.Header.Set("Authorization", "Bearer user-key")
	req.Header.Set("X-Rayu-Intended-Model", "claude-sonnet-4-6") // mismatch (logged only)
	rec := httptest.NewRecorder()
	s.handleProxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200 (mismatch is log-only by default)", rec.Code)
	}
	if rec.Header().Get("X-Rayu-Proxied") != "1" {
		t.Fatal("expected the request to be forwarded (X-Rayu-Proxied=1)")
	}
}
