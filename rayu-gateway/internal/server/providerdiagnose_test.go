package server

import (
	"context"
	"errors"
	"net/http"

	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
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
// An HTML body means "this URL is not an API endpoint" ONLY for statuses where
// there is nothing else it could mean. Throttling, auth and server failures are
// commonly served as HTML pages by whatever sits in front of the provider (a CDN,
// a WAF, nginx) at a URL that is perfectly correct — so there the STATUS is the
// truth, and calling it a bad URL would send the admin to edit a working field.
func TestHTMLDoesNotOverrideAnAuthoritativeStatus(t *testing.T) {
	page := []byte(`<!doctype html><html><head><title>Just a moment…</title></head><body></body></html>`)
	cases := []struct {
		status int
		want   string
		why    string
	}{
		{http.StatusOK, testBadBaseURL, "a 200 web page is not an API response"},
		{http.StatusMovedPermanently, testBadBaseURL, "a redirect to a page is not an API"},
		{http.StatusNotFound, testBadBaseURL, "404 on a page means the path is wrong"},
		{http.StatusMethodNotAllowed, testBadBaseURL, "POST to a page"},
		{http.StatusTooManyRequests, testRateLimited, "a CDN throttle page is still a throttle"},
		{http.StatusPaymentRequired, testRateLimited, "quota exhausted"},
		{http.StatusUnauthorized, testBadAPIKey, "the credential was refused"},
		{http.StatusForbidden, testBadAPIKey, "the credential was refused"},
		{http.StatusBadGateway, testUpstreamError, "an nginx 502 page is the provider being down"},
		{http.StatusServiceUnavailable, testUpstreamError, "provider unavailable"},
	}
	for _, c := range cases {
		got, msg := classifyProviderTest(c.status, page, nil)
		if got != c.want {
			t.Errorf("HTTP %d with an HTML body -> %q, want %q (%s)", c.status, got, c.want, c.why)
		}
		if msg == "" {
			t.Errorf("HTTP %d: empty message", c.status)
		}
	}
}

// Even when the status is authoritative, the answer must show that a PAGE came back:
// that single fact is what tells an admin the URL is suspect too.
func TestAuthoritativeStatusStillReportsThatAPageCameBack(t *testing.T) {
	page := []byte(`<!doctype html><html><head><title>Attention Required</title></head></html>`)
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusBadGateway} {
		_, msg := classifyProviderTest(status, page, nil)
		if !strings.Contains(strings.ToLower(msg), "web page") {
			t.Errorf("HTTP %d message does not mention that a web page came back: %q", status, msg)
		}
	}
}

func TestSuggestEndpointPathIsGone(t *testing.T) {
	// Guard rail for the design decision: a format constrains the body, not the URL.
	// If someone reintroduces path prescription, this test is the reminder.
	page := []byte(`<!doctype html><html></html>`)
	_, msg := classifyProviderTest(http.StatusOK, page, nil)
	for _, forbidden := range []string{"Expected:", "not a usual", "Did you mean"} {
		if strings.Contains(msg, forbidden) {
			t.Errorf("classification message prescribes a path (%q): %q", forbidden, msg)
		}
	}
}

// An adapter that cannot parse a response still HAS a response: status != 0. Those
// must be diagnosed from the status and the body, not reported as a transport
// failure — "Request failed" reads as "the provider is down" when the truth is a
// wrong URL or a wrong format, which is the opposite of actionable. Only status == 0
// means nothing came back at all.
func TestUnparseableResponseIsNotATransportFailure(t *testing.T) {
	parseErr := errors.New("unparseable upstream response: invalid character '<'")

	// 200 + a body the adapter could not read = the provider answered in a shape this
	// format cannot use.
	got, msg := classifyProviderTest(http.StatusOK, []byte(`Not Found`), parseErr)
	if got != testFormatMismatch {
		t.Errorf("200 + unparseable -> %q, want %q (msg=%q)", got, testFormatMismatch, msg)
	}
	if strings.Contains(msg, "Request failed") {
		t.Errorf("message blames the transport: %q", msg)
	}

	// A real transport failure carries no status.
	got, _ = classifyProviderTest(0, nil, errors.New("dial tcp: no such host"))
	if got != testBadBaseURL {
		t.Errorf("status=0 DNS failure -> %q, want %q", got, testBadBaseURL)
	}
	got, _ = classifyProviderTest(0, nil, context.DeadlineExceeded)
	if got != testUpstreamError {
		t.Errorf("status=0 timeout -> %q, want %q", got, testUpstreamError)
	}

	// A 404 whose body the adapter could not parse is still a 404.
	got, _ = classifyProviderTest(http.StatusNotFound, []byte(`<nope>`), parseErr)
	if got != testBadBaseURL {
		t.Errorf("404 + unparseable -> %q, want %q", got, testBadBaseURL)
	}
}

// Detection must survive a field it did not expect. Providers and the gateways in
// front of them add and reshape fields freely, and a single type surprise must not
// blind the whole check — with a rigid struct, one odd field made every format
// unrecognisable and turned a precise diagnosis into a generic one.
func TestDetectResponseFormatSurvivesUnexpectedFieldTypes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			"openai chat with a stray top-level content string",
			`{"object":"chat.completion","choices":[{"message":{"content":"pong"}}],"content":"x"}`,
			providercfg.FormatOpenAIChat,
		},
		{
			"anthropic with a numeric id and an object usage",
			`{"type":"message","role":"assistant","content":[{"type":"text","text":"p"}],"id":12345}`,
			providercfg.FormatAnthropicMessages,
		},
		{
			"genai with candidates plus an unexpected usage shape",
			`{"candidates":[{"content":{"parts":[]}}],"usage":"n/a"}`,
			providercfg.FormatGenAI,
		},
		{
			"responses with output plus a string usage",
			`{"object":"response","output":[],"usage":"none"}`,
			providercfg.FormatOpenAIResponses,
		},
		{
			"anthropic usage fields as strings (a lax proxy)",
			`{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":"3"}}`,
			providercfg.FormatAnthropicMessages,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := detectResponseFormat([]byte(c.body)); got != c.want {
				t.Errorf("detectResponseFormat = %q, want %q", got, c.want)
			}
		})
	}
}

// Bedrock's Claude surface returns the SAME body shape as anthropic_messages, so a
// response shape can never justify telling an admin to switch between those two —
// they differ in the URL and body rules, not the reply. Suggesting a switch would
// break a working Bedrock provider.
func TestNoSuggestionToSwapBedrockForAnthropic(t *testing.T) {
	s := &Server{}
	anthropicBody := []byte(`{"type":"message","role":"assistant","content":[{"type":"text","text":"p"}]}`)

	got := s.suggestFix(testFormatMismatch,
		providercfg.Route{Format: providercfg.FormatBedrockAnthropic, BaseURL: "https://b", EndpointPath: "/x"},
		store.HostedModel{}, 1, anthropicBody)
	if strings.Contains(got, "Set the provider's wire format to "+providercfg.FormatAnthropicMessages) {
		t.Errorf("told a Bedrock provider to become anthropic_messages: %q", got)
	}

	// The reverse is equally wrong.
	got = s.suggestFix(testFormatMismatch,
		providercfg.Route{Format: providercfg.FormatAnthropicMessages, BaseURL: "https://a", EndpointPath: "/x"},
		store.HostedModel{}, 1, anthropicBody)
	if strings.Contains(got, providercfg.FormatBedrockAnthropic) {
		t.Errorf("told an Anthropic provider to become bedrock: %q", got)
	}

	// A genuinely different family is still named.
	got = s.suggestFix(testFormatMismatch,
		providercfg.Route{Format: providercfg.FormatAnthropicMessages, BaseURL: "https://a", EndpointPath: "/x"},
		store.HostedModel{}, 1,
		[]byte(`{"object":"chat.completion","choices":[{"message":{"content":"p"}}]}`))
	if !strings.Contains(got, providercfg.FormatOpenAIChat) {
		t.Errorf("did not name the format actually spoken: %q", got)
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
