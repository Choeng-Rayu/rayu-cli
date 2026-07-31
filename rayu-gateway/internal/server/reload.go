package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/auth"
	"github.com/choeng-rayu/rayu-gateway/internal/configbus"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

// reloadPerAdmin bounds refreshes per admin per minute. Generous — the dashboard
// fires one per save and each is a handful of reads — but not unbounded.
const reloadPerAdmin = 60

// POST /v1/_reload — "the configuration changed; pick it up now."
//
// # WHY THIS EXISTS
//
// Provider routes, models, keys and plan membership are served from an in-memory
// snapshot refreshed every CONFIG_REFRESH_SECONDS. That is what keeps a hosted
// request from touching MySQL, but it also means an admin's save does not affect
// real traffic until the next tick: a model enabled in the dashboard is still
// "not available on your plan" for up to half a minute, which reads as a bug.
//
// The dashboard calls this immediately after a successful write, so the change is
// live before the admin can switch tabs. The replica that answers ALSO announces it
// on the bus (see internal/configbus), so the other replicas refresh too — the
// dashboard's request only ever reaches one of them.
//
// This endpoint carries no data: it cannot say WHAT the configuration is, only that
// it should be re-read from the database. So it is safe to call at any time, from
// anywhere, as often as wanted — the worst case is a redundant read, and concurrent
// calls collapse into one (ConfigReloader).
//
// The periodic refresh remains the safety net. Nothing here is load-bearing for
// correctness; it only removes the delay.
type reloadRequest struct {
	// Reason is what changed, for the operator-facing log line only.
	Reason string `json:"reason"`
	// UserID additionally drops one user's cached entitlement, for changes that
	// affect a single account (plan switch, suspension) rather than the catalog.
	UserID int64 `json:"userId"`
}

type reloadResponse struct {
	OK bool `json:"ok"`
	// Reloaded is whether THIS replica now has fresh configuration.
	Reloaded bool `json:"reloaded"`
	// Broadcast is whether the other replicas were told. False with no error means
	// no bus is configured (single-replica deployment), which is not a problem.
	Broadcast bool   `json:"broadcast"`
	Message   string `json:"message,omitempty"`
}

func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if claims.Role != "admin" && claims.Role != "superadmin" {
		httpx.WriteError(w, http.StatusForbidden, "admin only")
		return
	}

	// A refresh is a few database reads, and an admin could hold a save button. The
	// per-admin cap keeps that from becoming a query loop; single-flight already
	// collapses anything concurrent.
	if ok, wait := s.reloadLim.allow(claims.UserID, time.Now()); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		httpx.WriteError(w, http.StatusTooManyRequests,
			"too many configuration refreshes — the gateway also refreshes on its own timer")
		return
	}

	// The body is optional: an empty POST means "just re-read everything".
	var body reloadRequest
	if raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<10)); err == nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}
	if body.Reason == "" {
		body.Reason = configbus.ReasonManual
	}

	reloadErr, publishErr := s.reloader.Broadcast(r.Context(), configbus.Event{
		Reason: body.Reason,
		UserID: body.UserID,
	})
	if body.UserID != 0 {
		s.ent.Invalidate(body.UserID)
	}

	res := reloadResponse{
		OK:        reloadErr == nil,
		Reloaded:  reloadErr == nil,
		Broadcast: publishErr == nil && s.reloader.publish != nil,
	}
	switch {
	case reloadErr != nil:
		// Report it, but as a 200 with ok=false: the caller asked us to refresh, and
		// "I could not" is the answer to that question, not a malformed request.
		res.Message = "the gateway could not refresh its configuration: " + reloadErr.Error() +
			" — it is still serving its last snapshot and will retry on its timer"
		log.Printf("reload: user=%d reason=%s FAILED: %v", claims.UserID, body.Reason, reloadErr)
	case publishErr != nil:
		res.Message = "refreshed here, but other replicas were not notified: " + publishErr.Error()
		log.Printf("reload: user=%d reason=%s ok (broadcast failed: %v)", claims.UserID, body.Reason, publishErr)
	default:
		log.Printf("reload: user=%d reason=%s userId=%d ok (broadcast=%v)",
			claims.UserID, body.Reason, body.UserID, res.Broadcast)
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}
