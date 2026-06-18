// Package credits implements the credit math and the Redis-backed windowed
// rate limiter (5h + weekly fixed windows, concurrency and request caps) with
// atomic reserve/settle.
package credits

import "math"

// ForTokens converts a token count into credits:
//
//	credits = ceil( totalTokens / 1_000_000 * baselineCreditsPer1M * multiplier )
//
// Any positive usage costs at least 1 credit (ceil). Zero tokens cost nothing.
func ForTokens(totalTokens int64, baselineCreditsPer1M int, multiplier float64) int64 {
	if totalTokens <= 0 || baselineCreditsPer1M <= 0 || multiplier <= 0 {
		return 0
	}
	c := math.Ceil(float64(totalTokens) / 1_000_000.0 * float64(baselineCreditsPer1M) * multiplier)
	return int64(c)
}

// EstimateTokens makes a conservative upper-ish token estimate for the pre-flight
// reserve, from the prompt size (~4 chars/token) plus the requested max_tokens
// (or defaultMaxTokens when unset). The settle step later corrects to actuals.
func EstimateTokens(req map[string]any, defaultMaxTokens int) int64 {
	var promptChars int
	if msgs, ok := req["messages"].([]any); ok {
		for _, m := range msgs {
			mm, ok := m.(map[string]any)
			if !ok {
				continue
			}
			switch c := mm["content"].(type) {
			case string:
				promptChars += len(c)
			case []any:
				for _, part := range c {
					if pm, ok := part.(map[string]any); ok {
						if t, ok := pm["text"].(string); ok {
							promptChars += len(t)
						}
					}
				}
			}
		}
	}
	inputTokens := int64(promptChars / 4)
	maxTok := int64(defaultMaxTokens)
	if mt, ok := req["max_tokens"].(float64); ok && mt > 0 {
		maxTok = int64(mt)
	}
	est := inputTokens + maxTok
	if est < 1 {
		est = 1
	}
	return est
}
