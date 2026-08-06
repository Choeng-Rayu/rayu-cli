package proxy

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// Streaming and non-streaming must NOT share a response-header budget. The 30s
// non-streaming value rests on "providers flush SSE headers within a second",
// which Ollama Cloud violates on a cold start — producing a bogus 502 for a
// request that was merely slow to the first byte.
func TestClientFor_StreamingUsesLongerHeaderTimeout(t *testing.T) {
	if got := clientFor(context.Background()); got != Client {
		t.Fatal("non-streaming context must use the standard Client")
	}
	if got := clientFor(WithStreaming(context.Background())); got != StreamClient {
		t.Fatal("streaming context must use StreamClient")
	}

	plain := Client.Transport.(*http.Transport).ResponseHeaderTimeout
	streaming := StreamClient.Transport.(*http.Transport).ResponseHeaderTimeout
	if plain != UpstreamResponseHeaderTimeout {
		t.Fatalf("non-streaming header timeout = %v, want %v", plain, UpstreamResponseHeaderTimeout)
	}
	if streaming <= plain {
		t.Fatalf("streaming header timeout %v must exceed non-streaming %v", streaming, plain)
	}
	if streaming != StreamHeaderTimeout() {
		t.Fatalf("StreamClient timeout %v != StreamHeaderTimeout() %v", streaming, StreamHeaderTimeout())
	}
}

func TestIsStreamingMarker(t *testing.T) {
	if IsStreaming(context.Background()) {
		t.Fatal("a bare context must not be marked streaming")
	}
	if !IsStreaming(WithStreaming(context.Background())) {
		t.Fatal("WithStreaming must mark the context")
	}
	// The marker must survive further derivation (deadlines, values).
	derived, cancel := context.WithTimeout(WithStreaming(context.Background()), time.Minute)
	defer cancel()
	if !IsStreaming(derived) {
		t.Fatal("marker lost across context derivation")
	}
}

// Key failover must not let N attempts × the larger streaming header timeout
// outlast the fronting CDN's patience for a silent origin.
func TestMaxStreamingAttempts(t *testing.T) {
	if got := maxStreamingAttempts(context.Background()); got != 0 {
		t.Fatalf("non-streaming must be uncapped, got %d", got)
	}

	origTimeout, origBudget := streamHeaderTimeout, streamFailoverBudget
	t.Cleanup(func() { streamHeaderTimeout, streamFailoverBudget = origTimeout, origBudget })

	streamHeaderTimeout, streamFailoverBudget = 60*time.Second, 90*time.Second
	if got := maxStreamingAttempts(WithStreaming(context.Background())); got != 1 {
		t.Fatalf("60s header / 90s budget → %d attempts, want 1", got)
	}

	streamHeaderTimeout, streamFailoverBudget = 30*time.Second, 90*time.Second
	if got := maxStreamingAttempts(WithStreaming(context.Background())); got != 3 {
		t.Fatalf("30s header / 90s budget → %d attempts, want 3", got)
	}

	// A budget smaller than one header timeout must still allow one attempt,
	// never zero (which would refuse every streaming request).
	streamHeaderTimeout, streamFailoverBudget = 120*time.Second, 30*time.Second
	if got := maxStreamingAttempts(WithStreaming(context.Background())); got != 1 {
		t.Fatalf("over-budget header timeout → %d attempts, want 1", got)
	}
}

func TestDurationFromEnv(t *testing.T) {
	const key = "RAYU_TEST_DURATION_ENV"
	def := 42 * time.Second

	if got := durationFromEnv(key, def); got != def {
		t.Fatalf("unset → %v, want %v", got, def)
	}
	t.Setenv(key, "75s")
	if got := durationFromEnv(key, def); got != 75*time.Second {
		t.Fatalf("\"75s\" → %v, want 75s", got)
	}
	// Garbage and non-positive values must keep the default rather than
	// disabling the bound entirely.
	for _, bad := range []string{"nonsense", "0s", "-5s"} {
		t.Setenv(key, bad)
		if got := durationFromEnv(key, def); got != def {
			t.Fatalf("%q → %v, want the default %v", bad, got, def)
		}
	}
}
