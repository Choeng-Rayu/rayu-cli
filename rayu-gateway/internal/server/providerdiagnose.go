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
	"net/http"
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
// A provider whose API path does not exist typically serves its single-page app for
// the unknown route WITH HTTP 200, which otherwise looks like a wrong-format answer
// even though the format setting is correct.
//
// Valid JSON is never treated as a page, so an error body that happens to quote some
// markup ("the model <html> is unknown") cannot be mistaken for one.
func looksLikeHTML(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || json.Valid(trimmed) {
		return false
	}
	head := bytes.ToLower(trimmed)
	if len(head) > 512 {
		head = head[:512]
	}
	switch {
	case bytes.HasPrefix(head, []byte("<!doctype html")),
		bytes.HasPrefix(head, []byte("<html")):
		return true
	case bytes.Contains(head, []byte("<head")) && bytes.Contains(head, []byte("<meta")):
		// A fragment served without a doctype (some CDN error pages).
		return true
	}
	return false
}

// htmlMeansWrongURL reports whether an HTML body at this status can only mean "this
// is not an API endpoint". Statuses that carry their own meaning — the credential was
// refused, the caller is throttled, the provider failed — are excluded: those are
// routinely served as HTML by a CDN/WAF/reverse proxy sitting in front of a URL that
// is entirely correct.
func htmlMeansWrongURL(status int) bool {
	switch {
	case status >= 200 && status < 400:
		return true
	case status == http.StatusNotFound, status == http.StatusMethodNotAllowed,
		status == http.StatusGone:
		return true
	}
	return false
}

// detectResponseFormat identifies which wire format a successful response body is
// in, or "" when it matches none.
//
// The discriminators are the fields only that format produces, checked
// most-specific first: Anthropic's markers (a `usage` object, `role`) are the
// loosest, and an OpenAI or GenAI body would otherwise match them — which is how a
// provider configured with the wrong format could PASS its test and then fail for
// every real user.
//
// Fields are inspected INDIVIDUALLY rather than through one typed struct. Providers
// and the gateways in front of them add and reshape fields freely, and with a rigid
// struct a single unexpected type (`"usage":"n/a"`, a numeric `id`, a stray
// top-level `content` string) made the whole body unrecognisable — turning a precise
// diagnosis into a generic one exactly when an admin needs the precise one.
func detectResponseFormat(body []byte) string {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return ""
	}
	switch {
	case isJSONArray(top["choices"]), strings.HasPrefix(jsonString(top["object"]), "chat.completion"):
		return providercfg.FormatOpenAIChat
	case isJSONArray(top["output"]), jsonString(top["object"]) == "response":
		return providercfg.FormatOpenAIResponses
	case isJSONArray(top["candidates"]), len(top["usageMetadata"]) > 0:
		return providercfg.FormatGenAI
	case jsonString(top["type"]) == "message",
		jsonString(top["role"]) == "assistant" && isJSONArray(top["content"]),
		hasAnthropicUsageFields(top["usage"]):
		// Anthropic Messages: `type:"message"`, or an assistant turn with a content
		// BLOCK ARRAY, or a usage object using Anthropic's own token field names.
		return providercfg.FormatAnthropicMessages
	}
	return ""
}

// isJSONArray reports whether a raw value is present and is a JSON array.
func isJSONArray(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '['
}

// jsonString decodes a raw value as a string, or returns "" for anything else —
// including a number or an object, which must not be an error here.
func jsonString(raw json.RawMessage) string {
	var s string
	if len(raw) == 0 || json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// hasAnthropicUsageFields reports whether a usage object carries Anthropic's own
// token field NAMES. Only presence is checked, not the value type: a lax proxy that
// sends `"input_tokens":"3"` is still speaking Anthropic.
func hasAnthropicUsageFields(raw json.RawMessage) bool {
	var usage map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &usage) != nil {
		return false
	}
	for _, k := range []string{"input_tokens", "output_tokens",
		"cache_read_input_tokens", "cache_creation_input_tokens"} {
		if _, ok := usage[k]; ok {
			return true
		}
	}
	return false
}

// sameResponseFamily reports whether two formats produce the same reply shape, so a
// response can never justify recommending a switch between them.
//
// Anthropic Messages and Bedrock's Anthropic surface are the case that matters: the
// bodies are identical, and they differ only in where the model id goes, what the
// request must carry, and how a stream is framed. Telling an admin to swap one for
// the other on the strength of a reply shape would break a working provider.
func sameResponseFamily(a, b string) bool {
	norm := func(f string) string {
		if f == providercfg.FormatBedrockAnthropic {
			return providercfg.FormatAnthropicMessages
		}
		return f
	}
	return norm(a) == norm(b)
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
