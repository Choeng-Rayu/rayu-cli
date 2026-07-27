package translate

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

// anthropicPassthrough serves providers that already speak Anthropic Messages
// (DeepSeek's /anthropic endpoint, LongCat, Ollama Cloud, first-party Anthropic).
//
// It deliberately does NOT translate: the request is forwarded as-is and the SSE
// response is relayed BYTE-FOR-BYTE, with usage sniffed off the stream as it
// passes. That keeps the most-used path at zero marshalling cost and guarantees
// the client sees exactly what the provider sent — no field can be dropped or
// reshaped by a translation layer.
type anthropicPassthrough struct{}

func init() { register(anthropicPassthrough{}) }

func (anthropicPassthrough) Format() string { return providercfg.FormatAnthropicMessages }

func (anthropicPassthrough) Stream(
	ctx context.Context, w http.ResponseWriter, req Request,
) (*proxy.Usage, bool, error) {
	body, err := json.Marshal(req.Anthropic)
	if err != nil {
		return nil, false, err
	}
	return proxy.StreamAnthropic(ctx, w, req.Route.Endpoint(), req.Keys, req.Route.Bearer(), body, req.OnKeyFailure)
}

func (anthropicPassthrough) Complete(
	ctx context.Context, req Request,
) (*proxy.Usage, int, []byte, error) {
	body, err := json.Marshal(req.Anthropic)
	if err != nil {
		return nil, 0, nil, err
	}
	return proxy.CompleteAnthropic(ctx, req.Route.Endpoint(), req.Keys, req.Route.Bearer(), body, req.OnKeyFailure)
}
