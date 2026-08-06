package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

func TestIsUpstreamRequestError(t *testing.T) {
	// Client-fixable request errors → relay with real status.
	for _, s := range []int{
		http.StatusBadRequest,            // 400
		http.StatusRequestEntityTooLarge, // 413
		http.StatusUnprocessableEntity,   // 422
	} {
		if !IsUpstreamRequestError(s) {
			t.Errorf("status %d should be a request error", s)
		}
	}
	// Provider-side / transient / auth → keep sanitized 502.
	for _, s := range []int{
		http.StatusOK,                  // 200
		http.StatusUnauthorized,        // 401
		http.StatusForbidden,           // 403
		http.StatusTooManyRequests,     // 429
		http.StatusInternalServerError, // 500
		http.StatusBadGateway,          // 502
		http.StatusServiceUnavailable,  // 503
		http.StatusGatewayTimeout,      // 504
	} {
		if IsUpstreamRequestError(s) {
			t.Errorf("status %d should NOT be a request error", s)
		}
	}
}

func TestUpstreamErrorMessage(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"anthropic", `{"type":"error","error":{"type":"invalid_request_error","message":"this model does not support image input"}}`, "this model does not support image input"},
		{"openai", `{"error":{"message":"context length exceeded","type":"invalid_request_error"}}`, "context length exceeded"},
		{"top-level", `{"message":"bad request"}`, "bad request"},
		{"empty", ``, ""},
		{"garbage", `not json`, ""},
		{"no message", `{"error":{"type":"x"}}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := UpstreamErrorMessage([]byte(c.body)); got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}

// The real production bug: an image sent to glm-5.2 → upstream 400
// "does not support image input". The gateway must relay that 400 (+ message)
// so the CLI shows the cause and the SDK doesn't retry — NOT mask it as a
// retryable 502.
func TestStreamAnthropicRelaysRequestError(t *testing.T) {
	const upstreamBody = `{"type":"error","error":{"type":"invalid_request_error","message":"this model does not support image input (ref: abc123)"}}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, upstreamBody)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	_, wrote, err := StreamAnthropic(context.Background(), rec, upstream.URL, testKeys("k"), false,
		[]byte(`{"model":"glm-5.2","stream":true}`), nil)
	if err == nil || !strings.Contains(err.Error(), "upstream status 400") {
		t.Fatalf("err=%v, want it to note upstream status 400", err)
	}
	if !wrote {
		t.Fatal("expected wrote=true")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("client status=%d, want 400 (relayed, not masked to 502)", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "does not support image input") {
		t.Fatalf("client body should surface the real cause; got: %s", body)
	}
	if !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, "invalid_request_error") {
		t.Fatalf("client body should be a native Anthropic error envelope; got: %s", body)
	}
	if strings.Contains(body, "provider_unavailable") {
		t.Fatalf("a 400 must NOT be masked as provider_unavailable; got: %s", body)
	}
}

// A provider-side 5xx (and auth) must STILL be sanitized to a clean 502 so the
// upstream's raw body / subscription hints never reach the customer.
func TestStreamAnthropicMasksProviderFailureAs502(t *testing.T) {
	for _, upstreamStatus := range []int{http.StatusInternalServerError, http.StatusForbidden} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(upstreamStatus)
			_, _ = io.WriteString(w, `{"error":{"message":"requires a subscription at ollama.com/upgrade"}}`)
		}))
		rec := httptest.NewRecorder()
		_, wrote, _ := StreamAnthropic(context.Background(), rec, upstream.URL, testKeys("k"), false,
			[]byte(`{"model":"glm-5.2","stream":true}`), nil)
		upstream.Close()
		if !wrote {
			t.Fatalf("status %d: expected wrote=true", upstreamStatus)
		}
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("upstream %d → client status=%d, want 502", upstreamStatus, rec.Code)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "provider_unavailable") {
			t.Fatalf("upstream %d should be sanitized to provider_unavailable; got: %s", upstreamStatus, body)
		}
		if strings.Contains(body, "ollama.com/upgrade") {
			t.Fatalf("upstream %d must NOT leak the raw provider body; got: %s", upstreamStatus, body)
		}
	}
}

// relayUpstreamError also serves the OpenAI error envelope (still used by the
// BYO-key proxy path and the retired-ingress response), so both writers are
// covered: a request error keeps its real status + message, a provider failure is
// masked as 502.
func TestRelayUpstreamErrorOpenAIShape(t *testing.T) {
	rec := httptest.NewRecorder()
	relayUpstreamError(rec, http.StatusBadRequest,
		[]byte(`{"error":{"message":"context length exceeded","type":"invalid_request_error"}}`),
		httpx.WriteError)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "context length exceeded") {
		t.Fatalf("client body should surface the cause; got: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	relayUpstreamError(rec, http.StatusForbidden,
		[]byte(`{"error":{"message":"your plan requires an upgrade at https://provider.example/upgrade"}}`),
		httpx.WriteError)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want 502 (provider failure must be masked)", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "provider.example") {
		t.Fatalf("provider detail leaked to the client: %s", rec.Body.String())
	}
}
