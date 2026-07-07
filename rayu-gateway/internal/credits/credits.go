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
// This is the single-rate primitive still used for the pre-flight estimate
// (EstimateTokens can't know the real input/output/cache split before the
// upstream call happens); the actual charge goes through ForUsage instead,
// which prices each bucket independently.
func ForTokens(totalTokens int64, baselineCreditsPer1M int, multiplier float64) int64 {
	totalTokens = nonNegative(totalTokens)
	if totalTokens <= 0 || baselineCreditsPer1M <= 0 || multiplier <= 0 {
		return 0
	}
	c := math.Ceil(float64(totalTokens) / 1_000_000.0 * float64(baselineCreditsPer1M) * multiplier)
	return int64(c)
}

// nonNegative clamps a provider-reported token count to zero. Real providers
// shouldn't send negative counts, but nothing upstream of this package
// validates that, and a single bad/negative value silently subtracted into a
// cumulative Redis counter would be a hard-to-notice, hard-to-undo billing
// bug — the same defensive posture as OpenCode's/Claude Code's usage-parsing
// `safe()` guards. Clamping here (rather than trusting every call site to
// remember to) makes ForTokens/ForUsage safe by construction.
func nonNegative(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

// CacheHitBillingWeight is the DEFAULT fraction of a cache-hit prompt token's
// normal (cache-miss) price billed to the user's credit balance, used when a
// model has no admin-configured CacheRead override (see DeriveModelRates).
//
// Providers with server-side prompt/context caching (DeepSeek's "Context
// Caching on Disk", enabled by default for every request) charge Rayu only a
// small fraction of the full rate when a request's prompt prefix matches a
// previous request's — typically 1-8% of the cache-miss price, i.e. a
// 92-99% discount. That is exactly what EVERY follow-up call in an agentic
// tool-use loop looks like: the CLI resends the whole growing conversation/
// tool-output history on every turn (chat completion APIs are stateless), so
// only the newest increment is genuinely new — the rest is a byte-for-byte
// repeat of what was already billed (at full price) on the previous call.
//
// Before cache-aware billing was introduced, credits were charged on 100% of
// TotalTokens regardless of cache hits, so a long agentic session could burn
// through a plan's monthly allowance 10-50x faster than the provider's own
// cost to Rayu — the "two prompts, 24M of 50M tokens" class of report.
//
// 0.10 (a 90% discount) is intentionally more conservative than DeepSeek's
// real 92-99% discount, so this under-corrects rather than risks
// under-billing when a model hasn't been given a more precise override.
const CacheHitBillingWeight = 0.10

// ModelRates holds the per-bucket credit multipliers used to price a single
// hosted model's usage. Mirrors the "5-bucket" pricing shape used by Claude
// Code (utils/modelCost.ts: inputTokens/outputTokens/promptCacheWriteTokens/
// promptCacheReadTokens) and OpenCode (models.dev's Cost schema: input/
// output/cache_read/cache_write) instead of one flat multiplier applied to
// every token type — because on every real provider they are NOT the same
// price (DeepSeek: output is ~2x input; cache-read is ~2-8% of input; some
// providers, e.g. Anthropic, charge a cache-WRITE premium instead of a
// discount). A single flat multiplier either overcharges input-heavy calls,
// undercharges output-heavy ones, or cannot discount cache hits at all.
type ModelRates struct {
	Input      float64 // cache-miss / plain prompt tokens
	Output     float64 // completion tokens
	CacheRead  float64 // cache-hit prompt tokens
	CacheWrite float64 // cache-creation prompt tokens (always 0 usage for DeepSeek today; wired for future cache-write-billing providers)
}

// DeriveModelRates builds a model's ModelRates from its admin-configured
// pricing (store.HostedModel's fields, passed in individually so this package
// stays decoupled from the store package).
//
// The Output rate is DERIVED, not a separate admin-entered field: a model's
// existing inputPricePer1MCents/outputPricePer1MCents — already populated
// with each model's real relative provider cost, e.g. DeepSeek's ~2x
// output:input ratio — scale creditMultiplier automatically. That reuses
// already-correct, already-admin-maintained pricing data instead of asking
// admins to redundantly enter (and keep in sync) another ratio.
//
// cacheReadMultiplier/cacheWriteMultiplier are OPTIONAL per-model overrides
// (nil = inherit the fallback below), so a model with neither configured
// derives EXACTLY the same rates as before these overrides existed — no
// existing hosted_models row changes its bill until an admin opts in.
func DeriveModelRates(creditMultiplier float64, inputPricePer1MCents, outputPricePer1MCents int, cacheReadMultiplier, cacheWriteMultiplier *float64) ModelRates {
	output := creditMultiplier
	if inputPricePer1MCents > 0 && outputPricePer1MCents > 0 {
		output = creditMultiplier * float64(outputPricePer1MCents) / float64(inputPricePer1MCents)
	}
	rates := ModelRates{
		Input:      creditMultiplier,
		Output:     output,
		CacheRead:  CacheHitBillingWeight,
		CacheWrite: creditMultiplier, // no premium/discount by default (DeepSeek has no cache-write concept)
	}
	if cacheReadMultiplier != nil {
		rates.CacheRead = *cacheReadMultiplier
	}
	if cacheWriteMultiplier != nil {
		rates.CacheWrite = *cacheWriteMultiplier
	}
	return rates
}

// Usage is a provider-agnostic view of one request's token accounting for
// billing, broken into the same buckets ModelRates prices independently.
// PromptTokens/CompletionTokens/TotalTokens are the standard fields every
// OpenAI-compatible provider reports; PromptCacheHitTokens/
// PromptCacheMissTokens/PromptCacheWriteTokens are populated only by
// providers with cache reporting (zero otherwise, e.g. DeepInfra).
type Usage struct {
	PromptTokens           int64
	CompletionTokens       int64
	TotalTokens            int64
	PromptCacheHitTokens   int64
	PromptCacheMissTokens  int64
	PromptCacheWriteTokens int64
}

// clamp defends against a malformed/negative token count from a provider
// silently corrupting a cumulative credit balance (see nonNegative's doc).
func (u Usage) clamp() Usage {
	u.PromptTokens = nonNegative(u.PromptTokens)
	u.CompletionTokens = nonNegative(u.CompletionTokens)
	u.TotalTokens = nonNegative(u.TotalTokens)
	u.PromptCacheHitTokens = nonNegative(u.PromptCacheHitTokens)
	u.PromptCacheMissTokens = nonNegative(u.PromptCacheMissTokens)
	u.PromptCacheWriteTokens = nonNegative(u.PromptCacheWriteTokens)
	return u
}

// ForUsage converts a provider's token usage into credits using per-bucket
// rates (see ModelRates), with graceful fallbacks as less usage detail is
// available:
//
//  1. Cache breakdown reported (hit/miss/write > 0, e.g. DeepSeek): bill each
//     bucket at its own rate. This is the accurate, cache-aware path.
//  2. No cache breakdown, but prompt/completion are reported separately
//     (true for every OpenAI-compatible provider, e.g. DeepInfra): bill each
//     at its own input/output rate instead of collapsing to one flat rate —
//     this alone fixes output-heavy requests being under/overcharged
//     relative to their real cost when input and output prices differ.
//  3. Only a bare totalTokens is available: bill it all at the input rate,
//     identical to the original pre-cache-aware behavior.
func ForUsage(u Usage, baselineCreditsPer1M int, rates ModelRates) int64 {
	u = u.clamp()
	var billable float64
	switch {
	case u.PromptCacheHitTokens > 0 || u.PromptCacheMissTokens > 0 || u.PromptCacheWriteTokens > 0:
		billable = float64(u.PromptCacheMissTokens)*rates.Input +
			float64(u.PromptCacheHitTokens)*rates.CacheRead +
			float64(u.PromptCacheWriteTokens)*rates.CacheWrite +
			float64(u.CompletionTokens)*rates.Output
	case u.PromptTokens > 0 || u.CompletionTokens > 0:
		billable = float64(u.PromptTokens)*rates.Input + float64(u.CompletionTokens)*rates.Output
	default:
		billable = float64(u.TotalTokens) * rates.Input
	}
	if billable <= 0 || baselineCreditsPer1M <= 0 {
		return 0
	}
	return int64(math.Ceil(billable / 1_000_000.0 * float64(baselineCreditsPer1M)))
}

// BillableTokens is the FINE-GRAINED billing unit: the credit-weighted token
// count for one request's usage — the sum of each bucket's tokens times its
// per-bucket rate (cache-miss/input, cache-hit/read, cache-write, output).
//
// Unlike ForUsage it does NOT divide by 1M or round up to a whole credit, so a
// tiny turn costs its TRUE fractional share instead of a full (coarse) credit.
// The gateway accumulates this; credits are derived by dividing by
// TokensPerCredit(baseline). This is the fix for "a 'hi' turn burned a whole
// 1M-token credit": with 1 credit = 1M tokens, ceil-to-whole-credit charged 1M
// tokens for a ~10k-token turn (and again for each per-turn side query).
func BillableTokens(u Usage, rates ModelRates) int64 {
	u = u.clamp()
	var billable float64
	switch {
	case u.PromptCacheHitTokens > 0 || u.PromptCacheMissTokens > 0 || u.PromptCacheWriteTokens > 0:
		billable = float64(u.PromptCacheMissTokens)*rates.Input +
			float64(u.PromptCacheHitTokens)*rates.CacheRead +
			float64(u.PromptCacheWriteTokens)*rates.CacheWrite +
			float64(u.CompletionTokens)*rates.Output
	case u.PromptTokens > 0 || u.CompletionTokens > 0:
		billable = float64(u.PromptTokens)*rates.Input + float64(u.CompletionTokens)*rates.Output
	default:
		billable = float64(u.TotalTokens) * rates.Input
	}
	if billable <= 0 {
		return 0
	}
	return int64(math.Round(billable))
}

// EstimateBillableTokens is the pre-flight billable-token hold: the raw token
// estimate weighted by the model's input multiplier (the real input/output/cache
// split isn't known until the upstream responds — settle then reconciles to
// BillableTokens). At least 1 so a reservation always claims a slot.
func EstimateBillableTokens(estTokens int64, inputMultiplier float64) int64 {
	if estTokens < 0 {
		estTokens = 0
	}
	b := int64(math.Round(float64(estTokens) * inputMultiplier))
	if b < 1 {
		b = 1
	}
	return b
}

// TokensPerCredit is how many billable tokens equal one credit, from the admin's
// baselineCreditsPer1M (credits charged per 1M tokens at multiplier 1). Defaults
// to 1M when unset. credits = billableTokens / TokensPerCredit.
func TokensPerCredit(baselineCreditsPer1M int) int64 {
	if baselineCreditsPer1M <= 0 {
		return 1_000_000
	}
	return int64(math.Round(1_000_000.0 / float64(baselineCreditsPer1M)))
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
