package translate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

func testRoute(t *testing.T, baseURL, format, auth, path string) providercfg.Route {
	t.Helper()
	r, err := providercfg.Build(providercfg.Row{
		Name: "test", Format: format, BaseURL: baseURL, EndpointPath: path,
		AuthScheme: auth, Enabled: true, KeyCount: 1,
	}, providercfg.Options{
		AllowInsecure: true, // httptest upstreams are http://127.0.0.1
	})
	if err != nil {
		t.Fatalf("build route: %v", err)
	}
	return r
}

// testKeys mirrors what the server hands an adapter: keys in try order, each
// carrying the id used to attribute a failure back to that key.
func testKeys(secrets ...string) []proxy.APIKey {
	out := make([]proxy.APIKey, 0, len(secrets))
	for i, s := range secrets {
		out = append(out, proxy.APIKey{ID: int64(i + 1), Secret: s})
	}
	return out
}

func TestForKnownAndUnknownFormats(t *testing.T) {
	// Every format the provider registry accepts must have an adapter in this
	// build, otherwise an admin could register a provider the gateway cannot serve.
	for _, format := range []string{
		providercfg.FormatAnthropicMessages,
		providercfg.FormatOpenAIChat,
		providercfg.FormatOpenAIResponses,
		providercfg.FormatGenAI,
		providercfg.FormatBedrockAnthropic,
	} {
		a, err := For(format)
		if err != nil {
			t.Errorf("format %s has no adapter: %v", format, err)
			continue
		}
		if a.Format() != format {
			t.Errorf("adapter for %s reports Format()=%q", format, a.Format())
		}
		if !providercfg.KnownFormat(format) {
			t.Errorf("providercfg does not accept %s", format)
		}
	}
	if len(Formats()) != 5 {
		t.Errorf("Formats()=%v want exactly the 5 supported wire formats", Formats())
	}
	_, err := For("grpc_magic")
	var unsupported ErrUnsupportedFormat
	if !errors.As(err, &unsupported) {
		t.Fatalf("For(unknown) err=%v, want ErrUnsupportedFormat", err)
	}
	if unsupported.Format != "grpc_magic" {
		t.Errorf("ErrUnsupportedFormat.Format=%q want grpc_magic", unsupported.Format)
	}
	// Formats() drives boot logging, so it must list what is actually registered.
	found := false
	for _, f := range Formats() {
		if f == providercfg.FormatAnthropicMessages {
			found = true
		}
	}
	if !found {
		t.Errorf("Formats()=%v missing anthropic_messages", Formats())
	}
}

// The passthrough adapter must relay the provider's SSE BYTE-FOR-BYTE: the CLI's
// Anthropic SDK parses that stream natively, so any reshaping is a regression.
func TestAnthropicPassthroughRelaysStreamVerbatim(t *testing.T) {
	const upstreamSSE = "event: message_start\n" +
		`data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":900,"output_tokens":1}}}` + "\n\n" +
		"event: content_block_delta\n" +
		`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}` + "\n\n" +
		"event: message_delta\n" +
		`data: {"type":"message_delta","usage":{"output_tokens":42}}` + "\n\n"

	var gotPath, gotKey, gotModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-api-key")
		b, _ := io.ReadAll(r.Body)
		if strings.Contains(string(b), `"model":"upstream-model-id"`) {
			gotModel = "upstream-model-id"
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, upstreamSSE)
	}))
	defer upstream.Close()

	a, err := For(providercfg.FormatAnthropicMessages)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	usage, wrote, err := a.Stream(context.Background(), rec, Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatAnthropicMessages, providercfg.AuthXAPIKey, "/anthropic/v1/messages"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "upstream-model-id",
		Anthropic: map[string]any{
			"model":      "upstream-model-id",
			"max_tokens": 16,
			"stream":     true,
		},
		Stream: true,
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !wrote {
		t.Fatal("wrote=false, want true once the stream started")
	}
	if gotPath != "/anthropic/v1/messages" {
		t.Errorf("upstream path=%q want /anthropic/v1/messages", gotPath)
	}
	if gotKey != "sk-test" {
		t.Errorf("upstream x-api-key=%q want sk-test", gotKey)
	}
	if gotModel != "upstream-model-id" {
		t.Error("upstream did not receive the provider's own model id")
	}
	if got := rec.Body.String(); got != upstreamSSE {
		t.Errorf("stream not byte-identical:\n got: %q\nwant: %q", got, upstreamSSE)
	}
	// Usage is sniffed off the passing stream and normalized into billing buckets.
	if usage == nil {
		t.Fatal("usage=nil, want metered usage")
	}
	if usage.PromptTokens != 1020 || usage.CompletionTokens != 42 {
		t.Errorf("usage prompt=%d completion=%d want 1020/42", usage.PromptTokens, usage.CompletionTokens)
	}
	if usage.CacheReadTokens() != 900 || usage.FreshInputTokens() != 120 {
		t.Errorf("cacheRead=%d fresh=%d want 900/120", usage.CacheReadTokens(), usage.FreshInputTokens())
	}
}

func TestAnthropicPassthroughCompleteReturnsUpstreamBody(t *testing.T) {
	const body = `{"type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":3}}`
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatAnthropicMessages)
	usage, status, respBody, err := a.Complete(context.Background(), Request{
		// Bearer provider (LongCat / Ollama style) — the key must travel as Bearer.
		Route:           testRoute(t, upstream.URL, providercfg.FormatAnthropicMessages, providercfg.AuthBearer, "/v1/messages"),
		Keys:            testKeys("sk-test"),
		UpstreamModelID: "m",
		Anthropic:       map[string]any{"model": "m", "max_tokens": 8},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("status=%d want 200", status)
	}
	if gotAuth != "Bearer sk-test" {
		t.Errorf("Authorization=%q want 'Bearer sk-test'", gotAuth)
	}
	if string(respBody) != body {
		t.Errorf("body not relayed verbatim: %s", respBody)
	}
	if usage == nil || usage.PromptTokens != 10 || usage.CompletionTokens != 3 {
		t.Errorf("usage=%+v want prompt=10 completion=3", usage)
	}
}

// Multi-key failover must work through the adapter, since every format inherits
// it from proxy.SendWithFailover.
func TestAnthropicPassthroughFailsOverToNextKey(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("x-api-key")
		seen = append(seen, key)
		if key == "sk-exhausted" {
			w.WriteHeader(http.StatusTooManyRequests) // rotatable
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer upstream.Close()

	a, _ := For(providercfg.FormatAnthropicMessages)
	_, status, _, err := a.Complete(context.Background(), Request{
		Route:           testRoute(t, upstream.URL, providercfg.FormatAnthropicMessages, providercfg.AuthXAPIKey, "/anthropic/v1/messages"),
		Keys:            testKeys("sk-exhausted", "sk-good"),
		UpstreamModelID: "m",
		Anthropic:       map[string]any{"model": "m"},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("status=%d want 200 after failover (keys tried: %v)", status, seen)
	}
	if len(seen) != 2 || seen[0] != "sk-exhausted" || seen[1] != "sk-good" {
		t.Errorf("keys tried=%v, want [sk-exhausted sk-good]", seen)
	}
}
