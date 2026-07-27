package translate

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
)

// Bedrock is the one Anthropic-speaking provider that cannot use the passthrough
// adapter, and every difference below was verified against the live API. These
// tests pin them, because each one fails with a confusing error if it regresses:
// a stray `model` field is "Extra inputs are not permitted", a missing
// anthropic_version is "Field required", and the wrong URL is "model does not
// exist" for every id.

func bedrockRoute(t *testing.T, baseURL string) providercfg.Route {
	t.Helper()
	r, err := providercfg.Build(providercfg.Row{
		Name: "aws", Format: providercfg.FormatBedrockAnthropic, BaseURL: baseURL,
		AuthScheme: providercfg.AuthBearer, Enabled: true, KeyCount: 1,
	}, providercfg.Options{AllowInsecure: true})
	if err != nil {
		t.Fatalf("build route: %v", err)
	}
	return r
}

func TestBedrockPutsTheModelInTheURLNotTheBody(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = io.WriteString(w, `{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],
			"usage":{"input_tokens":8,"output_tokens":2}}`)
	}))
	defer srv.Close()

	a, err := For(providercfg.FormatBedrockAnthropic)
	if err != nil {
		t.Fatal(err)
	}
	usage, status, body, err := a.Complete(context.Background(), Request{
		Route:           bedrockRoute(t, srv.URL),
		Keys:            testKeys("bedrock-key"),
		UpstreamModelID: "us.anthropic.claude-sonnet-4-6",
		Anthropic: map[string]any{
			"model":      "us.anthropic.claude-sonnet-4-6",
			"stream":     false,
			"max_tokens": 1,
			"system":     "be brief",
			"messages":   []any{map[string]any{"role": "user", "content": "hi"}},
		},
	})
	if err != nil || status != http.StatusOK {
		t.Fatalf("status=%d err=%v body=%s", status, err, body)
	}

	if want := "/model/us.anthropic.claude-sonnet-4-6/invoke"; gotPath != want {
		t.Errorf("path=%q, want %q — Bedrock takes the model in the URL", gotPath, want)
	}
	if gotAuth != "Bearer bedrock-key" {
		t.Errorf("Authorization=%q, want a bearer token", gotAuth)
	}
	// The two fields Bedrock rejects outright.
	if _, present := gotBody["model"]; present {
		t.Error(`body carried "model" — Bedrock answers 400 "Extra inputs are not permitted"`)
	}
	if _, present := gotBody["stream"]; present {
		t.Error(`body carried "stream" — Bedrock answers 400 "Extra inputs are not permitted"`)
	}
	// The one field it requires.
	if got := gotBody["anthropic_version"]; got != "bedrock-2023-05-31" {
		t.Errorf("anthropic_version=%v, want bedrock-2023-05-31", got)
	}
	// Everything else must survive untouched.
	if gotBody["system"] != "be brief" {
		t.Errorf("system was dropped: %v", gotBody["system"])
	}
	if usage == nil || usage.PromptTokens != 8 || usage.CompletionTokens != 2 {
		t.Fatalf("usage=%+v, want it parsed for billing", usage)
	}
}

// A model id with characters that must not create new path segments.
func TestBedrockEscapesTheModelIDInTheURL(t *testing.T) {
	route := bedrockRoute(t, "https://bedrock-runtime.us-east-1.amazonaws.com")
	got := bedrockURL(route, "anthropic.claude-3-haiku-20240307-v1:0", false)
	want := "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1:0/invoke"
	if got != want {
		t.Errorf("url=%q, want %q", got, want)
	}
	if strings.Contains(bedrockURL(route, "evil/../../admin", false), "/../") {
		t.Error("a model id was able to traverse the path")
	}
}

func TestBedrockUsesTheStreamingURLWhenStreaming(t *testing.T) {
	route := bedrockRoute(t, "https://bedrock-runtime.us-east-1.amazonaws.com")
	if got, want := bedrockURL(route, "m", true),
		"https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke-with-response-stream"; got != want {
		t.Errorf("streaming url=%q, want %q", got, want)
	}
}

// frame builds one AWS event-stream frame the way Bedrock does. headers are
// passed through verbatim so a test can build both a normal chunk and the
// exception shape (`:message-type: exception`).
func frame(t *testing.T, hdrs map[string]string, payload []byte) []byte {
	t.Helper()
	var headers bytes.Buffer
	writeHeader := func(name, value string) {
		headers.WriteByte(byte(len(name)))
		headers.WriteString(name)
		headers.WriteByte(headerTypeString)
		_ = binary.Write(&headers, binary.BigEndian, uint16(len(value)))
		headers.WriteString(value)
	}
	for name, value := range hdrs {
		writeHeader(name, value)
	}

	total := uint32(eventStreamPreludeLen + headers.Len() + len(payload) + eventStreamCRCLen)
	var out bytes.Buffer
	_ = binary.Write(&out, binary.BigEndian, total)
	_ = binary.Write(&out, binary.BigEndian, uint32(headers.Len()))
	_ = binary.Write(&out, binary.BigEndian, uint32(0)) // prelude CRC (not verified)
	out.Write(headers.Bytes())
	out.Write(payload)
	_ = binary.Write(&out, binary.BigEndian, uint32(0)) // message CRC (not verified)
	return out.Bytes()
}

// chunk wraps an Anthropic event the way Bedrock does: base64 inside {"bytes":…}.
func chunk(t *testing.T, event string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"bytes": base64.StdEncoding.EncodeToString([]byte(event)),
		"p":     "abc",
	})
	if err != nil {
		t.Fatal(err)
	}
	return frame(t, map[string]string{
		":event-type":   "chunk",
		":content-type": "application/json",
		":message-type": "event",
	}, payload)
}

// The CLI only understands Anthropic SSE, so the event-stream frames must come
// out as `event:`/`data:` pairs — with usage still captured for billing.
func TestBedrockStreamBecomesAnthropicSSE(t *testing.T) {
	events := []string{
		`{"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":11,"cache_read_input_tokens":4,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
		`{"type":"message_stop"}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
		for _, e := range events {
			_, _ = w.Write(chunk(t, e))
		}
	}))
	defer srv.Close()

	a, _ := For(providercfg.FormatBedrockAnthropic)
	rec := httptest.NewRecorder()
	usage, wrote, err := a.Stream(context.Background(), rec, Request{
		Route:           bedrockRoute(t, srv.URL),
		Keys:            testKeys("k"),
		UpstreamModelID: "us.anthropic.claude-sonnet-4-6",
		Anthropic:       map[string]any{"model": "x", "max_tokens": 16, "stream": true},
		Stream:          true,
	})
	if err != nil || !wrote {
		t.Fatalf("stream err=%v wrote=%v", err, wrote)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type=%q, want text/event-stream", ct)
	}
	out := rec.Body.String()
	// The SDK dispatches on the event NAME, so a bare data: stream is useless.
	for _, want := range []string{
		"event: message_start", "event: content_block_delta", "event: message_delta", "event: message_stop",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stream is missing %q\n%s", want, out)
		}
	}
	if !strings.Contains(out, `"text":"hello"`) {
		t.Errorf("the model's text never reached the client:\n%s", out)
	}
	// Billing must be identical to a direct Anthropic provider: fresh input +
	// cache read counted, final cumulative output taken from message_delta.
	if usage == nil {
		t.Fatal("no usage captured — the request would be billed as zero")
	}
	if usage.PromptTokens != 15 || usage.CompletionTokens != 7 || usage.PromptCacheHitTokens != 4 {
		t.Fatalf("usage=%+v, want prompt 15 (11 fresh + 4 cached), output 7", usage)
	}
}

// Bedrock reports mid-stream trouble as a FRAME, not an HTTP status, so it has to
// end the stream rather than look like a clean finish.
func TestBedrockStreamSurfacesAnExceptionFrame(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(chunk(t, `{"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}`))
		// Exactly how Bedrock reports throttling mid-stream.
		_, _ = w.Write(frame(t, map[string]string{
			":message-type":   "exception",
			":exception-type": "throttlingException",
			":content-type":   "application/json",
		}, []byte(`{"message":"slow down"}`)))
	}))
	defer srv.Close()

	a, _ := For(providercfg.FormatBedrockAnthropic)
	rec := httptest.NewRecorder()
	usage, wrote, err := a.Stream(context.Background(), rec, Request{
		Route: bedrockRoute(t, srv.URL), Keys: testKeys("k"),
		UpstreamModelID: "m", Anthropic: map[string]any{"max_tokens": 8}, Stream: true,
	})
	if err == nil {
		t.Fatal("an exception frame was treated as a clean stream")
	}
	if !wrote {
		t.Error("wrote=false, but events had already been sent")
	}
	// Whatever arrived before the failure must still be billable.
	if usage == nil || usage.PromptTokens != 5 {
		t.Errorf("usage=%+v, want the tokens consumed before the error", usage)
	}
}

// Bedrock's error shape is {"message": …}; the CLI only understands Anthropic's
// error envelope.
func TestBedrockErrorsAreReshapedForTheClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"message":"Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand throughput isn't supported."}`)
	}))
	defer srv.Close()

	a, _ := For(providercfg.FormatBedrockAnthropic)
	_, status, body, err := a.Complete(context.Background(), Request{
		Route: bedrockRoute(t, srv.URL), Keys: testKeys("k"),
		UpstreamModelID: "anthropic.claude-sonnet-4-6",
		Anthropic:       map[string]any{"max_tokens": 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d, want the upstream 400 preserved", status)
	}
	var out struct {
		Type  string `json:"type"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &out) != nil || out.Type != "error" {
		t.Fatalf("body is not an Anthropic error envelope: %s", body)
	}
	if !strings.Contains(out.Error.Message, "on-demand throughput") {
		t.Errorf("the real reason was lost: %q", out.Error.Message)
	}
}

// A truncated frame must fail rather than be silently accepted as a short stream.
func TestEventStreamRejectsATruncatedFrame(t *testing.T) {
	full := chunk(t, `{"type":"message_stop"}`)
	if _, err := readEventStreamFrame(bytes.NewReader(full[:len(full)-6])); err == nil {
		t.Fatal("a truncated frame was accepted")
	}
	// …and a complete one still reads.
	f, err := readEventStreamFrame(bytes.NewReader(full))
	if err != nil {
		t.Fatalf("valid frame rejected: %v", err)
	}
	if f.EventType != "chunk" {
		t.Errorf("event type=%q, want chunk", f.EventType)
	}
}
