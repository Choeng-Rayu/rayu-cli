package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

// openAIResponses adapts the canonical Anthropic Messages request to OpenAI's
// Responses API (POST /v1/responses) and back.
//
// Shape differences from chat-completions that matter here:
//
//   - the conversation is a flat `input` ITEM list, not `messages`: a tool call is
//     its own `function_call` item and its result a `function_call_output` item,
//     paired by `call_id` (not by message position);
//   - the system prompt is `instructions`;
//   - text parts are `input_text` / `output_text`, images are `input_image`;
//   - function tools are FLAT ({type, name, parameters}), not nested under
//     `function`;
//   - the token cap is `max_output_tokens`.
//
// Streaming (verified against the official streaming-events reference):
//
//	response.created → response.in_progress → response.output_item.added
//	→ response.output_text.delta / response.function_call_arguments.delta /
//	  response.reasoning*.delta → response.output_item.done → response.completed
//
// CRITICAL: `response.failed` and `response.incomplete` are TERMINAL EVENTS ON A
// 200 STREAM, not HTTP errors — so a 200 must not be treated as unconditional
// success. `incomplete_details.reason == "max_tokens"` becomes Anthropic's
// max_tokens stop reason, and usage is still settled when present.
type openAIResponses struct{}

func init() { register(openAIResponses{}) }

func (openAIResponses) Format() string { return providercfg.FormatOpenAIResponses }

// --- request translation (Anthropic → Responses) -----------------------------

func buildResponsesBody(anth map[string]any, model string, stream bool) ([]byte, error) {
	req := map[string]any{
		"model": model,
		"input": responsesInput(anth),
	}
	if sys := systemText(anth["system"]); sys != "" {
		req["instructions"] = sys
	}
	if mt, ok := numField(anth, "max_tokens"); ok {
		req["max_output_tokens"] = int(mt)
	}
	// Reasoning models on this API reject a custom temperature, same as on chat.
	if !isReasoningModel.MatchString(model) {
		if temp, ok := numField(anth, "temperature"); ok {
			req["temperature"] = temp
		}
		if tp, ok := numField(anth, "top_p"); ok {
			req["top_p"] = tp
		}
	}
	if tools := responsesTools(anth["tools"]); len(tools) > 0 {
		req["tools"] = tools
		if tc := responsesToolChoice(anth["tool_choice"]); tc != nil {
			req["tool_choice"] = tc
		}
	}
	if think, ok := anth["thinking"].(map[string]any); ok {
		if t, _ := think["type"].(string); t != "disabled" {
			req["reasoning"] = map[string]any{"effort": reasoningEffortFor(think)}
		}
	}
	if stream {
		req["stream"] = true
		// Delta events carry a random `obfuscation` padding field by default (a
		// side-channel mitigation) which is pure stream overhead for a
		// server-to-server relay. Ask for it off; the adapter ignores the field
		// regardless, so an provider that doesn't support the flag is unaffected.
		req["include_obfuscation"] = false
	}
	return json.Marshal(req)
}

// responsesInput flattens Anthropic messages into Responses input items.
func responsesInput(anth map[string]any) []map[string]any {
	msgs, _ := anth["messages"].([]any)
	out := make([]map[string]any, 0, len(msgs)+2)
	for _, raw := range msgs {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		content := msg["content"]

		if role == "assistant" {
			var text strings.Builder
			if blocks, ok := content.([]any); ok {
				for _, b := range blocks {
					block, ok := b.(map[string]any)
					if !ok {
						continue
					}
					switch block["type"] {
					case "text":
						if s, ok := block["text"].(string); ok {
							text.WriteString(s)
						}
					case "tool_use":
						// A tool call is its own item, paired to its result by call_id.
						args, err := json.Marshal(block["input"])
						if err != nil || block["input"] == nil {
							args = []byte("{}")
						}
						id, _ := block["id"].(string)
						name, _ := block["name"].(string)
						out = append(out, map[string]any{
							"type": "function_call", "call_id": id,
							"name": name, "arguments": string(args),
						})
					}
				}
			} else if s, ok := content.(string); ok {
				text.WriteString(s)
			}
			if text.Len() > 0 {
				out = append(out, map[string]any{
					"role": "assistant",
					"content": []map[string]any{
						{"type": "output_text", "text": text.String()},
					},
				})
			}
			continue
		}

		// user (or any other) role.
		blocks, isList := content.([]any)
		if !isList {
			if s := stringOf(content); s != "" {
				out = append(out, map[string]any{
					"role":    "user",
					"content": []map[string]any{{"type": "input_text", "text": s}},
				})
			}
			continue
		}
		// Tool results become their own items, keyed by call_id.
		var parts []map[string]any
		for _, b := range blocks {
			block, ok := b.(map[string]any)
			if !ok {
				continue
			}
			switch block["type"] {
			case "tool_result":
				id, _ := block["tool_use_id"].(string)
				out = append(out, map[string]any{
					"type": "function_call_output", "call_id": id,
					"output": blocksToText(block["content"]),
				})
				// Images returned by a tool: function_call_output takes a string, so
				// re-send them as user input parts.
				parts = append(parts, responsesImageParts(block["content"])...)
			case "text":
				if s, ok := block["text"].(string); ok && s != "" {
					parts = append(parts, map[string]any{"type": "input_text", "text": s})
				}
			case "image":
				parts = append(parts, responsesImageParts([]any{block})...)
			}
		}
		if len(parts) > 0 {
			out = append(out, map[string]any{"role": "user", "content": parts})
		}
	}
	return out
}

// responsesImageParts converts Anthropic image blocks into input_image parts.
func responsesImageParts(content any) []map[string]any {
	var out []map[string]any
	for _, p := range imagePartsFrom(content) {
		url, _ := p["image_url"].(map[string]any)["url"].(string)
		if url == "" {
			continue
		}
		out = append(out, map[string]any{"type": "input_image", "image_url": url})
	}
	return out
}

// responsesTools emits FLAT function tools (Responses shape).
func responsesTools(raw any) []map[string]any {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		tool, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := tool["name"].(string)
		schema, hasSchema := tool["input_schema"]
		if name == "" {
			// Already-OpenAI-shaped nested function tool: flatten it.
			fn, _ := tool["function"].(map[string]any)
			if fn == nil {
				continue
			}
			name, _ = fn["name"].(string)
			if name == "" {
				continue
			}
			desc, _ := fn["description"].(string)
			params := fn["parameters"]
			if params == nil {
				params = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			out = append(out, map[string]any{
				"type": "function", "name": name, "description": desc, "parameters": params,
			})
			continue
		}
		// Anthropic server tools (versioned type, no schema) have no equivalent.
		if t, _ := tool["type"].(string); t != "" && t != "custom" && !hasSchema {
			continue
		}
		if !hasSchema || schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		desc, _ := tool["description"].(string)
		out = append(out, map[string]any{
			"type": "function", "name": name, "description": desc, "parameters": schema,
		})
	}
	return out
}

func responsesToolChoice(raw any) any {
	tc, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	switch tc["type"] {
	case "auto":
		return "auto"
	case "any":
		return "required"
	case "none":
		return "none"
	case "tool":
		if name, _ := tc["name"].(string); name != "" {
			// Responses names the function inline (no nested "function" object).
			return map[string]any{"type": "function", "name": name}
		}
		return "required"
	}
	return nil
}

// --- response translation (Responses → Anthropic) ----------------------------

// responsesUsage is the Responses token accounting. input_tokens is the TOTAL
// prompt INCLUDING any cached prefix; input_tokens_details.cached_tokens is
// optional (absent = no cache discount, which is the correct billing outcome).
type responsesUsage struct {
	InputTokens       int `json:"input_tokens"`
	OutputTokens      int `json:"output_tokens"`
	TotalTokens       int `json:"total_tokens"`
	InputTokenDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputTokenDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

// toUsage normalizes into the billing buckets. Cached tokens are SUBTRACTED from
// input to get the fresh count, because input_tokens already includes them —
// counting both would bill the cached prefix twice.
func (u *responsesUsage) toUsage() *proxy.Usage {
	if u == nil {
		return nil
	}
	cached := 0
	if u.InputTokenDetails != nil {
		cached = u.InputTokenDetails.CachedTokens
	}
	if cached > u.InputTokens {
		cached = u.InputTokens
	}
	total := u.TotalTokens
	if total == 0 {
		total = u.InputTokens + u.OutputTokens
	}
	out := &proxy.Usage{
		PromptTokens:          u.InputTokens,
		CompletionTokens:      u.OutputTokens,
		TotalTokens:           total,
		PromptCacheHitTokens:  cached,
		PromptCacheMissTokens: u.InputTokens - cached,
	}
	if u.OutputTokenDetails != nil {
		out.CompletionTokensDetails.ReasoningTokens = u.OutputTokenDetails.ReasoningTokens
	}
	return out
}

// responsesEvent is one streaming event. Only the fields the adapter acts on are
// decoded, so unknown/new event types are ignored rather than breaking the turn.
type responsesEvent struct {
	Type string `json:"type"`
	// Text / argument deltas.
	Delta string `json:"delta"`
	// Item lifecycle (function calls arrive as items).
	Item *struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"item"`
	// Terminal events carry the whole response object.
	Response *responsesResponse `json:"response"`
}

type responsesResponse struct {
	Status            string          `json:"status"`
	Usage             *responsesUsage `json:"usage"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Output []responsesOutputItem `json:"output"`
}

type responsesOutputItem struct {
	Type      string `json:"type"`
	CallID    string `json:"call_id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	Content   []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Summary []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"summary"`
}

// isReasoningDelta reports whether an event type carries reasoning text. Both
// `response.reasoning_text.delta` and `response.reasoning_summary_text.delta`
// exist depending on model/config, so match on the family.
func isReasoningDelta(eventType string) bool {
	return strings.HasPrefix(eventType, "response.reasoning") &&
		strings.HasSuffix(eventType, ".delta")
}

func (a openAIResponses) Stream(ctx context.Context, w http.ResponseWriter, req Request) (*proxy.Usage, bool, error) {
	body, err := buildResponsesBody(req.Anthropic, req.UpstreamModelID, true)
	if err != nil {
		return nil, false, err
	}
	resp, _, err := proxy.SendWithFailover(ctx, req.Keys, func(apiKey string) (*http.Request, error) {
		r, err := newUpstreamReq(ctx, req.Route.Endpoint(), apiKey, req.Route, body)
		if err != nil {
			return nil, err
		}
		r.Header.Set("Accept", "text/event-stream")
		return r, nil
	}, req.OnKeyFailure)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		proxy.RelayUpstreamError(w, resp.StatusCode, b)
		return nil, true, fmt.Errorf("upstream status %d: %s", resp.StatusCode, proxy.ErrSnippet(b))
	}

	em := newAnthropicEmitter(w, req.UpstreamModelID)
	var usage *proxy.Usage
	stop := ""
	sawToolCall := false
	// failure is set by a terminal response.failed event: a 200 stream can still
	// report failure, and the caller must learn about it.
	var failure error

	serr := scanSSEData(resp.Body, func(payload []byte) error {
		var ev responsesEvent
		if json.Unmarshal(payload, &ev) != nil {
			return nil
		}
		switch {
		case ev.Type == "response.output_text.delta":
			return em.Text(ev.Delta)

		case isReasoningDelta(ev.Type):
			return em.Thinking(ev.Delta)

		case ev.Type == "response.output_item.added":
			// A function call starts as an item; its arguments then stream.
			if ev.Item != nil && ev.Item.Type == "function_call" {
				sawToolCall = true
				id := ev.Item.CallID
				if id == "" {
					id = ev.Item.ID
				}
				return em.ToolStart(id, ev.Item.Name)
			}
			return nil

		case ev.Type == "response.function_call_arguments.delta":
			return em.ToolArgs(ev.Delta)

		case ev.Type == "response.function_call_arguments.done":
			return nil // arguments already streamed as deltas

		case ev.Type == "response.completed", ev.Type == "response.incomplete", ev.Type == "response.failed":
			if ev.Response != nil {
				if u := ev.Response.Usage.toUsage(); u != nil {
					usage = u
				}
				// max_tokens truncation is reported here, NOT as an HTTP error.
				if ev.Response.IncompleteDetails != nil && ev.Response.IncompleteDetails.Reason == "max_tokens" {
					stop = "max_tokens"
				}
				if ev.Type == "response.failed" && ev.Response.Error != nil {
					failure = fmt.Errorf("upstream response failed (%s): %s",
						ev.Response.Error.Code, ev.Response.Error.Message)
				}
			}
			if ev.Type == "response.failed" && failure == nil {
				failure = fmt.Errorf("upstream reported the response failed")
			}
			return nil
		}
		return nil
	})

	if stop == "" && sawToolCall {
		stop = "tool_use"
	}
	if serr != nil {
		_ = em.Error("The model provider ended the response unexpectedly.")
		_ = em.Finish(stop, usage)
		return usage, em.wrote(), serr
	}
	if failure != nil {
		// Terminal failure on a 200 stream: tell the client, close the stream
		// cleanly, and report the error so it is logged and settled.
		_ = em.Error("The model provider could not complete this response.")
		_ = em.Finish(stop, usage)
		return usage, em.wrote(), failure
	}
	if err := em.Finish(stop, usage); err != nil {
		return usage, em.wrote(), err
	}
	return usage, em.wrote(), nil
}

func (a openAIResponses) Complete(ctx context.Context, req Request) (*proxy.Usage, int, []byte, error) {
	body, err := buildResponsesBody(req.Anthropic, req.UpstreamModelID, false)
	if err != nil {
		return nil, 0, nil, err
	}
	resp, _, err := proxy.SendWithFailover(ctx, req.Keys, func(apiKey string) (*http.Request, error) {
		return newUpstreamReq(ctx, req.Route.Endpoint(), apiKey, req.Route, body)
	}, req.OnKeyFailure)
	if err != nil {
		return nil, 0, nil, err
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, respBody, nil
	}

	var parsed responsesResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, resp.StatusCode, respBody, fmt.Errorf("unparseable upstream response: %w", err)
	}
	usage := parsed.Usage.toUsage()

	blocks := make([]map[string]any, 0, 3)
	sawToolCall := false
	for _, item := range parsed.Output {
		switch item.Type {
		case "reasoning":
			var b strings.Builder
			for _, s := range item.Summary {
				b.WriteString(s.Text)
			}
			if b.Len() > 0 {
				blocks = append(blocks, map[string]any{
					"type": "thinking", "thinking": b.String(), "signature": "",
				})
			}
		case "message":
			var b strings.Builder
			for _, c := range item.Content {
				if c.Type == "output_text" {
					b.WriteString(c.Text)
				}
			}
			if b.Len() > 0 {
				blocks = append(blocks, map[string]any{"type": "text", "text": b.String()})
			}
		case "function_call":
			sawToolCall = true
			var input any = map[string]any{}
			if item.Arguments != "" {
				var decoded any
				if json.Unmarshal([]byte(item.Arguments), &decoded) == nil {
					input = decoded
				}
			}
			blocks = append(blocks, map[string]any{
				"type": "tool_use", "id": item.CallID, "name": item.Name, "input": input,
			})
		}
	}

	stop := "end_turn"
	switch {
	case parsed.IncompleteDetails != nil && parsed.IncompleteDetails.Reason == "max_tokens":
		stop = "max_tokens"
	case sawToolCall:
		stop = "tool_use"
	}
	// A failed response is a provider-side failure even though HTTP said 200; let
	// the caller mask it rather than presenting a half-empty message as success.
	if parsed.Status == "failed" {
		msg := "the model provider could not complete this response"
		if parsed.Error != nil && parsed.Error.Message != "" {
			msg = parsed.Error.Message
		}
		return usage, http.StatusBadGateway, respBody, fmt.Errorf("upstream response failed: %s", msg)
	}

	out, err := anthropicMessageJSON(req.UpstreamModelID, stop, blocks, usage)
	if err != nil {
		return usage, resp.StatusCode, respBody, err
	}
	return usage, resp.StatusCode, out, nil
}
