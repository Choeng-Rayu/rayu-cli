// Diagnosing a NEW provider: which wire format did it actually answer in, and is
// this even an API endpoint?
//
// # WHAT A FORMAT DOES AND DOES NOT DETERMINE
//
// A format describes the REQUEST AND RESPONSE BODY — Anthropic Messages, OpenAI
// Chat Completions, OpenAI Responses, Google GenAI. It says nothing about the URL.
// Providers serve the same format at whatever path they like (/anthropic/v1/messages,
// /v1/messages, /relay/claude, /api/v3/chat …), so the base URL and endpoint path
// are ADMIN INPUT, used verbatim for routing, and this package must never treat a
// path as wrong merely because it is unfamiliar. The only place a format-derived
// path is ever used is providercfg.DefaultEndpointPath, as a fallback when the admin
// leaves the field blank.
//
// So everything here is derived from the RESPONSE the upstream actually sent, plus
// what the admin typed. Nothing keys off a vendor, a hostname, or an expected path.
package server

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
)

// authHint names the credential header a format normally uses, so an admin who
// picked the wrong one has something concrete to compare against. Unlike a URL, the
// auth scheme is a closed set in the schema (bearer / x_api_key / x_goog_api_key),
// and which one a format expects is a property of the API, not of the provider.
func authHint(format string) string {
	switch format {
	case providercfg.FormatAnthropicMessages:
		return "Anthropic-compatible APIs usually authenticate with x-api-key; " +
			"gateways in front of them often want bearer instead."
	case providercfg.FormatOpenAIChat, providercfg.FormatOpenAIResponses:
		return "OpenAI-compatible APIs authenticate with bearer (Authorization: Bearer <key>)."
	case providercfg.FormatGenAI:
		return "Google GenAI authenticates with x_goog_api_key."
	case providercfg.FormatBedrockAnthropic:
		return "Bedrock authenticates with bearer, using an AWS bearer token."
	default:
		return ""
	}
}

// looksLikeHTML reports whether a body is a web page rather than an API response.
// A provider whose API path is misspelled typically serves its single-page app for
// the unknown route WITH HTTP 200, which otherwise looks like a wrong-format answer
// even though the format setting is correct.
func looksLikeHTML(body []byte) bool {
	head := bytes.ToLower(bytes.TrimSpace(body))
	if len(head) > 512 {
		head = head[:512]
	}
	return bytes.HasPrefix(head, []byte("<!doctype html")) ||
		bytes.HasPrefix(head, []byte("<html")) ||
		bytes.HasPrefix(head, []byte("<?xml")) && bytes.Contains(head, []byte("<html")) ||
		bytes.Contains(head, []byte("<head>")) && bytes.Contains(head, []byte("<meta"))
}

// detectResponseFormat identifies which wire format a successful response body is
// in, or "" when it matches none.
//
// The discriminators are the fields only that format produces, checked
// most-specific first: Anthropic's markers (a `usage` object, `role`) are the
// loosest, and an OpenAI or GenAI body would otherwise match them — which is how a
// provider configured with the wrong format could PASS its test and then fail for
// every real user.
func detectResponseFormat(body []byte) string {
	var probe struct {
		Object     string            `json:"object"`
		Choices    []json.RawMessage `json:"choices"`
		Output     []json.RawMessage `json:"output"`
		Candidates []json.RawMessage `json:"candidates"`
		UsageMeta  json.RawMessage   `json:"usageMetadata"`
		Type       string            `json:"type"`
		Role       string            `json:"role"`
		Content    []json.RawMessage `json:"content"`
		Usage      *struct {
			InputTokens  *int `json:"input_tokens"`
			OutputTokens *int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return ""
	}
	switch {
	case probe.Choices != nil || strings.HasPrefix(probe.Object, "chat.completion"):
		return providercfg.FormatOpenAIChat
	case probe.Output != nil || probe.Object == "response":
		return providercfg.FormatOpenAIResponses
	case probe.Candidates != nil || len(probe.UsageMeta) > 0:
		return providercfg.FormatGenAI
	case probe.Type == "message",
		probe.Role == "assistant" && probe.Content != nil,
		probe.Usage != nil && (probe.Usage.InputTokens != nil || probe.Usage.OutputTokens != nil):
		// Anthropic Messages: `type:"message"`, or an assistant turn with a content
		// BLOCK ARRAY, or a usage object using Anthropic's own token field names.
		return providercfg.FormatAnthropicMessages
	}
	return ""
}

// looksLikeAnthropicMessage reports whether a 200 body is the Anthropic Messages
// shape the gateway hands back to the CLI. Every adapter's Complete translates into
// that shape, so this is the pass/fail check for every format.
func looksLikeAnthropicMessage(body []byte) bool {
	return detectResponseFormat(body) == providercfg.FormatAnthropicMessages
}

// formatLabel is the format's admin-facing name, for messages that recommend one.
func formatLabel(format string) string {
	if format == "" {
		return "an unrecognised format"
	}
	return format
}

// describeConfiguredEndpoint states what the gateway actually called, and whether
// that path came from the admin or from the blank-field fallback.
//
// It deliberately does NOT judge the path. Any path is legitimate — the provider
// decides where it serves its API — so the useful facts are the exact URL that was
// used and, when the field was left blank, that a default was substituted (which is
// the one case where the admin may not know what was sent).
func describeConfiguredEndpoint(route providercfg.Route) string {
	full := route.Endpoint()
	if strings.TrimSpace(route.EndpointPath) == "" {
		def := providercfg.DefaultEndpointPath(route.Format)
		if def == "" {
			return "The gateway called " + full + "."
		}
		return "The endpoint path is blank, so the gateway used the fallback for " +
			formatLabel(route.Format) + " (" + def + ") and called " + full +
			". If this provider serves its API at a different path, set the endpoint path " +
			"explicitly to whatever its own documentation says — any path is fine."
	}
	return "The gateway called exactly what is configured: " + full +
		". The base URL and endpoint path are used verbatim, so compare them with the " +
		"provider's own documentation."
}
