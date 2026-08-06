package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

// openAIChat adapts the canonical Anthropic Messages request to an
// OpenAI-compatible /v1/chat/completions provider and back.
//
// The mapping mirrors the CLI's own long-serving OpenAI adapter
// (rayu/src/services/api/openaiAdapter.ts), because that is the behaviour that
// has been proven against real providers (DeepSeek, DeepInfra, OpenRouter,
// Gemini's OpenAI-compat layer, Kimi, …). The notable hard-won details, kept
// deliberately:
//
//   - assistant content is "" (never null) when a turn is only tool calls —
//     Gemini's OpenAI-compat layer rejects null content;
//   - `tool` messages must come immediately after the assistant turn that made
//     the calls, so tool results are emitted before any user text;
//   - a tool result containing images becomes a follow-up user message, since a
//     `tool` message's content must be a string;
//   - reasoning families (o1/o3/o4/gpt-5) need max_completion_tokens instead of
//     max_tokens and reject a custom temperature.
type openAIChat struct{}

func init() { register(openAIChat{}) }

func (openAIChat) Format() string { return providercfg.FormatOpenAIChat }

// --- request translation (Anthropic → OpenAI) --------------------------------

// needsMaxCompletionTokens matches the OpenAI reasoning families that reject
// `max_tokens`. Matched as a path/segment token so gpt-4o (no standalone o3/o4)
// and llama-3 are unaffected.
var needsMaxCompletionTokens = regexp.MustCompile(`(?i)(?:^|[/_-])(o1|o3|o4|gpt-5)(?:[._\-]|$)`)

// isReasoningModel is broader (adds gpt-oss / *reason* / *thinking*) and is used
// only to omit `temperature`, which reasoning models reject or ignore.
var isReasoningModel = regexp.MustCompile(`(?i)(?:^|[/_-])(o1|o3|o4|gpt-5|gpt-oss)(?:[._\-]|$)|reason|thinking`)

// buildOpenAIChatBody translates an Anthropic Messages request into an
// OpenAI-compatible chat-completions request.
func buildOpenAIChatBody(anth map[string]any, model string, stream bool) ([]byte, error) {
	req := map[string]any{
		"model":    model,
		"messages": openAIMessages(anth),
	}
	if mt, ok := numField(anth, "max_tokens"); ok {
		if needsMaxCompletionTokens.MatchString(model) {
			req["max_completion_tokens"] = int(mt)
		} else {
			req["max_tokens"] = int(mt)
		}
	}
	if !isReasoningModel.MatchString(model) {
		if temp, ok := numField(anth, "temperature"); ok {
			req["temperature"] = temp
		}
	}
	if tp, ok := numField(anth, "top_p"); ok {
		req["top_p"] = tp
	}
	if stops, ok := anth["stop_sequences"].([]any); ok && len(stops) > 0 {
		req["stop"] = stops
	}
	if tools := openAITools(anth["tools"]); len(tools) > 0 {
		req["tools"] = tools
		if tc := openAIToolChoice(anth["tool_choice"]); tc != nil {
			req["tool_choice"] = tc
		}
	}
	// Extended thinking → reasoning effort. Anthropic expresses a token budget;
	// OpenAI-compatible providers take a coarse effort level, so map by budget.
	if think, ok := anth["thinking"].(map[string]any); ok {
		if t, _ := think["type"].(string); t != "disabled" {
			req["reasoning_effort"] = reasoningEffortFor(think)
		}
	}
	if stream {
		req["stream"] = true
		// Ask for usage on the final chunk — without this most providers stream no
		// usage at all and the request could not be billed accurately.
		req["stream_options"] = map[string]any{"include_usage": true}
	}
	return json.Marshal(req)
}

// reasoningEffortFor maps an Anthropic thinking budget onto OpenAI's effort levels.
func reasoningEffortFor(thinking map[string]any) string {
	budget, ok := numField(thinking, "budget_tokens")
	if !ok {
		return "medium"
	}
	switch {
	case budget <= 2048:
		return "low"
	case budget <= 8192:
		return "medium"
	default:
		return "high"
	}
}

// openAIMessages translates system + messages[] into OpenAI messages[].
func openAIMessages(anth map[string]any) []map[string]any {
	out := make([]map[string]any, 0, 8)
	if sys := systemText(anth["system"]); sys != "" {
		out = append(out, map[string]any{"role": "system", "content": sys})
	}
	msgs, _ := anth["messages"].([]any)
	for _, raw := range msgs {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		content := msg["content"]
		switch role {
		case "assistant":
			out = append(out, openAIAssistantMessage(content))
		case "user":
			out = append(out, openAIUserMessages(content)...)
		default:
			out = append(out, map[string]any{"role": role, "content": blocksToText(content)})
		}
	}
	return out
}

func openAIAssistantMessage(content any) map[string]any {
	var text strings.Builder
	toolCalls := []map[string]any{}
	if blocks, ok := content.([]any); ok {
		for _, raw := range blocks {
			block, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			switch block["type"] {
			case "text":
				if s, ok := block["text"].(string); ok {
					text.WriteString(s)
				}
			case "tool_use":
				name, _ := block["name"].(string)
				id, _ := block["id"].(string)
				args, err := json.Marshal(block["input"])
				if err != nil || block["input"] == nil {
					args = []byte("{}")
				}
				toolCalls = append(toolCalls, map[string]any{
					"id":   id,
					"type": "function",
					"function": map[string]any{
						"name":      name,
						"arguments": string(args),
					},
				})
			}
		}
	} else if s, ok := content.(string); ok {
		text.WriteString(s)
	}
	// content must be a STRING, never null: some OpenAI-compatibility layers
	// (notably Gemini's) 400 on a null field for every subsequent request once a
	// tool-call turn is in history.
	m := map[string]any{"role": "assistant", "content": text.String()}
	if len(toolCalls) > 0 {
		m["tool_calls"] = toolCalls
	}
	return m
}

// openAIUserMessages expands one Anthropic user turn, which may mix tool results,
// text, and images, into the OpenAI message sequence those require.
func openAIUserMessages(content any) []map[string]any {
	blocks, ok := content.([]any)
	if !ok {
		return []map[string]any{{"role": "user", "content": stringOf(content)}}
	}
	out := make([]map[string]any, 0, 4)
	var toolImages []map[string]any
	// Tool results first: OpenAI requires `tool` messages to directly follow the
	// assistant message whose tool_calls they answer.
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok || block["type"] != "tool_result" {
			continue
		}
		id, _ := block["tool_use_id"].(string)
		out = append(out, map[string]any{
			"role":         "tool",
			"tool_call_id": id,
			"content":      blocksToText(block["content"]),
		})
		toolImages = append(toolImages, imagePartsFrom(block["content"])...)
	}
	// A `tool` message's content must be a string, so images a tool returned are
	// re-sent as a normal user message.
	if len(toolImages) > 0 {
		parts := append([]map[string]any{
			{"type": "text", "text": "Images returned by the previous tool call(s):"},
		}, toolImages...)
		out = append(out, map[string]any{"role": "user", "content": parts})
	}
	// Remaining (non-tool_result) content.
	rest := make([]any, 0, len(blocks))
	for _, raw := range blocks {
		if block, ok := raw.(map[string]any); ok && block["type"] == "tool_result" {
			continue
		}
		rest = append(rest, raw)
	}
	text := blocksToText(rest)
	images := imagePartsFrom(rest)
	switch {
	case len(images) > 0:
		parts := make([]map[string]any, 0, len(images)+1)
		if text != "" {
			parts = append(parts, map[string]any{"type": "text", "text": text})
		}
		parts = append(parts, images...)
		out = append(out, map[string]any{"role": "user", "content": parts})
	case text != "":
		out = append(out, map[string]any{"role": "user", "content": text})
	}
	return out
}

// imagePartsFrom converts Anthropic image blocks into OpenAI image_url parts.
func imagePartsFrom(content any) []map[string]any {
	blocks, ok := content.([]any)
	if !ok {
		return nil
	}
	var parts []map[string]any
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok || block["type"] != "image" {
			continue
		}
		src, _ := block["source"].(map[string]any)
		if src == nil {
			continue
		}
		switch src["type"] {
		case "base64":
			data, _ := src["data"].(string)
			if data == "" {
				continue
			}
			mt, _ := src["media_type"].(string)
			if mt == "" {
				mt = "image/png"
			}
			parts = append(parts, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": "data:" + mt + ";base64," + data},
			})
		case "url":
			if u, _ := src["url"].(string); u != "" {
				parts = append(parts, map[string]any{
					"type":      "image_url",
					"image_url": map[string]any{"url": u},
				})
			}
		}
	}
	return parts
}

// openAITools translates Anthropic tools[] into OpenAI function tools. Anthropic
// SERVER tools (web_search, advisor, …) carry a versioned `type` and no
// input_schema; they have no OpenAI equivalent and are dropped rather than sent
// as a phantom empty function the model might try to call.
func openAITools(raw any) []map[string]any {
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
		if fn, ok := tool["function"]; ok && fn != nil {
			out = append(out, tool) // already OpenAI-shaped
			continue
		}
		name, _ := tool["name"].(string)
		if name == "" {
			continue
		}
		schema, hasSchema := tool["input_schema"]
		if t, _ := tool["type"].(string); t != "" && t != "custom" && !hasSchema {
			continue // server tool with no JSON schema
		}
		if !hasSchema || schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		desc, _ := tool["description"].(string)
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        name,
				"description": desc,
				"parameters":  schema,
			},
		})
	}
	return out
}

func openAIToolChoice(raw any) any {
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
			return map[string]any{"type": "function", "function": map[string]any{"name": name}}
		}
		return "required"
	}
	return nil
}

// --- response translation (OpenAI → Anthropic) -------------------------------

// stopReasonFor maps an OpenAI finish_reason to an Anthropic stop_reason.
func stopReasonFor(finish string) string {
	switch finish {
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	case "":
		return ""
	default:
		return "end_turn"
	}
}

// openAIChatChunk is one streaming chunk (and, reused, one non-streaming choice).
type openAIChatChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			Reasoning any    `json:"reasoning"`
			// DeepSeek/Kimi name it reasoning_content; others use `reasoning`.
			ReasoningContent string `json:"reasoning_content"`
			ToolCalls        []struct {
				Index    *int   `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		Message struct {
			Content          string `json:"content"`
			Reasoning        any    `json:"reasoning"`
			ReasoningContent string `json:"reasoning_content"`
			ToolCalls        []struct {
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *proxy.Usage `json:"usage"`
}

// reasoningText normalizes the several shapes providers use for hidden reasoning.
func reasoningText(direct any, contentField string) string {
	if contentField != "" {
		return contentField
	}
	switch v := direct.(type) {
	case string:
		return v
	case map[string]any:
		if s, ok := v["text"].(string); ok {
			return s
		}
		if s, ok := v["content"].(string); ok {
			return s
		}
	case []any:
		var b strings.Builder
		for _, item := range v {
			switch it := item.(type) {
			case string:
				b.WriteString(it)
			case map[string]any:
				if s, ok := it["text"].(string); ok {
					b.WriteString(s)
				} else if s, ok := it["content"].(string); ok {
					b.WriteString(s)
				}
			}
		}
		return b.String()
	}
	return ""
}

func (a openAIChat) Stream(ctx context.Context, w http.ResponseWriter, req Request) (*proxy.Usage, bool, error) {
	body, err := buildOpenAIChatBody(req.Anthropic, req.UpstreamModelID, true)
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
	// Tool calls stream as fragments keyed by index; a new index means a new call.
	curToolIndex := -1

	serr := scanSSEData(resp.Body, func(payload []byte) error {
		var chunk openAIChatChunk
		if json.Unmarshal(payload, &chunk) != nil {
			return nil // ignore an unparseable chunk rather than killing the turn
		}
		if chunk.Usage != nil && chunk.Usage.TotalTokens > 0 {
			usage = chunk.Usage
		}
		for _, choice := range chunk.Choices {
			if r := reasoningText(choice.Delta.Reasoning, choice.Delta.ReasoningContent); r != "" {
				if err := em.Thinking(r); err != nil {
					return err
				}
			}
			if choice.Delta.Content != "" {
				if err := em.Text(choice.Delta.Content); err != nil {
					return err
				}
			}
			for _, tc := range choice.Delta.ToolCalls {
				idx := curToolIndex
				if tc.Index != nil {
					idx = *tc.Index
				}
				// A new index (or a chunk carrying a name/id) starts a new call.
				if idx != curToolIndex || tc.Function.Name != "" {
					if err := em.ToolStart(tc.ID, tc.Function.Name); err != nil {
						return err
					}
					curToolIndex = idx
				}
				if err := em.ToolArgs(tc.Function.Arguments); err != nil {
					return err
				}
			}
			if choice.FinishReason != "" {
				stop = stopReasonFor(choice.FinishReason)
			}
		}
		return nil
	})
	if serr != nil {
		// The stream broke mid-flight. Tell the client (it has already received
		// events, so an HTTP status is no longer available) and return the usage
		// seen so far so the caller settles what was actually consumed.
		_ = em.Error("The model provider ended the response unexpectedly.")
		_ = em.Finish(stop, usage)
		return usage, em.wrote(), serr
	}
	if err := em.Finish(stop, usage); err != nil {
		return usage, em.wrote(), err
	}
	return usage, em.wrote(), nil
}

func (a openAIChat) Complete(ctx context.Context, req Request) (*proxy.Usage, int, []byte, error) {
	body, err := buildOpenAIChatBody(req.Anthropic, req.UpstreamModelID, false)
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
		// Hand the upstream body back untranslated; the caller decides whether to
		// relay it (client-fixable 4xx) or mask it (provider failure).
		return nil, resp.StatusCode, respBody, nil
	}

	var parsed openAIChatChunk
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, resp.StatusCode, respBody, fmt.Errorf("unparseable upstream response: %w", err)
	}
	blocks := make([]map[string]any, 0, 3)
	stop := ""
	if len(parsed.Choices) > 0 {
		choice := parsed.Choices[0]
		if r := reasoningText(choice.Message.Reasoning, choice.Message.ReasoningContent); r != "" {
			blocks = append(blocks, map[string]any{"type": "thinking", "thinking": r, "signature": ""})
		}
		if choice.Message.Content != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": choice.Message.Content})
		}
		for _, tc := range choice.Message.ToolCalls {
			var input any = map[string]any{}
			if tc.Function.Arguments != "" {
				var decoded any
				if json.Unmarshal([]byte(tc.Function.Arguments), &decoded) == nil {
					input = decoded
				}
			}
			blocks = append(blocks, map[string]any{
				"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input,
			})
		}
		stop = stopReasonFor(choice.FinishReason)
	}
	out, err := anthropicMessageJSON(req.UpstreamModelID, stop, blocks, parsed.Usage)
	if err != nil {
		return nil, resp.StatusCode, respBody, err
	}
	return parsed.Usage, resp.StatusCode, out, nil
}

// --- small shared helpers ----------------------------------------------------

// systemText flattens Anthropic's `system` (string or block list) into text.
func systemText(system any) string {
	switch v := system.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, item := range v {
			switch it := item.(type) {
			case string:
				b.WriteString(it)
			case map[string]any:
				if s, ok := it["text"].(string); ok {
					if b.Len() > 0 {
						b.WriteString("\n")
					}
					b.WriteString(s)
				}
			}
		}
		return b.String()
	}
	return ""
}

// blocksToText joins the text of a content value (string or block list).
func blocksToText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, item := range v {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if block["type"] != "text" {
				continue
			}
			if s, ok := block["text"].(string); ok {
				if b.Len() > 0 {
					b.WriteString("\n")
				}
				b.WriteString(s)
			}
		}
		return b.String()
	}
	return ""
}

func stringOf(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// numField reads a JSON number field (all JSON numbers decode as float64).
func numField(m map[string]any, key string) (float64, bool) {
	v, ok := m[key].(float64)
	return v, ok
}
