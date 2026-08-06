package stream

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// --- test doubles & helpers -------------------------------------------------

// sseRecorder is an http.ResponseWriter + http.Flusher that captures the stream
// body. It is concurrency-safe so a heartbeat/live test may read the body while
// ServeSSE runs in another goroutine.
type sseRecorder struct {
	mu     sync.Mutex
	hdr    http.Header
	status int
	buf    bytes.Buffer
}

func newSSERecorder() *sseRecorder {
	return &sseRecorder{hdr: make(http.Header), status: http.StatusOK}
}

func (r *sseRecorder) Header() http.Header { return r.hdr }

func (r *sseRecorder) WriteHeader(s int) {
	r.mu.Lock()
	r.status = s
	r.mu.Unlock()
}

func (r *sseRecorder) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.Write(p)
}

func (r *sseRecorder) Flush() {}

func (r *sseRecorder) Status() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.status
}

func (r *sseRecorder) Body() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.String()
}

// sseMessage is one parsed SSE event (a frame carrying id:/data:).
type sseMessage struct {
	id   string
	data string
}

// parseSSE splits a raw SSE body into event messages and counts heartbeat
// comment frames. Frames are separated by a blank line; a frame whose only
// content is a `:` comment is counted as a heartbeat, not a message.
func parseSSE(body string) (msgs []sseMessage, comments int) {
	for _, blk := range strings.Split(body, "\n\n") {
		if strings.TrimSpace(blk) == "" {
			continue
		}
		var msg sseMessage
		hasField := false
		for _, line := range strings.Split(blk, "\n") {
			switch {
			case strings.HasPrefix(line, "id: "):
				msg.id = strings.TrimPrefix(line, "id: ")
				hasField = true
			case strings.HasPrefix(line, "data: "):
				msg.data = strings.TrimPrefix(line, "data: ")
				hasField = true
			case strings.HasPrefix(line, ":"):
				comments++
			}
		}
		if hasField {
			msgs = append(msgs, msg)
		}
	}
	return msgs, comments
}

// tFatalf is the minimal failing interface shared by *testing.T and *rapid.T,
// so the same helpers serve both the unit tests and the property tests.
type tFatalf interface {
	Fatalf(format string, args ...any)
}

func seqsOfMsgs(t tFatalf, msgs []sseMessage) []int64 {
	out := make([]int64, 0, len(msgs))
	for _, m := range msgs {
		n, err := strconv.ParseInt(m.id, 10, 64)
		if err != nil {
			t.Fatalf("non-integer SSE id %q", m.id)
		}
		out = append(out, n)
	}
	return out
}

func wantRange(lo, hi int) []int64 {
	if lo > hi {
		return nil
	}
	out := make([]int64, 0, hi-lo+1)
	for i := lo; i <= hi; i++ {
		out = append(out, int64(i))
	}
	return out
}

func equalInt64s(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// newHubWithBuild creates an InMemoryStore with one build and a Hub, and emits n
// log events (seqs 1..n) into it.
func newHubWithBuild(t tFatalf, buildID string, n int, opts ...Option) (*Hub, *store.InMemoryStore) {
	st := store.NewInMemoryStore()
	h := NewHub(st, opts...)
	ctx := context.Background()
	if err := st.CreateBuild(ctx, store.Build{ID: buildID, OwnerID: "owner", Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	for i := 0; i < n; i++ {
		if _, err := h.Emit(ctx, buildID, KindLog, map[string]any{"i": i + 1}); err != nil {
			t.Fatalf("Emit: %v", err)
		}
	}
	return h, st
}

func newSSEReq(lastEventID int) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/v1/builds/b/stream", nil)
	if lastEventID > 0 {
		req.Header.Set("Last-Event-ID", strconv.Itoa(lastEventID))
	}
	return req
}

// --- tests ------------------------------------------------------------------

// Req 1.4 — a stream request for an unknown build is a 404 before any stream
// headers/status are written.
func TestServeSSEUnknownBuild404(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)
	rec := newSSERecorder()
	h.ServeSSE(rec, newSSEReq(0), "does-not-exist")

	if rec.Status() != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Status())
	}
	if ct := rec.Header().Get("Content-Type"); strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("404 response should not be an event-stream, got Content-Type %q", ct)
	}
}

// Req 10.1, 10.2, 10.6 — an already-terminal build replays every event in
// ascending Sequence_Number order with id:=seq, sets text/event-stream, and
// then closes (the synchronous call returns).
func TestServeSSEAlreadyTerminalReplayThenClose(t *testing.T) {
	h, st := newHubWithBuild(t, "b", 5)
	if err := st.SetStatus(context.Background(), "b", store.StatusTerminated); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}

	rec := newSSERecorder()
	done := make(chan struct{})
	go func() { defer close(done); h.ServeSSE(rec, newSSEReq(0), "b") }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeSSE did not close for an already-terminal build")
	}

	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	msgs, _ := parseSSE(rec.Body())
	got := seqsOfMsgs(t, msgs)
	if !equalInt64s(got, wantRange(1, 5)) {
		t.Fatalf("replayed seqs = %v, want 1..5", got)
	}
}

// Req 10.3 — Last-Event-ID:N replays only events with Seq > N, ascending.
func TestServeSSELastEventIDReplayWindow(t *testing.T) {
	h, st := newHubWithBuild(t, "b", 8)
	if err := st.SetStatus(context.Background(), "b", store.StatusFailed); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}

	rec := newSSERecorder()
	done := make(chan struct{})
	go func() { defer close(done); h.ServeSSE(rec, newSSEReq(3), "b") }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeSSE did not close")
	}

	msgs, _ := parseSSE(rec.Body())
	got := seqsOfMsgs(t, msgs)
	if !equalInt64s(got, wantRange(4, 8)) {
		t.Fatalf("resumed seqs = %v, want 4..8", got)
	}
}

// The data: payload is the full Progress_Event JSON shape with the redacted
// payload intact.
func TestServeSSEDataShape(t *testing.T) {
	st := store.NewInMemoryStore()
	h := NewHub(st)
	ctx := context.Background()
	if err := st.CreateBuild(ctx, store.Build{ID: "b", OwnerID: "o", Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	if _, err := h.Emit(ctx, "b", KindFileChange, map[string]any{"path": "src/app.ts", "tool": "Write"}); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	if err := st.SetStatus(ctx, "b", store.StatusTerminated); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}

	rec := newSSERecorder()
	h.ServeSSE(rec, newSSEReq(0), "b")

	msgs, _ := parseSSE(rec.Body())
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}
	if msgs[0].id != "1" {
		t.Errorf("id = %q, want 1", msgs[0].id)
	}
	var ev struct {
		BuildID string         `json:"buildId"`
		Seq     int64          `json:"seq"`
		Kind    string         `json:"kind"`
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal([]byte(msgs[0].data), &ev); err != nil {
		t.Fatalf("data not valid JSON: %v\n%s", err, msgs[0].data)
	}
	if ev.BuildID != "b" || ev.Seq != 1 || ev.Kind != "file_change" {
		t.Errorf("event header = %+v, want {b,1,file_change}", ev)
	}
	if ev.Payload["path"] != "src/app.ts" || ev.Payload["tool"] != "Write" {
		t.Errorf("payload = %v", ev.Payload)
	}
}

// Req 10.5 — when a build reaches a Terminal_Status while a stream is open, the
// final events are delivered and the stream closes (here via CloseBuild).
func TestServeSSELiveThenTerminalClose(t *testing.T) {
	h, st := newHubWithBuild(t, "b", 0, WithHeartbeatInterval(50*time.Millisecond))
	ctx := context.Background()

	rec := newSSERecorder()
	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	req := newSSEReq(0).WithContext(reqCtx)

	done := make(chan struct{})
	go func() { defer close(done); h.ServeSSE(rec, req, "b") }()

	// Emit a few live events, then drive the build terminal and close.
	for i := 0; i < 4; i++ {
		if _, err := h.Emit(ctx, "b", KindLog, map[string]any{"i": i + 1}); err != nil {
			t.Fatalf("Emit: %v", err)
		}
	}
	if err := st.SetStatus(ctx, "b", store.StatusLive); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	h.CloseBuild("b")

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		cancel()
		<-done
		t.Fatal("ServeSSE did not close after CloseBuild")
	}

	msgs, _ := parseSSE(rec.Body())
	got := seqsOfMsgs(t, msgs)
	if !equalInt64s(got, wantRange(1, 4)) {
		t.Fatalf("live seqs = %v, want 1..4", got)
	}
}

// Req 10.4 — with no events, the stream emits heartbeat comments on the idle
// interval and keeps the connection open until the client disconnects.
func TestServeSSEHeartbeat(t *testing.T) {
	h, _ := newHubWithBuild(t, "b", 0, WithHeartbeatInterval(15*time.Millisecond))

	rec := newSSERecorder()
	reqCtx, cancel := context.WithCancel(context.Background())
	req := newSSEReq(0).WithContext(reqCtx)

	done := make(chan struct{})
	go func() { defer close(done); h.ServeSSE(rec, req, "b") }()

	time.Sleep(120 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeSSE did not return after ctx cancel")
	}

	_, comments := parseSSE(rec.Body())
	if comments == 0 {
		t.Fatalf("expected at least one heartbeat comment, got body:\n%q", rec.Body())
	}
}

// A build that gains events only after the client connected (pure live tail,
// no replay) still delivers them in order.
func TestServeSSEPureLiveTail(t *testing.T) {
	h, st := newHubWithBuild(t, "b", 0, WithHeartbeatInterval(50*time.Millisecond))
	ctx := context.Background()

	rec := newSSERecorder()
	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	req := newSSEReq(0).WithContext(reqCtx)

	done := make(chan struct{})
	go func() { defer close(done); h.ServeSSE(rec, req, "b") }()

	for i := 0; i < 6; i++ {
		if _, err := h.Emit(ctx, "b", KindLog, map[string]any{"i": i + 1}); err != nil {
			t.Fatalf("Emit: %v", err)
		}
	}
	if err := st.SetStatus(ctx, "b", store.StatusTerminated); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	h.CloseBuild("b")

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		cancel()
		<-done
		t.Fatal("ServeSSE did not close")
	}

	msgs, _ := parseSSE(rec.Body())
	if got := seqsOfMsgs(t, msgs); !equalInt64s(got, wantRange(1, 6)) {
		t.Fatalf("live seqs = %v, want 1..6", got)
	}
}
