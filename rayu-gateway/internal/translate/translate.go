// Package translate turns the gateway's canonical Anthropic Messages request
// into whatever wire format a provider actually speaks, and turns the provider's
// response back into Anthropic Messages.
//
// # WHY THIS EXISTS
//
// The CLI is Anthropic-native: it speaks Anthropic Messages to the gateway and
// nothing else. Providers are not — a resold model may only offer an
// OpenAI-compatible endpoint, OpenAI's Responses API, or Google's GenAI API.
// Putting the translation HERE (rather than in the CLI) means:
//
//   - a provider can be added from the admin dashboard with no client release;
//   - one billing path meters every format, because every adapter reports usage
//     in the same normalized buckets (fresh input / cache read / cache write /
//     output) that the credit engine already prices;
//   - provider API keys never leave the gateway.
//
// PERFORMANCE CONTRACT (every adapter must honour it)
//
//   - Streaming translation is INCREMENTAL: read an upstream event, write the
//     Anthropic event(s), flush. Never buffer a whole response — the point of
//     streaming is time-to-first-token.
//   - No goroutines per request: translation runs on the request's own goroutine,
//     so the gateway's in-flight limiter stays an accurate concurrency valve.
//   - All upstream I/O goes through proxy.SendWithFailover, so every format
//     inherits the circuit breaker, transient retry, and multi-key failover.
//
// The anthropic_messages adapter is a deliberate exception to "translate": it
// relays bytes verbatim, so the dominant path pays no translation cost at all.
package translate

import (
	"context"
	"fmt"
	"net/http"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

// Request is one hosted request, already authorized and metered-reserved by the
// server, in canonical Anthropic Messages form.
type Request struct {
	// Route is the resolved provider (URL, auth scheme, format).
	Route providercfg.Route
	// Keys are the provider's API keys in the order to try them: already filtered
	// to those usable right now (not disabled, invalid, or cooling down) and
	// ordered by priority. Each carries its id so a failure is attributed to the
	// key that caused it.
	Keys []proxy.APIKey
	// OnKeyFailure records a per-key failure (rate limit / rejected credential) so
	// the key's health survives the request. Optional; nil disables tracking.
	OnKeyFailure func(proxy.KeyFailure)
	// UpstreamModelID is the provider's own model id. Adapters MUST send this as
	// the model, never the Rayu model code — that is the model-fidelity guarantee.
	UpstreamModelID string
	// Anthropic is the client's Anthropic Messages request body, decoded. The
	// caller has already replaced "model" with UpstreamModelID.
	Anthropic map[string]any
	// Stream mirrors Anthropic["stream"], resolved once by the caller.
	Stream bool
}

// Adapter serves a hosted request against one provider wire format.
type Adapter interface {
	// Format is the providers.format value this adapter handles.
	Format() string

	// Stream serves a streaming request, writing an Anthropic Messages SSE stream
	// to w as upstream events arrive.
	//
	// wrote reports whether any status/bytes reached the client: while it is
	// false the caller may still write its own error response; once true the
	// adapter owns the response. usage is returned whenever it could be
	// determined — including on a mid-stream failure — so the caller can settle
	// billing for what was actually consumed.
	Stream(ctx context.Context, w http.ResponseWriter, req Request) (usage *proxy.Usage, wrote bool, err error)

	// Complete serves a non-streaming request, returning the upstream status and
	// a body already in Anthropic Messages shape (for a 200) or the upstream's
	// error body (for a non-200, which the caller sanitizes or relays).
	Complete(ctx context.Context, req Request) (usage *proxy.Usage, status int, body []byte, err error)
}

// registry maps a provider format to its adapter. Populated by each adapter's
// init(), so adding a format is one new file plus its registration.
var registry = map[string]Adapter{}

func register(a Adapter) {
	if _, dup := registry[a.Format()]; dup {
		panic("translate: duplicate adapter for format " + a.Format())
	}
	registry[a.Format()] = a
}

// ErrUnsupportedFormat is returned when a provider row names a format this build
// cannot serve. The caller must refuse the request WITHOUT charging the user:
// this is a configuration problem, not a user error.
type ErrUnsupportedFormat struct{ Format string }

func (e ErrUnsupportedFormat) Error() string {
	return fmt.Sprintf("no adapter for provider format %q", e.Format)
}

// For returns the adapter for a provider format.
func For(format string) (Adapter, error) {
	if a, ok := registry[format]; ok {
		return a, nil
	}
	return nil, ErrUnsupportedFormat{Format: format}
}

// Formats lists the wire formats this build can serve (used by boot logging so
// operators can see whether a registry row's format is actually supported).
func Formats() []string {
	out := make([]string, 0, len(registry))
	for f := range registry {
		out = append(out, f)
	}
	return out
}
