package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-orchestrator/internal/obs"
	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// newTestRouter wires the real handlers over an in-memory store, the SSE Hub,
// and the Machine-backed Controller — the same composition main.go uses — so
// the tests exercise the genuine create/cancel/delete/stream paths. A discarding
// logger is installed so the request-log middleware (and its response-writer
// wrapping, which the SSE endpoint must tolerate) is on the path in every test.
func newTestRouter(t *testing.T) (http.Handler, *store.InMemoryStore, *stream.Hub) {
	t.Helper()
	st := store.NewInMemoryStore()
	hub := stream.NewHub(st, stream.WithHeartbeatInterval(20*time.Millisecond))
	r := NewRouter(Deps{
		Store:  st,
		Builds: NewMachineController(st, hub),
		Stream: hub,
		Logger: obs.NewLogger(io.Discard),
	})
	return r, st, hub
}

func do(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		rdr = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rdr)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode response body %q: %v", rec.Body.String(), err)
	}
	return v
}

// TestCreateBuild_201Shape covers the 201 response shape (Req 1.1): a queued
// build with a DNS-safe Build_Id, its resumable stream URL, and a timestamp,
// and that the build is persisted as queued.
func TestCreateBuild_201Shape(t *testing.T) {
	r, st, _ := newTestRouter(t)

	rec := do(t, r, http.MethodPost, "/v1/builds", map[string]any{
		"prompt":  "build a booking system for Cambodia",
		"ownerId": "user_2abc",
	})

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json", ct)
	}

	resp := decodeBody[createBuildResponse](t, rec)
	if resp.Status != string(store.StatusQueued) {
		t.Fatalf("status = %q, want %q", resp.Status, store.StatusQueued)
	}
	if !strings.HasPrefix(resp.BuildID, buildIDPrefix) {
		t.Fatalf("buildId %q missing %q prefix", resp.BuildID, buildIDPrefix)
	}
	if !dnsLabelRe.MatchString(resp.BuildID) {
		t.Fatalf("buildId %q is not a valid DNS label", resp.BuildID)
	}
	if want := "/v1/builds/" + resp.BuildID + "/stream"; resp.StreamURL != want {
		t.Fatalf("streamUrl = %q, want %q", resp.StreamURL, want)
	}
	if resp.CreatedAt.IsZero() {
		t.Fatalf("createdAt is zero")
	}

	// The build must be persisted as queued, owned by the caller-supplied owner.
	b, err := st.GetBuild(context.Background(), resp.BuildID)
	if err != nil {
		t.Fatalf("GetBuild: %v", err)
	}
	if b.Status != store.StatusQueued {
		t.Fatalf("persisted status = %q, want queued", b.Status)
	}
	if b.OwnerID != "user_2abc" {
		t.Fatalf("persisted ownerId = %q, want user_2abc", b.OwnerID)
	}
}

// TestCreateBuild_400EmptyPrompt covers the empty/blank/missing prompt case
// (Req 1.2): 400 with the empty_prompt code AND no Build_Record created.
func TestCreateBuild_400EmptyPrompt(t *testing.T) {
	cases := map[string]map[string]any{
		"blank prompt":   {"prompt": "   \t\n ", "ownerId": "user_empty"},
		"missing prompt": {"ownerId": "user_empty"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			r, st, _ := newTestRouter(t)
			rec := do(t, r, http.MethodPost, "/v1/builds", body)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if code := decodeBody[errorResponse](t, rec).Error.Code; code != codeEmptyPrompt {
				t.Fatalf("error code = %q, want %q", code, codeEmptyPrompt)
			}
			// No record must exist for the owner (Req 1.2).
			if n, _ := st.CountCreatedSince(context.Background(), "user_empty", time.Time{}); n != 0 {
				t.Fatalf("created %d builds on a rejected request, want 0", n)
			}
		})
	}
}

// TestCreateBuild_400MissingOwner covers the missing/blank ownerId case (Req
// 1.2): 400 with the missing_owner code and no record created.
func TestCreateBuild_400MissingOwner(t *testing.T) {
	r, st, _ := newTestRouter(t)
	rec := do(t, r, http.MethodPost, "/v1/builds", map[string]any{
		"prompt":  "build something",
		"ownerId": "   ",
	})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if code := decodeBody[errorResponse](t, rec).Error.Code; code != codeMissingOwner {
		t.Fatalf("error code = %q, want %q", code, codeMissingOwner)
	}
	// A blank owner trims to "", so a leaked record would be counted under "".
	if n, _ := st.CountCreatedSince(context.Background(), "", time.Time{}); n != 0 {
		t.Fatalf("created %d builds on a rejected request, want 0", n)
	}
}

// TestCreateBuild_400InvalidJSON covers a malformed body → 400 invalid_request.
func TestCreateBuild_400InvalidJSON(t *testing.T) {
	r, _, _ := newTestRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/builds", strings.NewReader("{not json"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if code := decodeBody[errorResponse](t, rec).Error.Code; code != codeInvalidRequest {
		t.Fatalf("error code = %q, want %q", code, codeInvalidRequest)
	}
}

// TestGetBuild_404Unknown covers GET for an unknown id (Req 1.4).
func TestGetBuild_404Unknown(t *testing.T) {
	r, _, _ := newTestRouter(t)
	rec := do(t, r, http.MethodGet, "/v1/builds/bld-doesnotexist00/", nil)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if code := decodeBody[errorResponse](t, rec).Error.Code; code != codeNotFound {
		t.Fatalf("error code = %q, want %q", code, codeNotFound)
	}
}

// TestGetBuild_SubdomainURLOnlyWhenLive covers Req 1.3: the subdomain URL is
// returned only while the build is live, even if the field is set in the store.
func TestGetBuild_SubdomainURLOnlyWhenLive(t *testing.T) {
	r, st, _ := newTestRouter(t)
	ctx := context.Background()
	const id = "bld-livecheck0000"
	const url = "https://bld-livecheck0000.apps.example.com"

	if err := st.CreateBuild(ctx, store.Build{ID: id, OwnerID: "user_1", Status: store.StatusQueued, Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	if err := st.SetSubdomainURL(ctx, id, url); err != nil {
		t.Fatalf("SetSubdomainURL: %v", err)
	}

	// Not live yet (subdomain set in store, but status is building): omitted.
	if err := st.SetStatus(ctx, id, store.StatusBuilding); err != nil {
		t.Fatalf("SetStatus building: %v", err)
	}
	got := decodeBody[buildStatusResponse](t, do(t, r, http.MethodGet, "/v1/builds/"+id+"/", nil))
	if got.SubdomainURL != "" {
		t.Fatalf("subdomainUrl = %q while building, want empty/omitted", got.SubdomainURL)
	}

	// Live: present with the stored value.
	if err := st.SetStatus(ctx, id, store.StatusLive); err != nil {
		t.Fatalf("SetStatus live: %v", err)
	}
	got = decodeBody[buildStatusResponse](t, do(t, r, http.MethodGet, "/v1/builds/"+id+"/", nil))
	if got.SubdomainURL != url {
		t.Fatalf("subdomainUrl = %q while live, want %q", got.SubdomainURL, url)
	}
	if got.Status != string(store.StatusLive) {
		t.Fatalf("status = %q, want live", got.Status)
	}
}

// TestCancel_202WhenActive covers Req 1.5: cancel of an active build returns 202
// and drives it to canceled.
func TestCancel_202WhenActive(t *testing.T) {
	r, st, _ := newTestRouter(t)
	id := createQueued(t, r)

	rec := do(t, r, http.MethodPost, "/v1/builds/"+id+"/cancel", nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}

	b, err := st.GetBuild(context.Background(), id)
	if err != nil {
		t.Fatalf("GetBuild: %v", err)
	}
	if b.Status != store.StatusCanceled {
		t.Fatalf("status = %q after cancel, want canceled", b.Status)
	}
}

// TestCancel_409WhenTerminal covers Req 2.5: cancel of a build already in a
// Terminal_Status returns 409 (live counts as terminal).
func TestCancel_409WhenTerminal(t *testing.T) {
	for _, status := range []store.Status{store.StatusFailed, store.StatusCanceled, store.StatusLive, store.StatusTerminated} {
		t.Run(string(status), func(t *testing.T) {
			r, st, _ := newTestRouter(t)
			ctx := context.Background()
			id := "bld-term" + strings.ReplaceAll(string(status), "_", "")
			if err := st.CreateBuild(ctx, store.Build{ID: id, OwnerID: "user_1", Status: status, Prompt: "p"}); err != nil {
				t.Fatalf("CreateBuild: %v", err)
			}

			rec := do(t, r, http.MethodPost, "/v1/builds/"+id+"/cancel", nil)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
			}
			if code := decodeBody[errorResponse](t, rec).Error.Code; code != codeBuildTerminal {
				t.Fatalf("error code = %q, want %q", code, codeBuildTerminal)
			}
			// Status must be unchanged by a rejected cancel.
			if b, _ := st.GetBuild(ctx, id); b.Status != status {
				t.Fatalf("status changed to %q on rejected cancel, want %q", b.Status, status)
			}
		})
	}
}

// TestCancel_404Unknown covers cancel of an unknown id (Req 1.4).
func TestCancel_404Unknown(t *testing.T) {
	r, _, _ := newTestRouter(t)
	rec := do(t, r, http.MethodPost, "/v1/builds/bld-nope000000000/cancel", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestDelete_200Terminates covers Req 1.6: delete of an active build returns 200
// and drives it to terminated.
func TestDelete_200Terminates(t *testing.T) {
	r, st, _ := newTestRouter(t)
	id := createQueued(t, r)

	rec := do(t, r, http.MethodDelete, "/v1/builds/"+id+"/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if b, _ := st.GetBuild(context.Background(), id); b.Status != store.StatusTerminated {
		t.Fatalf("status = %q after delete, want terminated", b.Status)
	}
}

// TestDelete_LiveTerminates covers the live→terminated delete edge (Req 1.6, 19.3).
func TestDelete_LiveTerminates(t *testing.T) {
	r, st, _ := newTestRouter(t)
	ctx := context.Background()
	const id = "bld-livedelete000"
	if err := st.CreateBuild(ctx, store.Build{ID: id, OwnerID: "user_1", Status: store.StatusLive, Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	rec := do(t, r, http.MethodDelete, "/v1/builds/"+id+"/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if b, _ := st.GetBuild(ctx, id); b.Status != store.StatusTerminated {
		t.Fatalf("status = %q after delete of live, want terminated", b.Status)
	}
}

// TestDelete_AlreadyTerminalIsLeftAsIs covers delete of an already-terminal
// build: 200 (idempotent teardown) with the status unchanged, since
// failed/canceled have no edge to terminated.
func TestDelete_AlreadyTerminalIsLeftAsIs(t *testing.T) {
	r, st, _ := newTestRouter(t)
	ctx := context.Background()
	const id = "bld-faileddelete0"
	if err := st.CreateBuild(ctx, store.Build{ID: id, OwnerID: "user_1", Status: store.StatusFailed, Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild: %v", err)
	}
	rec := do(t, r, http.MethodDelete, "/v1/builds/"+id+"/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if b, _ := st.GetBuild(ctx, id); b.Status != store.StatusFailed {
		t.Fatalf("status = %q, want failed (unchanged)", b.Status)
	}
}

// TestDelete_404Unknown covers delete of an unknown id (Req 1.4).
func TestDelete_404Unknown(t *testing.T) {
	r, _, _ := newTestRouter(t)
	rec := do(t, r, http.MethodDelete, "/v1/builds/bld-nope000000000/", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestStream_WiredToHub covers Req 1.7/10.1: the stream route is wired to the
// Hub. A terminal build replays its persisted events and closes (so the request
// returns), proving the SSE endpoint is reachable through the request-log
// middleware's wrapped, flushable writer.
func TestStream_WiredToHub(t *testing.T) {
	r, st, hub := newTestRouter(t)
	ctx := context.Background()
	id := createQueued(t, r)

	if _, err := hub.Emit(ctx, id, stream.KindLog, map[string]any{"message": "hello world"}); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	// Mark terminal directly so ServeSSE replays-then-closes without blocking.
	if err := st.SetStatus(ctx, id, store.StatusFailed); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/builds/"+id+"/stream", nil)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { r.ServeHTTP(rec, req); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not close for a terminal build")
	}

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "hello world") || !strings.Contains(body, `"kind":"log"`) {
		t.Fatalf("stream body missing replayed event: %q", body)
	}
}

// TestStream_404Unknown covers the stream existence check (Req 1.4).
func TestStream_404Unknown(t *testing.T) {
	r, _, _ := newTestRouter(t)
	rec := do(t, r, http.MethodGet, "/v1/builds/bld-nope000000000/stream", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestHealthz_ExemptAndOK covers Req 1.7/15.3: /healthz is served at the root,
// off the (future) auth chain, returning 200.
func TestHealthz_ExemptAndOK(t *testing.T) {
	r, _, _ := newTestRouter(t)
	rec := do(t, r, http.MethodGet, "/healthz", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

// createQueued posts a valid build and returns its id.
func createQueued(t *testing.T, r http.Handler) string {
	t.Helper()
	rec := do(t, r, http.MethodPost, "/v1/builds", map[string]any{
		"prompt":  "build a thing",
		"ownerId": "user_1",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create build: status = %d, body=%s", rec.Code, rec.Body.String())
	}
	return decodeBody[createBuildResponse](t, rec).BuildID
}
