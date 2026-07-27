package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"github.com/choeng-rayu/rayu-gateway/internal/auth"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
	"github.com/choeng-rayu/rayu-gateway/internal/tokencount"
)

// POST /anthropic/v1/messages/count_tokens
//
// # WHY THIS EXISTS
//
// The Anthropic SDK exposes messages.countTokens(), and the CLI uses it to draw
// /context and to decide when to compact. Before this endpoint existed the
// gateway answered 404, and the client then "counted" by sending a REAL
// max_tokens=1 completion per context section — around twenty billed requests
// per /context, which also tripped the per-user concurrency limiter and made the
// command fail outright.
//
// So: counting is METADATA, and metadata must be free.
//   - no credit reserve and no ledger row (nothing is consumed upstream);
//   - no daily-turn burn (a user must not lose a turn to a UI refresh);
//   - no concurrency slot (that budget exists to protect upstreams, and this
//     endpoint never touches one);
//   - no upstream request at all, so it cannot fail because a provider lacks the
//     endpoint — most hosted providers do not have one.
//
// The count is an ESTIMATE (see internal/tokencount). The response is
// deliberately the exact Anthropic shape — {"input_tokens": N} — because the SDK
// parses it; the estimate is advertised out-of-band in a response header so an
// operator can tell where the number came from.
func (s *Server) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	reqID, source, _ := hostedIdentity(r)

	// Entitlement still applies: this is account-scoped information about a hosted
	// model, so a suspended account or an unavailable model gets the same answer
	// here as on the completion path. It is a cache read, not a Redis/DB round
	// trip.
	ent, err := s.ent.Resolve(r.Context(), claims.UserID)
	if err != nil {
		writeEntitlementError(w, err)
		return
	}
	if !ent.Active() {
		httpx.WriteError(w, http.StatusForbidden, "account is "+statusOrUnknown(ent.Status))
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		status, label := classifyBodyReadError(err, r.Context().Err())
		httpx.WriteError(w, status, "request body "+label)
		return
	}

	var head struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &head) != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	// A model the plan cannot use is refused, mirroring the completion path — but
	// the count itself is model-independent, so this is purely an access check.
	var hm *store.HostedModel
	for i := range ent.AllowedModels {
		if ent.AllowedModels[i].Code == head.Model {
			hm = &ent.AllowedModels[i]
			break
		}
	}
	if hm == nil {
		log.Printf("count_tokens reject: user=%d reqid=%s source=%s model=%q not allowed for plan=%s",
			claims.UserID, reqID, source, head.Model, ent.Plan.Code)
		httpx.WriteError(w, http.StatusForbidden, "model not available on your plan: "+head.Model)
		return
	}

	tokens, ok := tokencount.EstimateBody(body)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid Messages request body")
		return
	}

	// Tell operators (and anyone debugging a context readout) that this number is
	// computed here rather than by the upstream tokenizer.
	w.Header().Set("x-rayu-token-count", "estimate")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"input_tokens": tokens})
}
