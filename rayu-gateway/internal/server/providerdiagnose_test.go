package server

import (
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
)

// The provider test is only trustworthy if it can tell the four supported wire
// formats apart from each other AND from a web page. Everything here is derived
// from the format and the response shape — never from a vendor or hostname — so a
// provider nobody has onboarded yet is diagnosed like any other.

func TestDetectResponseFormat(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			"anthropic messages",
			`{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"pong"}],
			  "usage":{"input_tokens":3,"output_tokens":1}}`,
			providercfg.FormatAnthropicMessages,
		},
		{
			"anthropic with an empty content array",
			`{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":0,"output_tokens":0}}`,
			providercfg.FormatAnthropicMessages,
		},
		{
			"openai chat completion",
			`{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,
			  "message":{"role":"assistant","content":"pong"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
			providercfg.FormatOpenAIChat,
		},
		{
			"openai chat stream chunk",
			`{"object":"chat.completion.chunk","choices":[{"delta":{"content":"p"}}]}`,
			providercfg.FormatOpenAIChat,
		},
		{
			"openai responses",
			`{"id":"resp_1","object":"response","status":"completed","output":[
			  {"type":"message","content":[{"type":"output_text","text":"pong"}]}],
			  "usage":{"input_tokens":3,"output_tokens":1}}`,
			providercfg.FormatOpenAIResponses,
		},
		{
			"google genai",
			`{"candidates":[{"content":{"parts":[{"text":"pong"}],"role":"model"}}],
			  "usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}`,
			providercfg.FormatGenAI,
		},
		{"an error envelope is not a completion", `{"error":{"message":"nope","type":"x"}}`, ""},
		{"empty object", `{}`, ""},
		{"not json", `<!doctype html><html></html>`, ""},
		{"empty", ``, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := detectResponseFormat([]byte(c.body)); got != c.want {
				t.Errorf("detectResponseFormat = %q, want %q", got, c.want)
			}
		})
	}
}

// REGRESSION: the old pass/fail check accepted any body with a `usage` object, so an
// OpenAI or Responses provider configured as anthropic_messages PASSED its test and
// then failed for every real user — the worst possible outcome for a test whose job
// is to prove the configuration.
func TestAnthropicShapeCheckRejectsOtherFormats(t *testing.T) {
	mustPass := []string{
		`{"type":"message","role":"assistant","content":[{"type":"text","text":"pong"}]}`,
		`{"role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}`,
	}
	for _, b := range mustPass {
		if !looksLikeAnthropicMessage([]byte(b)) {
			t.Errorf("rejected a real Anthropic body: %s", b)
		}
	}
	mustFail := []string{
		// OpenAI chat: has `usage`, which the old check treated as proof of Anthropic.
		`{"object":"chat.completion","choices":[{"message":{"content":"pong"}}],"usage":{"prompt_tokens":3}}`,
		// Responses: also has `usage`.
		`{"object":"response","output":[],"usage":{"input_tokens":3,"output_tokens":1}}`,
		// GenAI.
		`{"candidates":[],"usageMetadata":{"promptTokenCount":3}}`,
		`{"error":{"message":"unauthorized"}}`,
		`<!doctype html><html lang="zh"><head></head></html>`,
	}
	for _, b := range mustFail {
		if looksLikeAnthropicMessage([]byte(b)) {
			t.Errorf("accepted a non-Anthropic body as a pass: %s", b)
		}
	}
}

func TestLooksLikeHTML(t *testing.T) {
	yes := []string{
		`<!doctype html>` + "\n" + `<html lang="zh"><head><meta charset="utf-8" /></head></html>`,
		`<!DOCTYPE HTML><html><body>hi</body></html>`,
		`<html><head><meta name="x" /></head></html>`,
		"\n\n  <!doctype html><html></html>",
	}
	for _, b := range yes {
		if !looksLikeHTML([]byte(b)) {
			t.Errorf("not detected as HTML: %q", b)
		}
	}
	no := []string{
		`{"type":"message","content":[]}`,
		`{"error":{"message":"the model <html> is unknown"}}`,
		``,
		`plain text error`,
	}
	for _, b := range no {
		if looksLikeHTML([]byte(b)) {
			t.Errorf("wrongly detected as HTML: %q", b)
		}
	}
}

// A format constrains the BODY, never the URL: providers serve the same wire format
// at whatever path they choose. So the diagnosis must report the URL it actually
// called and must never call an unfamiliar path a mistake — the only format-derived
// path in the system is the fallback used when the admin leaves the field blank.
func TestEndpointDescriptionDoesNotPrescribeAPath(t *testing.T) {
	custom := providercfg.Route{
		Name: "agent-router", Format: providercfg.FormatAnthropicMessages,
		BaseURL: "https://agentrouter.org", EndpointPath: "/relay/claude/v3",
	}
	got := describeConfiguredEndpoint(custom)
	if !strings.Contains(got, "https://agentrouter.org/relay/claude/v3") {
		t.Errorf("does not name the URL that was called: %q", got)
	}
	if !strings.Contains(got, "verbatim") {
		t.Errorf("does not say the configured URL is used as-is: %q", got)
	}
	for _, forbidden := range []string{"expected", "not a usual", "Did you mean", "should be"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("judges the admin's path (%q): %q", forbidden, got)
		}
	}

	// Blank is the one case worth calling out, because the gateway substitutes a
	// path the admin never typed and would otherwise not know was sent.
	blank := custom
	blank.EndpointPath = ""
	got = describeConfiguredEndpoint(blank)
	if !strings.Contains(got, "blank") || !strings.Contains(got, "fallback") {
		t.Errorf("does not disclose the substituted fallback: %q", got)
	}
	if !strings.Contains(got, providercfg.DefaultEndpointPath(providercfg.FormatAnthropicMessages)) {
		t.Errorf("does not name the fallback path it used: %q", got)
	}
	if !strings.Contains(got, "any path is fine") {
		t.Errorf("does not make clear a custom path is legitimate: %q", got)
	}
}

// Every supported format must have an auth hint, or the advice is silently missing
// for whichever format an admin happens to pick.
func TestAuthHintCoversEveryFormat(t *testing.T) {
	for _, f := range []string{
		providercfg.FormatAnthropicMessages,
		providercfg.FormatOpenAIChat,
		providercfg.FormatOpenAIResponses,
		providercfg.FormatGenAI,
		providercfg.FormatBedrockAnthropic,
	} {
		if authHint(f) == "" {
			t.Errorf("no auth hint for %s", f)
		}
	}
}
