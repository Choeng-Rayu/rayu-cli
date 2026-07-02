package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/choeng-rayu/rayu-orchestrator/internal/build"
	"github.com/choeng-rayu/rayu-orchestrator/internal/obs"
	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// buildHandlers serves the /v1/builds surface. It depends on the Store for
// reads, the Controller seam for lifecycle side effects, and the SSEStreamer for
// the progress stream; the logger is optional.
type buildHandlers struct {
	store    store.Store
	builds   Controller
	streamer SSEStreamer
	log      *obs.Logger
}

// --- request / response shapes (all application/json, Req 1.9) ---

// createBuildRequest is the POST /v1/builds body. byok is optional and is never
// persisted (Req 18.1).
type createBuildRequest struct {
	Prompt  string          `json:"prompt"`
	OwnerID string          `json:"ownerId"`
	BYOK    *byokCredential `json:"byok,omitempty"`
}

type byokCredential struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}

func (b *byokCredential) toModel() *build.BYOK {
	if b == nil {
		return nil
	}
	return &build.BYOK{BaseURL: b.BaseURL, APIKey: b.APIKey, Model: b.Model}
}

// createBuildResponse is the 201 body for a created build (Req 1.1).
type createBuildResponse struct {
	BuildID   string    `json:"buildId"`
	Status    string    `json:"status"`
	StreamURL string    `json:"streamUrl"`
	CreatedAt time.Time `json:"createdAt"`
}

// buildStatusResponse is the 200 body for GET /v1/builds/{id} (Req 1.3).
// SubdomainURL is populated only while the build is live; FailureReason is a
// pointer so it serializes as null when unset.
type buildStatusResponse struct {
	BuildID       string    `json:"buildId"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	SubdomainURL  string    `json:"subdomainUrl,omitempty"`
	FailureReason *string   `json:"failureReason,omitempty"`
}

// streamURL builds the resumable SSE URL advertised in the create response.
func streamURL(id string) string { return "/v1/builds/" + id + "/stream" }

// create handles POST /v1/builds (Req 1.1, 1.2). It validates the request
// BEFORE any record is created, so a 400 leaves no Build_Record, then delegates
// persistence + admission to the Controller and returns 201 with the queued
// build's identity and resumable stream URL.
func (h *buildHandlers) create(w http.ResponseWriter, r *http.Request) {
	var req createBuildRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "request body must be valid JSON")
		return
	}

	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		writeError(w, http.StatusBadRequest, codeEmptyPrompt, "prompt must be non-empty")
		return
	}
	ownerID := strings.TrimSpace(req.OwnerID)
	if ownerID == "" {
		writeError(w, http.StatusBadRequest, codeMissingOwner, "ownerId must be non-empty")
		return
	}

	b, err := h.builds.Create(r.Context(), build.CreateRequest{
		Prompt:  prompt,
		OwnerID: ownerID,
		BYOK:    req.BYOK.toModel(),
	})
	if err != nil {
		switch {
		case errors.Is(err, build.ErrConcurrencyQuotaExceeded):
			// Req 17.2 — per-user concurrency quota breach.
			writeError(w, http.StatusTooManyRequests, codeQuotaExceeded, "per-user concurrency quota exceeded")
		case errors.Is(err, build.ErrDailyQuotaExceeded):
			// Req 17.4 — per-user daily quota breach (distinct code from concurrency).
			writeError(w, http.StatusTooManyRequests, codeDailyQuotaExceeded, "per-user daily build quota exceeded")
		default:
			h.logError("create build", err)
			writeError(w, http.StatusInternalServerError, codeInternal, "failed to create build")
		}
		return
	}

	writeJSON(w, http.StatusCreated, createBuildResponse{
		BuildID:   b.ID,
		Status:    string(b.Status),
		StreamURL: streamURL(b.ID),
		CreatedAt: b.CreatedAt,
	})
}

// get handles GET /v1/builds/{id} (Req 1.3, 1.4). It returns the build's status
// and timestamps, including the subdomain URL only when the build is live, and
// 404 for an unknown id.
func (h *buildHandlers) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	b, err := h.store.GetBuild(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, codeNotFound, "build not found")
			return
		}
		h.logError("get build", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "failed to load build")
		return
	}

	resp := buildStatusResponse{
		BuildID:   b.ID,
		Status:    string(b.Status),
		CreatedAt: b.CreatedAt,
		UpdatedAt: b.UpdatedAt,
	}
	// subdomainUrl is present ONLY when the build is live (Req 1.3).
	if b.Status == store.StatusLive {
		resp.SubdomainURL = b.SubdomainURL
	}
	if b.FailureReason != "" {
		reason := b.FailureReason
		resp.FailureReason = &reason
	}
	writeJSON(w, http.StatusOK, resp)
}

// cancel handles POST /v1/builds/{id}/cancel (Req 1.5, 2.5): 202 for an active
// build, 409 if it is already terminal, 404 if unknown.
func (h *buildHandlers) cancel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	switch err := h.builds.Cancel(r.Context(), id); {
	case err == nil:
		writeJSON(w, http.StatusAccepted, map[string]string{
			"buildId": id,
			"status":  h.currentStatus(r, id, string(store.StatusCanceled)),
		})
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, "build not found")
	case errors.Is(err, build.ErrNotCancelable):
		writeError(w, http.StatusConflict, codeBuildTerminal, "build is already in a terminal status")
	default:
		h.logError("cancel build", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "failed to cancel build")
	}
}

// delete handles DELETE /v1/builds/{id} (Req 1.6): 200 with teardown for any
// existing build, 404 if unknown.
func (h *buildHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	switch err := h.builds.Delete(r.Context(), id); {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]string{
			"buildId": id,
			"status":  h.currentStatus(r, id, string(store.StatusTerminated)),
		})
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, "build not found")
	default:
		h.logError("delete build", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "failed to delete build")
	}
}

// stream handles GET /v1/builds/{id}/stream (Req 10) by delegating to the SSE
// streamer, which performs its own existence check (404), replay, live tail,
// heartbeat, and terminal close.
func (h *buildHandlers) stream(w http.ResponseWriter, r *http.Request) {
	if h.streamer == nil {
		writeError(w, http.StatusServiceUnavailable, codeStreamUnavailable, "progress streaming is unavailable")
		return
	}
	h.streamer.ServeSSE(w, r, chi.URLParam(r, "id"))
}

// currentStatus re-reads the build's status for the cancel/delete acknowledgment
// body so the response reflects the real post-action status (e.g. a deleted
// already-failed build remains failed). It falls back to fallback if the read
// fails.
func (h *buildHandlers) currentStatus(r *http.Request, id, fallback string) string {
	if b, err := h.store.GetBuild(r.Context(), id); err == nil {
		return string(b.Status)
	}
	return fallback
}

func (h *buildHandlers) logError(msg string, err error) {
	if h.log != nil {
		h.log.Error(msg, "error", err.Error())
	}
}
