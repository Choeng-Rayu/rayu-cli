package translate

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

// --- upstream request helpers ------------------------------------------------

// newUpstreamReq builds a POST with the provider's auth scheme applied. Adapters
// use this so a provider row's authScheme is honoured identically everywhere.
func newUpstreamReq(ctx context.Context, url, apiKey string, route providercfg.Route, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	switch route.AuthScheme {
	case providercfg.AuthBearer:
		req.Header.Set("Authorization", "Bearer "+apiKey)
	case providercfg.AuthXGoogAPIKey:
		req.Header.Set("x-goog-api-key", apiKey)
	default: // providercfg.AuthXAPIKey
		req.Header.Set("x-api-key", apiKey)
	}
	return req, nil
}

// --- SSE reading -------------------------------------------------------------

// maxSSELineBytes bounds one upstream SSE line. A provider that never emits a
// newline must not be able to grow the gateway's memory without limit; 1 MiB is
// far above any real event (a big tool-call argument chunk is a few KiB).
const maxSSELineBytes = 1 << 20

// scanSSEData reads an SSE body INCREMENTALLY and calls fn for each `data:`
// payload as it arrives, so translation never waits for (or buffers) the whole
// response. Comment/blank/`event:` lines are skipped; the OpenAI-style `[DONE]`
// sentinel stops the scan. fn returning an error stops the scan with that error
// (used when the client disconnects).
func scanSSEData(r io.Reader, fn func(payload []byte) error) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var acc []byte // accumulates a line split across reads
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 {
			if len(acc)+len(chunk) > maxSSELineBytes {
				return fmt.Errorf("upstream SSE line exceeds %d bytes", maxSSELineBytes)
			}
			acc = append(acc, chunk...)
		}
		if err == bufio.ErrBufferFull {
			continue // partial line; keep accumulating
		}
		if len(acc) > 0 && (err == nil || err == io.EOF) {
			line := bytes.TrimRight(acc, "\r\n")
			acc = acc[:0]
			payload, ok := sseData(line)
			if ok {
				if bytes.Equal(payload, []byte("[DONE]")) {
					return nil
				}
				if ferr := fn(payload); ferr != nil {
					return ferr
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// sseData extracts the payload of a `data:` line.
func sseData(line []byte) ([]byte, bool) {
	trimmed := bytes.TrimSpace(line)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil, false
	}
	payload := bytes.TrimSpace(trimmed[len("data:"):])
	if len(payload) == 0 {
		return nil, false
	}
	return payload, true
}

// --- Anthropic SSE writing ---------------------------------------------------

// eventBufs recycles the small buffers used to marshal outgoing events, so a
// high-throughput stream doesn't allocate one per token.
var eventBufs = sync.Pool{New: func() any { return new(bytes.Buffer) }}

// sseWriter writes an Anthropic-format SSE stream to the client, flushing after
// every event so tokens reach the user as they are produced.
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	started bool
}

func newSSEWriter(w http.ResponseWriter) *sseWriter {
	f, _ := w.(http.Flusher)
	return &sseWriter{w: w, flusher: f}
}

// begin sends the SSE response headers. Safe to call more than once.
func (s *sseWriter) begin() {
	if s.started {
		return
	}
	s.started = true
	s.w.Header().Set("Content-Type", "text/event-stream")
	s.w.Header().Set("Cache-Control", "no-cache")
	s.w.Header().Set("Connection", "keep-alive")
	s.w.WriteHeader(http.StatusOK)
	s.flush()
}

func (s *sseWriter) flush() {
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

// event writes one named SSE event whose data is payload as JSON.
func (s *sseWriter) event(name string, payload any) error {
	s.begin()
	buf := eventBufs.Get().(*bytes.Buffer)
	defer func() {
		buf.Reset()
		eventBufs.Put(buf)
	}()
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	buf.WriteString("event: ")
	buf.WriteString(name)
	buf.WriteString("\ndata: ")
	buf.Write(body)
	buf.WriteString("\n\n")
	if _, err := s.w.Write(buf.Bytes()); err != nil {
		return err // client disconnected
	}
	s.flush()
	return nil
}

// --- Anthropic message assembly ---------------------------------------------

// Anthropic content-block kinds an adapter can emit.
const (
	blockText     = "text"
	blockThinking = "thinking"
	blockToolUse  = "tool_use"
)

// anthropicEmitter turns a provider's incremental output into the Anthropic
// Messages event sequence:
//
//	message_start → (content_block_start → content_block_delta* →
//	content_block_stop)* → message_delta → message_stop
//
// It owns block indices and open/close bookkeeping so each adapter only has to
// say "here is more text" / "a tool call started" / "we're done". Every method
// writes through immediately — nothing is held back for the end of the stream.
//
// USAGE NOTE: providers on the OpenAI/GenAI side report token usage only at the
// END of a stream, whereas Anthropic reports input usage in message_start. So
// message_start carries zeros and the FULL usage (input + cache + output) is sent
// on message_delta. Billing is unaffected — the gateway meters from the usage the
// adapter returns, not from its own output stream.
type anthropicEmitter struct {
	sse   *sseWriter
	model string
	msgID string

	started    bool
	blockOpen  bool
	blockKind  string
	blockIndex int
	// toolArgsOpen tracks whether the current tool_use block has begun receiving
	// argument fragments (Anthropic streams them as input_json_delta).
	stopped bool
}

func newAnthropicEmitter(w http.ResponseWriter, model string) *anthropicEmitter {
	return &anthropicEmitter{sse: newSSEWriter(w), model: model, msgID: newMessageID()}
}

// newMessageID mints an Anthropic-looking message id. Clients treat it as opaque;
// the "rayu" marker makes it obvious in logs that the message was assembled by
// the gateway's translation layer rather than passed through.
func newMessageID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "msg_rayu_fallback"
	}
	return "msg_rayu_" + hex.EncodeToString(b[:])
}

// wrote reports whether anything has been sent to the client yet.
func (e *anthropicEmitter) wrote() bool { return e.sse.started }

func (e *anthropicEmitter) start() error {
	if e.started {
		return nil
	}
	e.started = true
	return e.sse.event("message_start", map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id":            e.msgID,
			"type":          "message",
			"role":          "assistant",
			"model":         e.model,
			"content":       []any{},
			"stop_reason":   nil,
			"stop_sequence": nil,
			// Real counts arrive on message_delta (see the type comment).
			"usage": map[string]any{"input_tokens": 0, "output_tokens": 0},
		},
	})
}

// openBlock closes any block of a different kind and opens one of kind k.
func (e *anthropicEmitter) openBlock(k string, block map[string]any) error {
	if err := e.start(); err != nil {
		return err
	}
	if e.blockOpen && e.blockKind == k && k != blockToolUse {
		return nil // text/thinking blocks are appended to
	}
	if err := e.closeBlock(); err != nil {
		return err
	}
	e.blockOpen, e.blockKind = true, k
	return e.sse.event("content_block_start", map[string]any{
		"type":          "content_block_start",
		"index":         e.blockIndex,
		"content_block": block,
	})
}

func (e *anthropicEmitter) closeBlock() error {
	if !e.blockOpen {
		return nil
	}
	e.blockOpen = false
	idx := e.blockIndex
	e.blockIndex++
	return e.sse.event("content_block_stop", map[string]any{
		"type": "content_block_stop", "index": idx,
	})
}

// Text appends assistant text.
func (e *anthropicEmitter) Text(delta string) error {
	if delta == "" {
		return nil
	}
	if err := e.openBlock(blockText, map[string]any{"type": "text", "text": ""}); err != nil {
		return err
	}
	return e.sse.event("content_block_delta", map[string]any{
		"type":  "content_block_delta",
		"index": e.blockIndex,
		"delta": map[string]any{"type": "text_delta", "text": delta},
	})
}

// Thinking appends reasoning text as an Anthropic thinking block, which is how
// the CLI renders a model's chain of thought.
func (e *anthropicEmitter) Thinking(delta string) error {
	if delta == "" {
		return nil
	}
	if err := e.openBlock(blockThinking, map[string]any{
		"type": "thinking", "thinking": "", "signature": "",
	}); err != nil {
		return err
	}
	return e.sse.event("content_block_delta", map[string]any{
		"type":  "content_block_delta",
		"index": e.blockIndex,
		"delta": map[string]any{"type": "thinking_delta", "thinking": delta},
	})
}

// ToolStart opens a tool_use block. Each tool call is its own block, so calling
// this twice in a row correctly produces two parallel tool calls.
func (e *anthropicEmitter) ToolStart(id, name string) error {
	if id == "" {
		id = "toolu_" + newMessageID()
	}
	return e.openBlock(blockToolUse, map[string]any{
		"type": "tool_use", "id": id, "name": name, "input": map[string]any{},
	})
}

// ToolArgs appends a fragment of the current tool call's JSON arguments.
func (e *anthropicEmitter) ToolArgs(fragment string) error {
	if fragment == "" || !e.blockOpen || e.blockKind != blockToolUse {
		return nil
	}
	return e.sse.event("content_block_delta", map[string]any{
		"type":  "content_block_delta",
		"index": e.blockIndex,
		"delta": map[string]any{"type": "input_json_delta", "partial_json": fragment},
	})
}

// ToolSignature attaches a provider-specific opaque signature to the OPEN
// tool_use block, as a `signature_delta`. Gemini 3 requires its
// `thoughtSignature` to be echoed back on later turns; relaying it to the client
// lets the next turn carry it even if this gateway instance no longer remembers
// it. Clients that don't understand the delta simply ignore it.
func (e *anthropicEmitter) ToolSignature(sig string) error {
	if sig == "" || !e.blockOpen || e.blockKind != blockToolUse {
		return nil
	}
	return e.sse.event("content_block_delta", map[string]any{
		"type":  "content_block_delta",
		"index": e.blockIndex,
		"delta": map[string]any{"type": "signature_delta", "signature": sig},
	})
}

// Finish closes the stream: any open block, then message_delta (stop reason +
// the authoritative usage) and message_stop.
func (e *anthropicEmitter) Finish(stopReason string, u *proxy.Usage) error {
	if e.stopped {
		return nil
	}
	e.stopped = true
	if err := e.start(); err != nil {
		return err
	}
	if err := e.closeBlock(); err != nil {
		return err
	}
	if stopReason == "" {
		stopReason = "end_turn"
	}
	if err := e.sse.event("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil},
		"usage": anthropicUsagePayload(u),
	}); err != nil {
		return err
	}
	return e.sse.event("message_stop", map[string]any{"type": "message_stop"})
}

// Error reports a mid-stream provider failure in Anthropic's streaming error
// shape, so a client that has already started receiving events learns the turn
// failed instead of seeing a silently truncated message.
func (e *anthropicEmitter) Error(message string) error {
	return e.sse.event("error", map[string]any{
		"type":  "error",
		"error": map[string]any{"type": "api_error", "message": message},
	})
}

// anthropicUsagePayload renders normalized usage in Anthropic's field names.
func anthropicUsagePayload(u *proxy.Usage) map[string]any {
	if u == nil {
		return map[string]any{"input_tokens": 0, "output_tokens": 0}
	}
	return map[string]any{
		"input_tokens":                u.FreshInputTokens(),
		"output_tokens":               u.CompletionTokens,
		"cache_read_input_tokens":     u.CacheReadTokens(),
		"cache_creation_input_tokens": 0,
	}
}

// anthropicMessageJSON assembles a non-streaming Anthropic Messages response from
// translated content blocks.
func anthropicMessageJSON(model, stopReason string, blocks []map[string]any, u *proxy.Usage) ([]byte, error) {
	if blocks == nil {
		blocks = []map[string]any{}
	}
	if stopReason == "" {
		stopReason = "end_turn"
	}
	return json.Marshal(map[string]any{
		"id":            newMessageID(),
		"type":          "message",
		"role":          "assistant",
		"model":         model,
		"content":       blocks,
		"stop_reason":   stopReason,
		"stop_sequence": nil,
		"usage":         anthropicUsagePayload(u),
	})
}
