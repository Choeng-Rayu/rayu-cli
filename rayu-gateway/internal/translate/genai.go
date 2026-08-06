package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
)

// genAI adapts the canonical Anthropic Messages request to Google's Gemini
// generateContent API and back.
//
// Shape differences that matter:
//
//   - the conversation is `contents` with roles user|MODEL (not "assistant");
//   - the system prompt is `systemInstruction`;
//   - sampling/limits live under `generationConfig`;
//   - tools are `functionDeclarations`, and a tool RESULT is keyed by function
//     NAME, not by call id — so the adapter maps tool_use_id → name from the
//     conversation it was given;
//   - images are `inlineData` (base64 only — Gemini has no URL image part);
//   - the model id and streaming mode are part of the URL
//     (…/v1beta/models/{model}:streamGenerateContent?alt=sse).
//
// Google now labels generateContent "legacy" in favour of a newer Interactions
// API, but v1beta generateContent is what is broadly available and is what the
// CLI's own Gemini path targets, so that is what this adapter speaks.
type genAI struct{}

func init() { register(genAI{}) }

func (genAI) Format() string { return providercfg.FormatGenAI }

// --- thought-signature relay -------------------------------------------------
//
// Gemini 3 attaches an opaque `thoughtSignature` to each functionCall part that
// MUST be echoed back on later turns, or the next request 400s with "Function
// call is missing a thought_signature". The Anthropic wire format has no field
// for it, so the gateway keeps it two ways:
//
//  1. it is emitted on the tool_use block as `thought_signature`, and read back
//     from the client's replayed block when present (fully stateless);
//  2. as a fallback for clients that strip unknown block fields, a bounded
//     in-memory cache keyed by tool-call id.
//
// The cache is best-effort by design: it is capped (no unbounded growth) and
// process-local, so on a multi-instance deployment a follow-up turn may land on
// another instance and miss — which is exactly why (1) exists as the primary
// mechanism.
const maxThoughtSignatures = 4096

var thoughtSigs = struct {
	mu    sync.Mutex
	byID  map[string]string
	order []string
}{byID: map[string]string{}}

func rememberThoughtSignature(id, sig string) {
	if id == "" || sig == "" {
		return
	}
	thoughtSigs.mu.Lock()
	defer thoughtSigs.mu.Unlock()
	if _, dup := thoughtSigs.byID[id]; !dup {
		if len(thoughtSigs.order) >= maxThoughtSignatures {
			oldest := thoughtSigs.order[0]
			thoughtSigs.order = thoughtSigs.order[1:]
			delete(thoughtSigs.byID, oldest)
		}
		thoughtSigs.order = append(thoughtSigs.order, id)
	}
	thoughtSigs.byID[id] = sig
}

func thoughtSignature(id string) string {
	if id == "" {
		return ""
	}
	thoughtSigs.mu.Lock()
	defer thoughtSigs.mu.Unlock()
	return thoughtSigs.byID[id]
}

// --- request translation (Anthropic → GenAI) ---------------------------------

// genAIEndpoint builds the model+mode specific URL. An admin-provided
// endpointPath override may contain {model} and {method} placeholders; otherwise
// the standard v1beta path is used.
func genAIEndpoint(route providercfg.Route, model string, stream bool) string {
	method := "generateContent"
	query := ""
	if stream {
		method = "streamGenerateContent"
		query = "?alt=sse" // without this Gemini streams a JSON array, not SSE
	}
	model = strings.TrimPrefix(model, "models/")
	path := route.EndpointPath
	if path == "" {
		path = "/v1beta/models/{model}:{method}"
	}
	path = strings.ReplaceAll(path, "{model}", model)
	path = strings.ReplaceAll(path, "{method}", method)
	return route.URL(path) + query
}

func buildGenAIBody(anth map[string]any) ([]byte, error) {
	contents, _ := genAIContents(anth)
	req := map[string]any{"contents": contents}
	if sys := systemText(anth["system"]); sys != "" {
		req["systemInstruction"] = map[string]any{
			"parts": []map[string]any{{"text": sys}},
		}
	}
	cfg := map[string]any{}
	if mt, ok := numField(anth, "max_tokens"); ok {
		cfg["maxOutputTokens"] = int(mt)
	}
	if temp, ok := numField(anth, "temperature"); ok {
		cfg["temperature"] = temp
	}
	if tp, ok := numField(anth, "top_p"); ok {
		cfg["topP"] = tp
	}
	if stops, ok := anth["stop_sequences"].([]any); ok && len(stops) > 0 {
		cfg["stopSequences"] = stops
	}
	// Extended thinking → thinkingConfig. includeThoughts is required for Gemini
	// to return thought SUMMARIES at all, which is what becomes the CLI's
	// thinking block.
	if think, ok := anth["thinking"].(map[string]any); ok {
		if t, _ := think["type"].(string); t != "disabled" {
			tc := map[string]any{"includeThoughts": true}
			if budget, ok := numField(think, "budget_tokens"); ok {
				tc["thinkingBudget"] = int(budget)
			}
			cfg["thinkingConfig"] = tc
		} else {
			cfg["thinkingConfig"] = map[string]any{"thinkingBudget": 0, "includeThoughts": false}
		}
	}
	if len(cfg) > 0 {
		req["generationConfig"] = cfg
	}
	if decls := genAIFunctionDeclarations(anth["tools"]); len(decls) > 0 {
		req["tools"] = []map[string]any{{"functionDeclarations": decls}}
		if tc := genAIToolConfig(anth["tool_choice"]); tc != nil {
			req["toolConfig"] = tc
		}
	}
	return json.Marshal(req)
}

// genAIContents translates Anthropic messages into Gemini contents. It also
// returns the tool_use_id → function name map, because Gemini keys a
// functionResponse by NAME while Anthropic keys a tool_result by ID.
func genAIContents(anth map[string]any) ([]map[string]any, map[string]string) {
	msgs, _ := anth["messages"].([]any)
	out := make([]map[string]any, 0, len(msgs))
	idToName := map[string]string{}

	for _, raw := range msgs {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		content := msg["content"]

		if role == "assistant" {
			parts := make([]map[string]any, 0, 2)
			if s, ok := content.(string); ok && s != "" {
				parts = append(parts, map[string]any{"text": s})
			}
			if blocks, ok := content.([]any); ok {
				for _, b := range blocks {
					block, ok := b.(map[string]any)
					if !ok {
						continue
					}
					switch block["type"] {
					case "text":
						if s, _ := block["text"].(string); s != "" {
							parts = append(parts, map[string]any{"text": s})
						}
					case "tool_use":
						id, _ := block["id"].(string)
						name, _ := block["name"].(string)
						if id != "" {
							idToName[id] = name
						}
						args := block["input"]
						if args == nil {
							args = map[string]any{}
						}
						part := map[string]any{
							"functionCall": map[string]any{"name": name, "args": args},
						}
						// Echo the thought signature: prefer one the client replayed on
						// the block, else the cached one. Without it Gemini 3 rejects the
						// whole request.
						sig, _ := block["thought_signature"].(string)
						if sig == "" {
							sig = thoughtSignature(id)
						}
						if sig != "" {
							part["thoughtSignature"] = sig
						}
						parts = append(parts, part)
					}
				}
			}
			if len(parts) > 0 {
				// Gemini's assistant role is "model".
				out = append(out, map[string]any{"role": "model", "parts": parts})
			}
			continue
		}

		blocks, isList := content.([]any)
		if !isList {
			if s := stringOf(content); s != "" {
				out = append(out, map[string]any{
					"role":  "user",
					"parts": []map[string]any{{"text": s}},
				})
			}
			continue
		}
		var fnResponses, userParts []map[string]any
		for _, b := range blocks {
			block, ok := b.(map[string]any)
			if !ok {
				continue
			}
			switch block["type"] {
			case "tool_result":
				id, _ := block["tool_use_id"].(string)
				name := idToName[id]
				if name == "" {
					name = id // best effort when the call wasn't in this conversation
				}
				fnResponses = append(fnResponses, map[string]any{
					"functionResponse": map[string]any{
						"name":     name,
						"response": map[string]any{"result": blocksToText(block["content"])},
					},
				})
				userParts = append(userParts, genAIImageParts(block["content"])...)
			case "text":
				if s, _ := block["text"].(string); s != "" {
					userParts = append(userParts, map[string]any{"text": s})
				}
			case "image":
				userParts = append(userParts, genAIImageParts([]any{block})...)
			}
		}
		if len(fnResponses) > 0 {
			out = append(out, map[string]any{"role": "user", "parts": fnResponses})
		}
		if len(userParts) > 0 {
			out = append(out, map[string]any{"role": "user", "parts": userParts})
		}
	}
	return out, idToName
}

// genAIImageParts converts Anthropic image blocks into inlineData parts. Gemini
// has no URL image part, so url-sourced images are dropped rather than sent in a
// shape the API would reject.
func genAIImageParts(content any) []map[string]any {
	blocks, ok := content.([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok || block["type"] != "image" {
			continue
		}
		src, _ := block["source"].(map[string]any)
		if src == nil || src["type"] != "base64" {
			continue
		}
		data, _ := src["data"].(string)
		if data == "" {
			continue
		}
		mime, _ := src["media_type"].(string)
		if mime == "" {
			mime = "image/png"
		}
		out = append(out, map[string]any{
			"inlineData": map[string]any{"mimeType": mime, "data": data},
		})
	}
	return out
}

// geminiSchemaKeys is the subset of JSON Schema Gemini's functionDeclarations
// accept (an OpenAPI 3.0 subset). Anything else ($schema, additionalProperties,
// $ref, allOf, oneOf, …) must be stripped: Gemini 400s on unknown field names.
var geminiSchemaKeys = map[string]bool{
	"type": true, "format": true, "title": true, "description": true,
	"nullable": true, "enum": true, "maxItems": true, "minItems": true,
	"properties": true, "required": true, "minProperties": true,
	"maxProperties": true, "minLength": true, "maxLength": true,
	"pattern": true, "example": true, "anyOf": true, "propertyOrdering": true,
	"default": true, "items": true, "minimum": true, "maximum": true,
}

// sanitizeGeminiSchema recursively reduces a JSON Schema to the accepted subset,
// collapsing `type: [x, "null"]` unions into type + nullable.
func sanitizeGeminiSchema(node any) any {
	switch v := node.(type) {
	case []any:
		out := make([]any, 0, len(v))
		for _, item := range v {
			out = append(out, sanitizeGeminiSchema(item))
		}
		return out
	case map[string]any:
		out := map[string]any{}
		if types, ok := v["type"].([]any); ok {
			for _, t := range types {
				if s, _ := t.(string); s == "null" {
					out["nullable"] = true
				} else if _, has := out["type"]; !has && s != "" {
					out["type"] = s
				}
			}
		}
		for k, val := range v {
			if !geminiSchemaKeys[k] {
				continue
			}
			switch {
			case k == "type":
				if _, isList := val.([]any); isList {
					continue // handled above
				}
				out[k] = val
			case k == "properties":
				if props, ok := val.(map[string]any); ok {
					clean := map[string]any{}
					for name, sub := range props {
						clean[name] = sanitizeGeminiSchema(sub)
					}
					out["properties"] = clean
				}
			case k == "items" || k == "anyOf":
				out[k] = sanitizeGeminiSchema(val)
			default:
				out[k] = val
			}
		}
		return out
	default:
		return node
	}
}

func genAIFunctionDeclarations(raw any) []map[string]any {
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
		desc, _ := tool["description"].(string)
		schema, hasSchema := tool["input_schema"]
		if fn, ok := tool["function"].(map[string]any); ok && name == "" {
			name, _ = fn["name"].(string)
			desc, _ = fn["description"].(string)
			schema, hasSchema = fn["parameters"], fn["parameters"] != nil
		}
		if name == "" {
			continue
		}
		// Anthropic server tools carry a versioned type and no schema.
		if t, _ := tool["type"].(string); t != "" && t != "custom" && !hasSchema {
			continue
		}
		if !hasSchema || schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"name":        name,
			"description": desc,
			"parameters":  sanitizeGeminiSchema(schema),
		})
	}
	return out
}

func genAIToolConfig(raw any) map[string]any {
	tc, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	cfg := map[string]any{}
	switch tc["type"] {
	case "auto":
		cfg["mode"] = "AUTO"
	case "any":
		cfg["mode"] = "ANY"
	case "none":
		cfg["mode"] = "NONE"
	case "tool":
		cfg["mode"] = "ANY"
		if name, _ := tc["name"].(string); name != "" {
			cfg["allowedFunctionNames"] = []string{name}
		}
	default:
		return nil
	}
	return map[string]any{"functionCallingConfig": cfg}
}

// --- response translation (GenAI → Anthropic) --------------------------------

type genAIChunk struct {
	Candidates []struct {
		Content struct {
			Parts []genAIPart `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *genAIUsage `json:"usageMetadata"`
}

type genAIPart struct {
	Text    string `json:"text"`
	Thought bool   `json:"thought"`
	// ThoughtSignature must be echoed back on later turns (Gemini 3).
	ThoughtSignature string `json:"thoughtSignature"`
	FunctionCall     *struct {
		Name string `json:"name"`
		Args any    `json:"args"`
	} `json:"functionCall"`
}

// genAIUsage is Gemini's token accounting. promptTokenCount ALREADY INCLUDES
// cachedContentTokenCount, and thoughtsTokenCount is billed as output but
// reported separately from candidatesTokenCount.
type genAIUsage struct {
	PromptTokenCount        int `json:"promptTokenCount"`
	CandidatesTokenCount    int `json:"candidatesTokenCount"`
	CachedContentTokenCount int `json:"cachedContentTokenCount"`
	ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
	TotalTokenCount         int `json:"totalTokenCount"`
}

func (u *genAIUsage) toUsage() *proxy.Usage {
	if u == nil {
		return nil
	}
	cached := u.CachedContentTokenCount
	if cached > u.PromptTokenCount {
		cached = u.PromptTokenCount
	}
	// Thinking tokens are output tokens the provider charges for, so they must be
	// part of CompletionTokens (and reported separately for observability).
	completion := u.CandidatesTokenCount + u.ThoughtsTokenCount
	total := u.TotalTokenCount
	if total == 0 {
		total = u.PromptTokenCount + completion
	}
	out := &proxy.Usage{
		PromptTokens:     u.PromptTokenCount,
		CompletionTokens: completion,
		TotalTokens:      total,
		// prompt already includes the cached prefix: subtract, never add, or the
		// cached tokens get billed twice.
		PromptCacheHitTokens:  cached,
		PromptCacheMissTokens: u.PromptTokenCount - cached,
	}
	out.CompletionTokensDetails.ReasoningTokens = u.ThoughtsTokenCount
	return out
}

// genAIStopReason maps a Gemini finishReason onto an Anthropic stop_reason.
func genAIStopReason(finish string, sawToolCall bool) string {
	if sawToolCall {
		return "tool_use"
	}
	switch strings.ToUpper(finish) {
	case "MAX_TOKENS":
		return "max_tokens"
	case "", "STOP":
		return "end_turn"
	default:
		// SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, … — the turn was cut
		// short by a provider policy, which for the client is a stop, not a crash.
		return "end_turn"
	}
}

func (a genAI) Stream(ctx context.Context, w http.ResponseWriter, req Request) (*proxy.Usage, bool, error) {
	body, err := buildGenAIBody(req.Anthropic)
	if err != nil {
		return nil, false, err
	}
	url := genAIEndpoint(req.Route, req.UpstreamModelID, true)
	resp, _, err := proxy.SendWithFailover(ctx, req.Keys, func(apiKey string) (*http.Request, error) {
		r, err := newUpstreamReq(ctx, url, apiKey, req.Route, body)
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
	finish := ""
	sawToolCall := false
	toolSeq := 0

	serr := scanSSEData(resp.Body, func(payload []byte) error {
		var chunk genAIChunk
		if json.Unmarshal(payload, &chunk) != nil {
			return nil
		}
		if u := chunk.UsageMetadata.toUsage(); u != nil {
			usage = u
		}
		for _, cand := range chunk.Candidates {
			for _, part := range cand.Content.Parts {
				switch {
				// A thought part also carries `text`, so check it FIRST.
				case part.Thought && part.Text != "":
					if err := em.Thinking(part.Text); err != nil {
						return err
					}
				case part.FunctionCall != nil:
					sawToolCall = true
					toolSeq++
					id := fmt.Sprintf("toolu_rayu_%s_%d", em.msgID[len("msg_rayu_"):], toolSeq)
					rememberThoughtSignature(id, part.ThoughtSignature)
					if err := em.ToolStart(id, part.FunctionCall.Name); err != nil {
						return err
					}
					// Gemini delivers complete args (not fragments), so emit one delta.
					args := part.FunctionCall.Args
					if args == nil {
						args = map[string]any{}
					}
					encoded, mErr := json.Marshal(args)
					if mErr != nil {
						encoded = []byte("{}")
					}
					if err := em.ToolArgs(string(encoded)); err != nil {
						return err
					}
					// Relay the signature to the client so it can be replayed even if
					// this gateway instance forgets it.
					if part.ThoughtSignature != "" {
						if err := em.ToolSignature(part.ThoughtSignature); err != nil {
							return err
						}
					}
				case part.Text != "":
					if err := em.Text(part.Text); err != nil {
						return err
					}
				}
			}
			if cand.FinishReason != "" {
				finish = cand.FinishReason
			}
		}
		return nil
	})

	stop := genAIStopReason(finish, sawToolCall)
	if serr != nil {
		_ = em.Error("The model provider ended the response unexpectedly.")
		_ = em.Finish(stop, usage)
		return usage, em.wrote(), serr
	}
	if err := em.Finish(stop, usage); err != nil {
		return usage, em.wrote(), err
	}
	return usage, em.wrote(), nil
}

func (a genAI) Complete(ctx context.Context, req Request) (*proxy.Usage, int, []byte, error) {
	body, err := buildGenAIBody(req.Anthropic)
	if err != nil {
		return nil, 0, nil, err
	}
	url := genAIEndpoint(req.Route, req.UpstreamModelID, false)
	resp, _, err := proxy.SendWithFailover(ctx, req.Keys, func(apiKey string) (*http.Request, error) {
		return newUpstreamReq(ctx, url, apiKey, req.Route, body)
	}, req.OnKeyFailure)
	if err != nil {
		return nil, 0, nil, err
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, respBody, nil
	}

	var parsed genAIChunk
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, resp.StatusCode, respBody, fmt.Errorf("unparseable upstream response: %w", err)
	}
	usage := parsed.UsageMetadata.toUsage()
	blocks := make([]map[string]any, 0, 3)
	finish := ""
	sawToolCall := false
	seq := 0
	for _, cand := range parsed.Candidates {
		if cand.FinishReason != "" {
			finish = cand.FinishReason
		}
		for _, part := range cand.Content.Parts {
			switch {
			case part.Thought && part.Text != "":
				blocks = append(blocks, map[string]any{
					"type": "thinking", "thinking": part.Text, "signature": "",
				})
			case part.FunctionCall != nil:
				sawToolCall = true
				seq++
				id := fmt.Sprintf("toolu_rayu_%s_%d", newMessageID()[len("msg_rayu_"):], seq)
				rememberThoughtSignature(id, part.ThoughtSignature)
				args := part.FunctionCall.Args
				if args == nil {
					args = map[string]any{}
				}
				block := map[string]any{
					"type": "tool_use", "id": id, "name": part.FunctionCall.Name, "input": args,
				}
				if part.ThoughtSignature != "" {
					block["thought_signature"] = part.ThoughtSignature
				}
				blocks = append(blocks, block)
			case part.Text != "":
				blocks = append(blocks, map[string]any{"type": "text", "text": part.Text})
			}
		}
	}
	out, err := anthropicMessageJSON(req.UpstreamModelID, genAIStopReason(finish, sawToolCall), blocks, usage)
	if err != nil {
		return usage, resp.StatusCode, respBody, err
	}
	return usage, resp.StatusCode, out, nil
}
