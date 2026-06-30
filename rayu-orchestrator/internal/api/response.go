package api

import (
	"encoding/json"
	"io"
	"net/http"
)

// maxRequestBodyBytes caps the size of a decoded JSON request body. The
// orchestrator's request bodies are tiny (a prompt + an owner id + optional
// BYOK), so a 1 MiB ceiling is generous while bounding memory from a hostile or
// buggy Caller.
const maxRequestBodyBytes = 1 << 20

// errorResponse is the single machine-readable error envelope every non-2xx
// JSON response uses (Req 1.9): {"error":{"code","message"}}. `code` is a
// stable, programmatic identifier the Caller can branch on; `message` is a
// human-readable explanation.
type errorResponse struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Stable error codes carried in errorResponse.Error.Code. Callers branch on
// these, so they are part of the API contract.
const (
	codeInvalidRequest     = "invalid_request"      // 400 — body is not valid JSON
	codeEmptyPrompt        = "empty_prompt"         // 400 — prompt missing/blank (Req 1.2)
	codeMissingOwner       = "missing_owner"        // 400 — ownerId missing/blank (Req 1.2)
	codeNotFound           = "not_found"            // 404 — unknown build (Req 1.4, 16.3)
	codeBuildTerminal      = "build_terminal"       // 409 — cancel of a terminal build (Req 2.5)
	codeQuotaExceeded      = "quota_exceeded"       // 429 — per-user concurrency quota (Req 17.2)
	codeDailyQuotaExceeded = "daily_quota_exceeded" // 429 — per-user daily quota (Req 17.4)
	codeStreamUnavailable  = "stream_unavailable"   // 503 — progress streaming not wired
	codeInternal           = "internal_error"       // 500 — unexpected server-side failure
)

// writeJSON encodes v as the response body with the given status and the JSON
// content type. Encoding happens after the status is written; a late encode
// error cannot be reported to the client, so callers pass serializable values.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes the standard {error:{code,message}} envelope (Req 1.9) with
// the given HTTP status.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorResponse{Error: errorDetail{Code: code, Message: message}})
}

// decodeJSON reads and decodes the request body into dst, bounding the read at
// maxRequestBodyBytes. A decode failure (including an empty body) is returned to
// the caller, which maps it to a 400 invalid_request.
func decodeJSON(r *http.Request, dst any) error {
	return json.NewDecoder(io.LimitReader(r.Body, maxRequestBodyBytes)).Decode(dst)
}
