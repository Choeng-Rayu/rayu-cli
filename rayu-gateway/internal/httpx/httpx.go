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

// ProviderUnavailableType is the stable error `type` the CLI matches to render a
// clean, customer-facing "AI provider temporarily unavailable" message for
// rayu-hosted models — INSTEAD of leaking the upstream provider's raw error body
// (e.g. an Ollama "requires a subscription … ollama.com/upgrade" 403). Kept in
// sync with the CLI's isRayuHostedProviderUnavailable() detector.
const ProviderUnavailableType = "provider_unavailable"

// ProviderUnavailableMessage is an upstream-agnostic, customer-safe fallback
// message for the rayu-hosted path. The CLI replaces it with its own localized
// guidance ("try a smaller model or try again later"), but this is what any
// other client — or a log — sees: never the upstream provider's raw body.
const ProviderUnavailableMessage = "The AI provider for this model is temporarily unavailable. Try another (smaller) model or try again later."

// WriteProviderUnavailable writes a clean, upstream-agnostic error for the
// rayu-hosted path so a customer never sees the upstream provider's raw body.
// status defaults to 502 (Bad Gateway) when <= 0. The stable `type` lets the CLI
// recognize this as "Rayu's own provider is unavailable" (as opposed to the
// customer's plan/credit limit, which is a 429 with a `reason`).
func WriteProviderUnavailable(w http.ResponseWriter, status int) {
	if status <= 0 {
		status = http.StatusBadGateway
	}
	WriteJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": ProviderUnavailableMessage,
			"type":    ProviderUnavailableType,
		},
	})
}

// WriteAnthropicError writes a NATIVE Anthropic-format error envelope
// ({"type":"error","error":{"type","message"}}) so the CLI's Anthropic client
// (the rayu-hosted path) surfaces `msg` verbatim. Used to relay a client-fixable
// upstream request error (e.g. a 400 "this model does not support image input")
// with its REAL status, instead of the sanitized provider_unavailable 502 —
// which the SDK would retry and Cloudflare would render as a generic bad
// gateway. The stable per-status `type` matches what the Anthropic SDK expects.
func WriteAnthropicError(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    errType(status),
			"message": msg,
		},
	})
}

// Stable machine codes for capability rejections. The CLI matches on these
// rather than parsing prose, so it can warn the user and offer to switch models
// ("this model can't read images") without depending on wording. They travel as
// `error.rayu_code` alongside the normal Anthropic error envelope.
const (
	// CodeNoImageSupport: the request contains image content but the selected
	// model's supportsImage flag is false.
	CodeNoImageSupport = "model_no_image_support"
	// CodeNoThinkingSupport: the request asks for extended thinking but the
	// selected model's supportsReasoning flag is false.
	CodeNoThinkingSupport = "model_no_thinking_support"
)

// WriteCapabilityError writes an Anthropic-format 400 carrying a stable
// `rayu_code`, for a request the selected model cannot serve (image input or
// extended thinking). 400 is deliberate: this is a client-fixable, PERMANENT
// condition — retrying the same request can never succeed, but changing model
// (or dropping the attachment) will. It is raised BEFORE any credit is charged.
func WriteCapabilityError(w http.ResponseWriter, code, msg string) {
	WriteJSON(w, http.StatusBadRequest, map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":      errType(http.StatusBadRequest),
			"message":   msg,
			"rayu_code": code,
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
