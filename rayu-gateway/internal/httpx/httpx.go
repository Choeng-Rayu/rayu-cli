// Package httpx provides small JSON response helpers shared across handlers.
package httpx

import (
	"encoding/json"
	"net/http"
)

// WriteJSON writes v as a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError writes an OpenAI-compatible error envelope so the CLI's OpenAI
// adapter surfaces a sensible message.
func WriteError(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    errType(status),
		},
	})
}

func errType(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return "authentication_error"
	case http.StatusForbidden:
		return "permission_error"
	case http.StatusTooManyRequests:
		return "rate_limit_exceeded"
	case http.StatusBadRequest:
		return "invalid_request_error"
	default:
		return "api_error"
	}
}
