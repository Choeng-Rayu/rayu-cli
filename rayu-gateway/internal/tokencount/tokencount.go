// Package tokencount estimates how many input tokens an Anthropic Messages
// request would consume.
//
// # WHY THE GATEWAY NEEDS THIS
//
// The Anthropic SDK (which the CLI speaks) offers POST
// /v1/messages/count_tokens, and clients call it to render context usage and to
// decide when to compact. Hosted models are served by providers whose wire
// formats (OpenAI Chat Completions, OpenAI Responses, Google GenAI) have no
// equivalent endpoint, and even the Anthropic-compatible ones do not all
// implement it. Without an answer here the client is left with two bad options:
// give up, or "count" by sending a REAL one-token request — which costs the user
// credits and, done once per context section, trips the concurrency limiter.
//
// So the gateway answers locally: no upstream call, no credits, no rate limit.
//
// # ACCURACY CONTRACT
//
// This is an ESTIMATE and callers must treat it as one. It is deliberately
// tokenizer-free: shipping a per-provider tokenizer would be a large dependency
// that is still wrong for any model whose vocabulary we do not have. The
// heuristic below is close enough for context accounting (typically within
// ~10-15% on English + code) and, importantly, is STABLE — the same request
// always yields the same number, so a UI does not flicker.
//
// It errs slightly HIGH rather than low: a client that thinks it has less room
// than it does compacts a little early, which is harmless. The reverse causes a
// mid-request overflow from the upstream.
package tokencount

import (
	"encoding/json"
	"strings"
	"unicode"
)

// Tuning constants. These are documented estimates, not measurements of a
// specific tokenizer.
const (
	// charsPerToken: English prose averages ~4 characters per token for BPE
	// vocabularies; code is denser (~3.2) because of punctuation. 4 is used for
	// prose and the punctuation surcharge below covers code.
	charsPerToken = 4.0

	// messageOverhead accounts for the role marker and message delimiters that
	// every provider adds around each message.
	messageOverhead = 4

	// blockOverhead covers the structural wrapper of a non-text content block
	// (type discriminator, ids, field names).
	blockOverhead = 8

	// toolOverhead covers the JSON scaffolding around one tool definition, on top
	// of the characters of its name/description/schema.
	toolOverhead = 12

	// imageTokens is a flat per-image estimate. Anthropic prices an image at
	// roughly (width × height) / 750 tokens, which for the ~1092×1092 that
	// clients typically send is ≈1590. Without the pixel dimensions (the payload
	// is base64) a flat figure is the honest answer.
	imageTokens = 1600
)

// Request is the subset of an Anthropic Messages body that affects the input
// token count. Everything else in the body (max_tokens, temperature, stream, …)
// is irrelevant to counting and is ignored.
type Request struct {
	System   any             `json:"system"`
	Messages []Message       `json:"messages"`
	Tools    json.RawMessage `json:"tools"`
	Thinking json.RawMessage `json:"thinking"`
}

// Message is one conversation turn.
type Message struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

// EstimateBody estimates the input tokens for a raw Anthropic Messages JSON
// body. An unparseable body yields 0 tokens and false, so the caller can answer
// with a 400 rather than a confidently wrong number.
func EstimateBody(body []byte) (int, bool) {
	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		return 0, false
	}
	return Estimate(req), true
}

// Estimate returns the estimated input tokens for a parsed request.
func Estimate(req Request) int {
	total := 0

	// system may be a plain string or an array of content blocks.
	total += estimateAny(req.System)

	for _, m := range req.Messages {
		total += messageOverhead
		total += estimateAny(m.Content)
	}

	// Tool definitions are sent on every request and are frequently the largest
	// fixed cost in an agent conversation, so they must be counted.
	if len(req.Tools) > 0 {
		var tools []json.RawMessage
		if json.Unmarshal(req.Tools, &tools) == nil {
			for _, t := range tools {
				total += toolOverhead + estimateText(string(t))
			}
		}
	}

	return total
}

// estimateAny counts a value that may be a string, a content-block array, or a
// single block object — the three shapes the Messages API accepts.
func estimateAny(v any) int {
	switch t := v.(type) {
	case nil:
		return 0
	case string:
		return estimateText(t)
	case []any:
		sum := 0
		for _, item := range t {
			sum += estimateAny(item)
		}
		return sum
	case map[string]any:
		return estimateBlock(t)
	default:
		return 0
	}
}

// estimateBlock counts one content block by its type. Unknown block types fall
// back to counting their JSON, which is never zero — a new block type must not
// silently vanish from the estimate.
func estimateBlock(b map[string]any) int {
	switch b["type"] {
	case "text":
		s, _ := b["text"].(string)
		return estimateText(s)
	case "thinking":
		s, _ := b["thinking"].(string)
		return blockOverhead + estimateText(s)
	case "redacted_thinking":
		// Opaque payload: it still occupies context.
		s, _ := b["data"].(string)
		return blockOverhead + estimateText(s)
	case "image":
		return blockOverhead + imageTokens
	case "tool_use":
		sum := blockOverhead
		if name, ok := b["name"].(string); ok {
			sum += estimateText(name)
		}
		sum += estimateAny(b["input"])
		return sum
	case "tool_result":
		return blockOverhead + estimateAny(b["content"])
	case "document":
		// A PDF/text document block: the source is base64, so count it the same
		// way as any opaque payload.
		return blockOverhead + estimateAny(b["source"])
	default:
		// Includes server_tool_use, web_search_result, and anything added later.
		raw, err := json.Marshal(b)
		if err != nil {
			return blockOverhead
		}
		return blockOverhead + estimateText(string(raw))
	}
}

// estimateText converts characters to tokens.
//
// Two adjustments make this hold up on the mixed prose+code traffic an agent
// actually sends:
//
//   - punctuation and symbols tokenize far more finely than letters (each often
//     becoming its own token), so they are counted at a higher rate;
//   - a short non-empty string still costs at least one token.
func estimateText(s string) int {
	if s == "" {
		return 0
	}
	letters, symbols := 0, 0
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ':
			letters++
		case unicode.IsSpace(r):
			// Newlines/tabs are cheap but not free.
			letters++
		default:
			symbols++
		}
	}
	// Letters at ~4 chars/token; symbols at ~2 (denser tokenization).
	est := float64(letters)/charsPerToken + float64(symbols)/2.0
	n := int(est)
	if est > float64(n) {
		n++ // round up: erring high is the safe direction
	}
	if n == 0 {
		n = 1
	}
	return n
}

// EstimateText is the exported single-string estimate, for callers that only
// have raw text (e.g. counting a system prompt on its own).
func EstimateText(s string) int { return estimateText(strings.TrimSpace(s)) }
