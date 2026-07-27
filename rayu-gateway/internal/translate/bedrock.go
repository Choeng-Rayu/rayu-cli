package translate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

// bedrockAnthropic serves AWS Bedrock's Anthropic surface
// (bedrock-runtime.<region>.amazonaws.com).
//
// WHY THIS IS A SEPARATE FORMAT FROM anthropic_messages
//
// Bedrock speaks Anthropic Messages, but not at an Anthropic-shaped ENDPOINT.
// Three differences make it undeliverable by the passthrough adapter, each
// verified against the live API:
//
//   - The model id is in the URL, not the body:
//     POST /model/{modelId}/invoke  (streaming: /invoke-with-response-stream).
//   - The body must carry `anthropic_version` ("anthropic_version: Field
//     required") and must NOT carry `model` or `stream` ("Extra inputs are not
//     permitted"). Everything else — system, tools, tool_choice, thinking,
//     temperature, top_p, stop_sequences, metadata — is accepted unchanged.
//   - Streaming responses are `application/vnd.amazon.eventstream` frames, not
//     SSE, so the events must be unwrapped and re-emitted (see eventstream.go).
//
// Auth is a Bedrock API key as `Authorization: Bearer` (authScheme `bearer`).
//
// Everything else is shared with every other adapter: the same key rotation and
// failover through proxy.SendWithFailover, and usage parsed into the same buckets
// so billing is identical to a direct Anthropic provider.
type bedrockAnthropic struct{}

func init() { register(bedrockAnthropic{}) }

func (bedrockAnthropic) Format() string { return providercfg.FormatBedrockAnthropic }

// maxUpstreamBody caps a non-streaming response read, so a misbehaving upstream
// cannot make the gateway allocate without bound.
const maxUpstreamBody = 8 << 20 // 8 MiB

// bedrockAPIVersion is the only value Bedrock accepts for anthropic_version on
// the Anthropic surface (an Anthropic-style date, e.g. "2023-06-01", is rejected
// with "Invalid API version").
const bedrockAPIVersion = "bedrock-2023-05-31"

// streamSuffix is what turns the invoke URL into its streaming twin.
const (
	bedrockInvokeSuffix = "/invoke"
	bedrockStreamSuffix = "/invoke-with-response-stream"
)

// bedrockBody rewrites the canonical Anthropic request into what Bedrock accepts:
// inject anthropic_version, drop the fields it refuses. The original map is not
// mutated — the caller may still need it (e.g. for logging or a retry).
func bedrockBody(anthropic map[string]any) ([]byte, error) {
	out := make(map[string]any, len(anthropic)+1)
	for k, v := range anthropic {
		switch k {
		case "model", "stream":
			// Carried by the URL / chosen by the endpoint. Sending either is a 400.
			continue
		}
		out[k] = v
	}
	out["anthropic_version"] = bedrockAPIVersion
	return json.Marshal(out)
}

// bedrockURL builds the per-model invoke URL, streaming or not.
func bedrockURL(route providercfg.Route, upstreamModelID string, stream bool) string {
	url := route.EndpointFor(upstreamModelID)
	if !stream {
		return url
	}
	// Only swap a trailing /invoke: an admin who typed the streaming path already
	// (or a future path shape) is left alone rather than silently rewritten.
	if strings.HasSuffix(url, bedrockInvokeSuffix) {
		return strings.TrimSuffix(url, bedrockInvokeSuffix) + bedrockStreamSuffix
	}
	return url
}

func (bedrockAnthropic) Complete(
	ctx context.Context, req Request,
) (*proxy.Usage, int, []byte, error) {
	body, err := bedrockBody(req.Anthropic)
	if err != nil {
		return nil, 0, nil, err
	}
	url := bedrockURL(req.Route, req.UpstreamModelID, false)
	resp, _, err := proxy.SendWithFailover(ctx, req.Keys, func(apiKey string) (*http.Request, error) {
		return newBedrockReq(ctx, url, apiKey, body)
	}, req.OnKeyFailure)
	if err != nil {
		return nil, 0, nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
	if err != nil {
		return nil, resp.StatusCode, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		// Bedrock reports errors as {"message": "..."} rather than an Anthropic
		// error envelope. Reshape it so the caller's error handling — and the CLI —
		// see the one error format they know.
		return nil, resp.StatusCode, bedrockErrorToAnthropic(respBody), nil
	}
	return proxy.UsageFromAnthropicBody(respBody), resp.StatusCode, respBody, nil
}

func (bedrockAnthropic) Stream(
	ctx context.Context, w http.ResponseWriter, req Request,
) (*proxy.Usage, bool, error) {
	body, err := bedrockBody(req.Anthropic)
	if err != nil {
		return nil, false, err
	}
	url := bedrockURL(req.Route, req.UpstreamModelID, true)
	resp, _, err := proxy.SendWithFailover(ctx, req.Keys, func(apiKey string) (*http.Request, error) {
		return newBedrockReq(ctx, url, apiKey, body)
	}, req.OnKeyFailure)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
		httpx.WriteAnthropicError(w, resp.StatusCode, bedrockErrorMessage(raw))
		return nil, true, fmt.Errorf("bedrock status %d: %s", resp.StatusCode, snippet(raw))
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	// Decode frames → re-emit Anthropic SSE, incrementally: one frame in, one
	// event out, flush. Nothing is buffered, so time-to-first-token is the
	// upstream's, not ours.
	var usage proxy.AnthropicUsageAccumulator
	for {
		frame, ferr := readEventStreamFrame(resp.Body)
		if ferr != nil {
			if errors.Is(ferr, io.EOF) {
				break
			}
			// Mid-stream failure: the client already has bytes, so the stream just
			// ends. The caller logs it and settles billing for what arrived.
			return usage.Usage(), true, ferr
		}
		if frame.ExceptionType != "" {
			// Bedrock signals mid-stream problems (throttling, timeouts) as a frame,
			// not an HTTP status.
			return usage.Usage(), true, fmt.Errorf("bedrock stream error %s: %s",
				frame.ExceptionType, snippet(frame.Payload))
		}
		if frame.EventType != "chunk" {
			continue // ignore metadata frames
		}
		event, cerr := bedrockChunkEvent(frame.Payload)
		if cerr != nil {
			return usage.Usage(), true, cerr
		}
		usage.Observe(event)
		if _, werr := writeSSEEvent(w, event); werr != nil {
			return usage.Usage(), true, werr // client disconnected
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	return usage.Usage(), true, nil
}

// writeSSEEvent emits one Anthropic event as SSE. The `event:` name is required:
// the Anthropic SDK dispatches on it, and a stream of bare `data:` lines would
// parse as nothing.
func writeSSEEvent(w io.Writer, event []byte) (int, error) {
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(event, &head)
	if head.Type == "" {
		head.Type = "message_delta" // never seen in practice; keep the stream valid
	}
	var b bytes.Buffer
	b.WriteString("event: ")
	b.WriteString(head.Type)
	b.WriteString("\ndata: ")
	b.Write(event)
	b.WriteString("\n\n")
	return w.Write(b.Bytes())
}

// newBedrockReq builds the upstream request. Bedrock takes the key as a bearer
// token; the model is already in the URL.
func newBedrockReq(ctx context.Context, url, apiKey string, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	return req, nil
}

// bedrockErrorMessage pulls the human part out of Bedrock's error body, which is
// `{"message": "..."}` rather than an Anthropic error envelope.
func bedrockErrorMessage(raw []byte) string {
	var e struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Message != "" {
		return e.Message
	}
	if s := snippet(raw); s != "" {
		return s
	}
	return "upstream error"
}

// bedrockErrorToAnthropic reshapes a Bedrock error into the Anthropic error
// envelope every other provider returns, so one error path serves all formats.
func bedrockErrorToAnthropic(raw []byte) []byte {
	out, err := json.Marshal(map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    "invalid_request_error",
			"message": bedrockErrorMessage(raw),
		},
	})
	if err != nil {
		return raw
	}
	return out
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}
