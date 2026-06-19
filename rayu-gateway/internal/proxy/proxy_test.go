package proxy

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

func TestStreamPassesUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"bad model"}}`)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	_, wrote, err := Stream(context.Background(), rec, upstream.URL, "sk-test", []byte(`{}`))
	if err == nil {
		t.Fatal("expected upstream error")
	}
	if !wrote || rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 passthrough, got wrote=%v code=%d", wrote, rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad model") {
		t.Fatalf("error body not passed through: %q", rec.Body.String())
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
	wrote, err := Forward(context.Background(), rec, http.MethodPost, upstream.URL, hdrs, []byte(`{"model":"m"}`))
	if err != nil {
		t.Fatalf("Forward err: %v", err)
	}
	if !wrote {
		t.Fatal("wrote=false, want true")
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
	wrote, err := Forward(context.Background(), rec, http.MethodPost, url, http.Header{}, []byte(`{}`))
	if err == nil {
		t.Fatal("expected error for unreachable upstream")
	}
	if wrote {
		t.Fatal("wrote=true, want false (nothing should be written on dial failure)")
	}
}
