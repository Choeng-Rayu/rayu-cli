package proxy

import (
	"context"
	"fmt"
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
