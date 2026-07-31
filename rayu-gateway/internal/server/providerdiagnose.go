package server

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
)

// Diagnosing a NEW provider: which wire format did it actually answer in, is this
// even an API endpoint, and what should the endpoint path and auth scheme be?
//
// WHY THIS IS FORMAT-DRIVEN AND NOT PROVIDER-DRIVEN
//
// Any provider can appear behind any of the supported formats, so nothing here
// keys off a vendor, a hostname or a model name. Every answer is derived from the
// FORMAT the admin selected and from the shape of what the upstream actually sent
// back. A new provider that speaks one of these formats is therefore diagnosable on
// day one, with no code change.

// canonicalPaths are the endpoint paths a format is normally served at. The first
// is the default used when an admin leaves the override blank
// (providercfg.DefaultEndpointPath); the rest are legitimate alternatives seen in
// the wild, so they must not be reported as mistakes.
//
// genai is absent on purpose: its URL embeds the model id and the streaming mode,
// so its adapter builds the path and an admin override does not apply.
func canonicalPaths(format string) []string {
	switch format {
	case providercfg.FormatAnthropicMessages:
		// "/anthropic/v1/messages" is the common compatibility mount (DeepSeek,
		// LongCat, most gateways); "/v1/messages" is first-party Anthropic's own.
		return []string{"/anthropic/v1/messages", "/v1/messages"}
	case providercfg.FormatOpenAIChat:
		return []string{"/v1/chat/completions", "/chat/completions"}
	case providercfg.FormatOpenAIResponses:
		return []string{"/v1/responses", "/responses"}
	case providercfg.FormatBedrockAnthropic:
		return []string{providercfg.DefaultEndpointPath(format)}
	default:
		return nil
	}
}

// authHint names the credential header a format normally uses, so an admin who
// picked the wrong one has something concrete to compare against.
func authHint(format string) string {
	switch format {
	case providercfg.FormatAnthropicMessages:
		return "Anthropic-compatible providers usually want the x-api-key scheme; " +
			"some gateways in front of them want bearer instead."
	case providercfg.FormatOpenAIChat, providercfg.FormatOpenAIResponses:
		return "OpenAI-compatible providers want the bearer scheme (Authorization: Bearer <key>)."
	case providercfg.FormatGenAI:
		return "Google GenAI wants the x_goog_api_key scheme."
	case providercfg.FormatBedrockAnthropic:
		return "Bedrock wants the bearer scheme with an AWS bearer token."
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

// suggestEndpointPath tells the admin what the endpoint path for their chosen
// format should look like, when the configured one is not a known-good value.
//
// Returns "" when the path is already canonical (or when the format has no fixed
// path), so a correct configuration is never second-guessed — a suggestion that
// fires on healthy input is noise, and noise gets ignored.
func suggestEndpointPath(format, configured string) string {
	paths := canonicalPaths(format)
	if len(paths) == 0 {
		return ""
	}
	trimmed := strings.TrimRight(strings.TrimSpace(configured), "/")
	if trimmed == "" {
		// Blank means the format default is in use, which is by definition correct.
		return ""
	}
	for _, p := range paths {
		if strings.EqualFold(trimmed, p) {
			return ""
		}
	}

	// Offer the closest known-good path first, then every alternative, so the admin
	// can both fix a typo and see what else is legitimate.
	best, bestDist := paths[0], 1<<31-1
	for _, p := range paths {
		if d := editDistance(strings.ToLower(trimmed), strings.ToLower(p)); d < bestDist {
			best, bestDist = p, d
		}
	}
	msg := "The endpoint path \"" + configured + "\" is not a usual one for " + format + ". "
	if bestDist <= maxInt(4, len(best)/3) {
		msg += "Did you mean \"" + best + "\"? "
	}
	msg += "Expected: " + strings.Join(paths, " or ") + "."
	return msg
}
