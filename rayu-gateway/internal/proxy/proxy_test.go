package proxy

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

func TestStreamProxiesAndParsesUsage(t *testing.T) {
	const wantAuth = "Bearer sk-test"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != wantAuth {
			t.Errorf("auth header=%q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}],\"usage\":null}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7,\"total_tokens\":18}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	usage, wrote, err := Stream(context.Background(), rec, upstream.URL, "sk-test", []byte(`{"model":"x","stream":true}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !wrote {
		t.Fatal("expected wrote=true")
	}
	if usage == nil || usage.TotalTokens != 18 || usage.PromptTokens != 11 || usage.CompletionTokens != 7 {
		t.Fatalf("usage=%+v", usage)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Hello") || !strings.Contains(body, "[DONE]") {
		t.Fatalf("body not proxied: %q", body)
	}
}

// TestStreamSanitizesUpstreamError verifies the hosted streaming path NEVER
// leaks the upstream provider's raw error body to the customer: an upstream 4xx
// with a provider-specific message is replaced by a clean, upstream-agnostic 502
// provider_unavailable (the CLI turns this into "try a smaller model or try again
// later"). The real upstream status/body is still returned as the Go error for
// the server-side log.
func TestStreamSanitizesUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"error":{"message":"this model requires a subscription, upgrade for access: https://ollama.com/upgrade"}}`)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	_, wrote, err := Stream(context.Background(), rec, upstream.URL, "sk-test", []byte(`{}`))
	if err == nil {
		t.Fatal("expected upstream error")
	}
	if !wrote || rec.Code != http.StatusBadGateway {
		t.Fatalf("expected sanitized 502, got wrote=%v code=%d", wrote, rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, httpx.ProviderUnavailableType) {
		t.Fatalf("client body missing provider_unavailable marker: %q", body)
	}
	if strings.Contains(body, "ollama.com") || strings.Contains(body, "subscription") {
		t.Fatalf("upstream error leaked to client: %q", body)
	}
	// The real upstream status is preserved in the Go error for the server log.
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("server-side error should carry the real status: %v", err)
	}
}

// TestStreamRetriesTransientUpstreamError mirrors TestForwardRetriesTransientUpstreamError
// for the hosted-model streaming path (DeepSeek/DeepInfra via handleChat).
func TestStreamRetriesTransientUpstreamError(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, `{"error":"no available server"}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	_, wrote, err := Stream(context.Background(), rec, upstream.URL, "sk-test", []byte(`{}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !wrote || rec.Code != http.StatusOK {
		t.Fatalf("wrote=%v code=%d, want wrote=true code=200", wrote, rec.Code)
	}
	if calls != 2 {
		t.Fatalf("upstream calls=%d, want 2 (initial + 1 retry)", calls)
	}
}

// TestStreamHeaderTimeoutFailsFast proves the ResponseHeaderTimeout guard: an
// upstream that accepts the connection but STALLS before sending response
// headers (the Ollama-at-its-limit / overloaded case) makes the request fail
// quickly with wrote=false — so the server layer emits a clean
// provider_unavailable 502 instead of the gateway hanging until Cloudflare
// substitutes its own "origin_bad_gateway" page. Uses a tiny timeout so the
// test is fast.
func TestStreamHeaderTimeoutFailsFast(t *testing.T) {
	block := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-block // never send response headers until the test tears down
	}))

	orig := Client
	Client = &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 150 * time.Millisecond}}
	defer func() { Client = orig }()
	defer upstream.Close()
	defer close(block)

	rec := httptest.NewRecorder()
	start := time.Now()
	_, wrote, err := Stream(context.Background(), rec, upstream.URL, "sk", []byte(`{}`))
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a header-timeout error, got nil")
	}
	if wrote {
		t.Fatalf("expected wrote=false on a pre-flight header timeout, got wrote=true (body=%q)", rec.Body.String())
	}
	if elapsed > 3*time.Second {
		t.Fatalf("header timeout did not fail fast: took %v", elapsed)
	}
}

func TestComplete(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`)
	}))
	defer upstream.Close()

	usage, status, body, err := Complete(context.Background(), upstream.URL, "sk-test", []byte(`{"model":"x"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("status=%d", status)
	}
	if usage == nil || usage.TotalTokens != 8 {
		t.Fatalf("usage=%+v", usage)
	}
	if !strings.Contains(string(body), "hi") {
		t.Fatalf("body=%s", body)
	}
}

// TestForward verifies the transparent forwarder replays method/body/headers to
// the upstream and streams the response (status + headers + body) back.
func TestForward(t *testing.T) {
	var gotAuth, gotBody, gotMethod string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotMethod = r.Method
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("X-Upstream", "yes")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("hello-from-upstream"))
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	hdrs := http.Header{}
	hdrs.Set("Authorization", "Bearer user-provider-key")
	hdrs.Set("Content-Type", "application/json")
	status, wrote, err := Forward(context.Background(), rec, http.MethodPost, upstream.URL, hdrs, []byte(`{"model":"m"}`))
	if err != nil {
		t.Fatalf("Forward err: %v", err)
	}
	if !wrote {
		t.Fatal("wrote=false, want true")
	}
	if status != http.StatusCreated {
		t.Fatalf("status=%d, want 201", status)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("upstream method=%q", gotMethod)
	}
	if gotAuth != "Bearer user-provider-key" {
		t.Fatalf("upstream did not receive forwarded auth: %q", gotAuth)
	}
	if gotBody != `{"model":"m"}` {
		t.Fatalf("upstream body=%q", gotBody)
	}
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d, want 201", rec.Code)
	}
	if rec.Header().Get("X-Upstream") != "yes" {
		t.Fatal("upstream response header not copied back")
	}
	if rec.Body.String() != "hello-from-upstream" {
		t.Fatalf("body=%q", rec.Body.String())
	}
}

// TestForwardUpstreamUnreachable reports wrote=false + err when the upstream
// cannot be dialed, so the caller can emit a fail-safe error.
func TestForwardUpstreamUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // now nothing is listening at url

	rec := httptest.NewRecorder()
	_, wrote, err := Forward(context.Background(), rec, http.MethodPost, url, http.Header{}, []byte(`{}`))
	if err == nil {
		t.Fatal("expected error for unreachable upstream")
	}
	if wrote {
		t.Fatal("wrote=true, want false (nothing should be written on dial failure)")
	}
}

// TestForwardRetriesTransientUpstreamError verifies a 503 on the first attempt
// is retried transparently (before anything is written to the client) and a
// subsequent 200 is what actually reaches the caller.
func TestForwardRetriesTransientUpstreamError(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, `{"error":"no available server"}`)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok-on-retry"))
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	status, wrote, err := Forward(context.Background(), rec, http.MethodPost, upstream.URL, http.Header{}, []byte(`{}`))
	if err != nil {
		t.Fatalf("Forward err: %v", err)
	}
	if !wrote || status != http.StatusOK {
		t.Fatalf("wrote=%v status=%d, want wrote=true status=200", wrote, status)
	}
	if calls != 2 {
		t.Fatalf("upstream calls=%d, want 2 (initial + 1 retry)", calls)
	}
	if rec.Body.String() != "ok-on-retry" {
		t.Fatalf("body=%q, want the retried response's body", rec.Body.String())
	}
}

// TestForwardGivesUpAfterMaxRetries verifies a persistently-503 upstream is
// eventually relayed to the client as-is rather than retried forever.
func TestForwardGivesUpAfterMaxRetries(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"no available server"}`)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	status, wrote, err := Forward(context.Background(), rec, http.MethodPost, upstream.URL, http.Header{}, []byte(`{}`))
	if err != nil {
		t.Fatalf("Forward err: %v", err)
	}
	if !wrote || status != http.StatusServiceUnavailable {
		t.Fatalf("wrote=%v status=%d, want wrote=true status=503", wrote, status)
	}
	if calls != maxUpstreamRetries+1 {
		t.Fatalf("upstream calls=%d, want %d (initial + %d retries)", calls, maxUpstreamRetries+1, maxUpstreamRetries)
	}
	if !strings.Contains(rec.Body.String(), "no available server") {
		t.Fatalf("final error body not passed through: %q", rec.Body.String())
	}
}

// TestForwardDoesNotRetryClientErrors verifies a 4xx (the caller's fault, not
// a capacity blip) is relayed immediately without wasting retries.
func TestForwardDoesNotRetryClientErrors(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	status, wrote, err := Forward(context.Background(), rec, http.MethodPost, upstream.URL, http.Header{}, []byte(`{}`))
	if err != nil {
		t.Fatalf("Forward err: %v", err)
	}
	if !wrote || status != http.StatusUnauthorized {
		t.Fatalf("wrote=%v status=%d, want wrote=true status=401", wrote, status)
	}
	if calls != 1 {
		t.Fatalf("upstream calls=%d, want 1 (no retry on 4xx)", calls)
	}
}
