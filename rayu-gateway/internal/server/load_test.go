package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/credits"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// These tests are the load-behaviour contract for the translating adapters. The
// point of translation is that it must NOT change how the gateway behaves under
// concurrency:
//
//   - no goroutine is leaked per request (translation runs on the request's own
//     goroutine), so RAYU_MAX_INFLIGHT stays an accurate concurrency valve;
//   - a stream is relayed INCREMENTALLY — the client sees early tokens before the
//     upstream has finished, so nothing is buffered to completion;
//   - concurrent requests all settle their own billing correctly.

// slowSSEUpstream streams `chunks` text deltas with a pause between them, so a
// buffering adapter would be obvious: the client would see nothing until the end.
func slowSSEUpstream(t *testing.T, chunks int, gap time.Duration) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < chunks; i++ {
			_, _ = io.WriteString(w, fmt.Sprintf(
				`data: {"choices":[{"delta":{"content":"tok%d"},"finish_reason":null}]}`+"\n\n", i))
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(gap)
		}
		_, _ = io.WriteString(w, `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		_, _ = io.WriteString(w, `data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}`+"\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
}

func translatingHarness(t *testing.T, userID int64, upstreamURL string, cfg *config.Config) (http.Handler, *credits.Limiter) {
	t.Helper()
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: userID, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro", CreditsPerPeriod: i64(100000)},
			AllowedModels: []store.HostedModel{
				hostedModel("gpt-oss-120b", openAIChatProviderRow(upstreamURL), "openai/gpt-oss-120b", 1),
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	if cfg == nil {
		return chatHarness(t, fe)
	}
	return chatHarnessCfg(t, fe, cfg)
}

// A translated stream must reach the client as it is produced, not after the
// upstream finishes.
func TestTranslatedStreamIsIncrementalNotBuffered(t *testing.T) {
	const chunks = 5
	const gap = 60 * time.Millisecond
	upstream := slowSSEUpstream(t, chunks, gap)
	defer upstream.Close()

	h, _ := translatingHarness(t, 301, upstream.URL, nil)

	// A real server + client is required: httptest.ResponseRecorder buffers, so it
	// cannot show WHEN bytes were written.
	srv := httptest.NewServer(h)
	defer srv.Close()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		srv.URL+"/anthropic/v1/messages",
		strings.NewReader(`{"model":"gpt-oss-120b","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 301))
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}

	// Read until the first text delta and record when it arrived.
	buf := make([]byte, 4096)
	var seen strings.Builder
	var firstDeltaAt time.Duration
	for firstDeltaAt == 0 {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			seen.Write(buf[:n])
			if strings.Contains(seen.String(), "text_delta") {
				firstDeltaAt = time.Since(start)
			}
		}
		if rerr != nil {
			break
		}
	}
	if firstDeltaAt == 0 {
		t.Fatalf("never received a text_delta; got: %q", seen.String())
	}
	// The upstream takes ~chunks*gap to finish. Arriving well before that proves
	// the adapter forwarded events as they came instead of buffering.
	total := time.Duration(chunks) * gap
	if firstDeltaAt > total/2 {
		t.Fatalf("first token took %v; upstream ran ~%v — the stream looks buffered", firstDeltaAt, total)
	}
	t.Logf("first translated token after %v (upstream total ~%v)", firstDeltaAt, total)
}

// Translation must not spawn goroutines that outlive the request.
//
// Raw "before vs after" counting cannot answer this on its own: the shared HTTP
// transport keeps idle keep-alive connections (each with a read/write goroutine)
// after a burst, which looks like growth but plateaus. A per-request LEAK instead
// grows every round. So this runs TWO identical rounds and requires the second to
// add almost nothing.
func TestTranslatedStreamLeaksNoGoroutines(t *testing.T) {
	upstream := slowSSEUpstream(t, 3, time.Millisecond)
	defer upstream.Close()

	h, _ := translatingHarness(t, 302, upstream.URL, nil)

	send := func() {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(
			`{"model":"gpt-oss-120b","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
		req.Header.Set("Authorization", "Bearer "+accessToken(t, 302))
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	}

	burst := func(n int) {
		var wg sync.WaitGroup
		wg.Add(n)
		for i := 0; i < n; i++ {
			go func() {
				defer wg.Done()
				send()
			}()
		}
		wg.Wait()
		settle()
	}

	const n = 40
	burst(n) // round 1: fills the connection pool
	afterFirst := runtime.NumGoroutine()
	burst(n) // round 2: pool is warm, so only a real leak can add goroutines
	afterSecond := runtime.NumGoroutine()

	growth := afterSecond - afterFirst
	// A per-request leak would add ~n (40) here; a handful of slack covers
	// transport churn.
	if growth > 5 {
		t.Fatalf("goroutines grew by %d on the SECOND burst (%d → %d) — %d streams leaked goroutines",
			growth, afterFirst, afterSecond, n)
	}
	t.Logf("goroutines after burst 1: %d, after burst 2: %d (growth %d across %d more streams)",
		afterFirst, afterSecond, growth, n)
}

// settle gives finished requests a moment to unwind before counting goroutines.
func settle() {
	for i := 0; i < 5; i++ {
		runtime.GC()
		time.Sleep(20 * time.Millisecond)
	}
}

// Concurrent translated streams must each meter their own usage.
func TestConcurrentTranslatedStreamsBillIndependently(t *testing.T) {
	upstream := slowSSEUpstream(t, 2, time.Millisecond)
	defer upstream.Close()

	h, lim := translatingHarness(t, 303, upstream.URL, nil)

	const n = 12
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(
				`{"model":"gpt-oss-120b","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
			req.Header.Set("Authorization", "Bearer "+accessToken(t, 303))
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Errorf("status=%d", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "message_stop") {
				t.Error("stream not closed properly under concurrency")
			}
		}()
	}
	wg.Wait()

	// Each request reports prompt 100 + completion 10 at multiplier 1 → 110
	// billable tokens; n requests must bill EXACTLY n×110 — no lost settlement and
	// no double-charging under concurrency.
	st, err := lim.Status(context.Background(), 303)
	if err != nil {
		t.Fatal(err)
	}
	if want := int64(n * 110); st.UsedPeriod != want {
		t.Fatalf("usedPeriod=%d want %d (%d concurrent translated streams × 110)", st.UsedPeriod, want, n)
	}
	t.Logf("%d concurrent translated streams billed exactly %d billable tokens", n, st.UsedPeriod)
}

// RAYU_MAX_INFLIGHT must still shed correctly on the translated path: the valve
// counts requests, and translation adds no hidden concurrency.
func TestTranslatedPathRespectsInflightLimit(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-release // hold the first request open
		_, _ = io.WriteString(w, `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	defer close(release)

	h, _ := translatingHarness(t, 304, upstream.URL,
		&config.Config{JWTSecret: testSecret, MaxInFlight: 1})

	body := `{"model":"gpt-oss-120b","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`
	started := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+accessToken(t, 304))
		close(started)
		h.ServeHTTP(rec, req)
	}()
	<-started
	time.Sleep(150 * time.Millisecond) // let the first request occupy the slot

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 304))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want 503 (shed at capacity); body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("shed response should carry Retry-After")
	}
	release <- struct{}{}
	<-done
}
