package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// ServeSSE serves GET /v1/builds/{id}/stream as a resumable Server-Sent Events
// response (Req 10). It:
//
//   - returns 404 for an unknown build before committing to a stream (Req 1.4);
//   - sets Content-Type: text/event-stream and emits each message with its
//     Sequence_Number in the SSE id: field (Req 10.1, 10.2);
//   - on Last-Event-ID:N replays persisted events with Seq > N ascending and
//     then continues with live events, with no gap and no duplicate across the
//     boundary (Req 10.3);
//   - sends a heartbeat comment after the configured idle interval (Req 10.4);
//   - delivers the final event and then closes when the build is terminal
//     (Req 10.5); and
//   - for a build already in a Terminal_Status at connect, replays all events
//     ascending and then closes (Req 10.6).
//
// Replay and live tail share one ascending store read keyed by a monotonic
// `lastSent` cursor, so the replay→live switch is atomic by construction:
// every event with Seq > Last-Event-ID is delivered exactly once, in order.
func (h *Hub) ServeSSE(w http.ResponseWriter, r *http.Request, buildID string) {
	ctx := r.Context()

	// Existence check first: a 404 must be returned before any stream headers or
	// status are written (Req 1.4). (Per-user authorization, which also maps a
	// non-owner to 404, is layered in the API middleware in a later task.)
	if _, err := h.store.GetBuild(ctx, buildID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "build not found", http.StatusNotFound)
		} else {
			http.Error(w, "stream unavailable", http.StatusInternalServerError)
		}
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	lastEventID := parseLastEventID(r)

	// Subscribe BEFORE the first replay read so no event emitted during replay is
	// missed; the lastSent cursor dedups anything that appears in both replay and
	// the live wake.
	sub := h.subscribe(buildID)
	defer h.unsubscribe(buildID, sub)

	setSSEHeaders(w.Header())
	w.WriteHeader(http.StatusOK)
	flusher.Flush() // push headers so the client opens the stream immediately

	lastSent := lastEventID

	// flushTail delivers every persisted event with Seq > lastSent in ascending
	// order, advancing the cursor. It is the single read path for both the
	// initial replay and the live tail.
	flushTail := func() (sentAny bool, err error) {
		evs, err := h.store.ReadEvents(ctx, buildID, lastSent)
		if err != nil {
			return false, err
		}
		n := 0
		for _, ev := range evs {
			if ev.Seq <= lastSent {
				continue // boundary dedup (defensive; ReadEvents already filters)
			}
			if err := writeSSEEvent(w, ev); err != nil {
				return n > 0, err
			}
			lastSent = ev.Seq
			n++
		}
		if n > 0 {
			flusher.Flush()
		}
		return n > 0, nil
	}

	// Initial replay: Last-Event-ID:N → (N, latest]; no header or a fresh/terminal
	// build → the full history (Req 10.3, 10.6, 9.5).
	if _, err := flushTail(); err != nil {
		return
	}

	// Already in a Terminal_Status at connect → replay is complete, close (Req
	// 10.6). The extra flush catches any event persisted between the replay read
	// and this check.
	if h.isTerminal(ctx, buildID) {
		_, _ = flushTail()
		return
	}

	idle := time.NewTimer(h.heartbeatInterval)
	defer idle.Stop()
	resetIdle := func() {
		if !idle.Stop() {
			select {
			case <-idle.C:
			default:
			}
		}
		idle.Reset(h.heartbeatInterval)
	}

	for {
		select {
		case <-ctx.Done():
			// Client disconnected (or the request was canceled).
			return

		case <-sub.done:
			// The engine signalled the build is fully terminal; flush the final
			// tail and close the stream (Req 10.5).
			_, _ = flushTail()
			return

		case <-sub.wake:
			sentAny, err := flushTail()
			if err != nil {
				return
			}
			if sentAny {
				resetIdle()
			}
			// Safety net: close once the build is terminal even if CloseBuild was
			// never called (e.g. a producer that exited without signalling, or a
			// build already terminal in the store). The engine's CloseBuild remains
			// the race-free primary path.
			if h.isTerminal(ctx, buildID) {
				_, _ = flushTail()
				return
			}

		case <-idle.C:
			// No event for the idle interval → heartbeat to keep the connection
			// alive (Req 10.4).
			if err := writeSSEComment(w); err != nil {
				return
			}
			flusher.Flush()
			idle.Reset(h.heartbeatInterval)
		}
	}
}

func (h *Hub) isTerminal(ctx context.Context, buildID string) bool {
	b, err := h.store.GetBuild(ctx, buildID)
	return err == nil && b.Status.IsTerminal()
}

// setSSEHeaders configures the response for a real-time event stream.
func setSSEHeaders(hd http.Header) {
	hd.Set("Content-Type", "text/event-stream")
	hd.Set("Cache-Control", "no-cache")
	hd.Set("Connection", "keep-alive")
	// Defeat response buffering in intermediary proxies (e.g. nginx) so events
	// flush in real time, matching the gateway's streaming expectations.
	hd.Set("X-Accel-Buffering", "no")
}

// parseLastEventID reads the resume cursor from the SSE Last-Event-ID request
// header (Req 10.3), falling back to a lastEventId query parameter for clients
// that cannot set the header. A missing or malformed value means "from the
// beginning" (0).
func parseLastEventID(r *http.Request) int64 {
	v := r.Header.Get("Last-Event-ID")
	if v == "" {
		v = r.URL.Query().Get("lastEventId")
	}
	if v == "" {
		return 0
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// wireEvent is the SSE data: payload shape. It mirrors ProgressEvent's JSON but
// carries the already-redacted payload as raw bytes so replayed events are
// re-serialized losslessly (and deterministically, since the stored object's
// keys are already in sorted order).
type wireEvent struct {
	BuildID string          `json:"buildId"`
	Seq     int64           `json:"seq"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
	Ts      time.Time       `json:"ts"`
}

// writeSSEEvent writes one persisted event as an SSE message: the id: field is
// the Sequence_Number (Req 10.2) and the data: field is the JSON event.
func writeSSEEvent(w io.Writer, ev store.Event) error {
	payload := ev.Payload
	if len(payload) == 0 {
		payload = json.RawMessage("null")
	}
	data, err := json.Marshal(wireEvent{
		BuildID: ev.BuildID,
		Seq:     ev.Seq,
		Kind:    ev.Kind,
		Payload: payload,
		Ts:      ev.CreatedAt,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", ev.Seq, data)
	return err
}

// writeSSEComment writes an SSE heartbeat comment (Req 10.4).
func writeSSEComment(w io.Writer) error {
	_, err := io.WriteString(w, ":\n\n")
	return err
}
