//! Credit math: how a request's token usage becomes a charge.
//!
//! Port of the Go gateway's `internal/credits/credits.go`.
//!
//! Every rounding step, clamp and fallback here is load-bearing: it decides what a
//! customer is billed. Where the Go original rounds up in one place and to-nearest
//! in another, that asymmetry is reproduced rather than tidied.

/// The DEFAULT fraction of a cache-hit prompt token's normal (cache-miss) price
/// billed to the user, used when a model has no admin-configured cache-read
/// override.
///
/// Providers with server-side prompt caching (DeepSeek's context caching, enabled
/// by default) charge Rayu only a small fraction of the full rate when a request's
/// prompt prefix matches a previous one -- typically 1-8%, i.e. a 92-99% discount.
/// That is exactly what EVERY follow-up call in an agentic tool-use loop looks
/// like: the CLI resends the whole growing conversation on every turn, so only the
/// newest increment is genuinely new.
///
/// Before cache-aware billing existed, credits were charged on 100% of
/// `total_tokens` regardless of cache hits, so a long agentic session could burn a
/// plan's monthly allowance 10-50x faster than the provider's own cost to Rayu.
///
/// 0.10 (a 90% discount) is deliberately more conservative than the real 92-99%,
/// so this under-corrects rather than risks under-billing.
pub const CACHE_HIT_BILLING_WEIGHT: f64 = 0.10;

/// Clamps a provider-reported token count to zero.
///
/// Real providers shouldn't send negative counts, but nothing upstream of this
/// module validates that, and a single negative value silently subtracted into a
/// cumulative Redis counter would be a hard-to-notice, hard-to-undo billing bug.
/// Clamping here (rather than trusting every call site to remember) makes the
/// conversions safe by construction.
fn non_negative(v: i64) -> i64 {
    v.max(0)
}

/// The per-bucket credit multipliers used to price one model's usage.
///
/// Mirrors the five-bucket pricing shape every real provider uses, instead of one
/// flat multiplier applied to every token type -- because they are NOT the same
/// price (DeepSeek: output is ~2x input, cache-read is ~2-8% of input; Anthropic
/// charges a cache-WRITE premium instead of a discount). A single flat multiplier
/// either overcharges input-heavy calls, undercharges output-heavy ones, or cannot
/// discount cache hits at all.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelRates {
    /// Cache-miss / plain prompt tokens.
    pub input: f64,
    /// Completion tokens.
    pub output: f64,
    /// Cache-hit prompt tokens.
    pub cache_read: f64,
    /// Cache-creation prompt tokens.
    pub cache_write: f64,
}

/// Builds a model's [`ModelRates`] from the FOUR admin-entered credit charges.
///
/// There is deliberately no derivation from cost prices: the output charge used to
/// be computed as `creditMultiplier x outputPrice / inputPrice`, which coupled what
/// a CUSTOMER pays to Rayu's own cost figures -- editing a cost price silently
/// re-priced the product -- and left two of the four charges invisible in the
/// dashboard. All four are now explicit, admin-owned, and used verbatim.
///
/// Non-positive values are treated as "not configured" and fall back to the input
/// charge, so a partially-filled row can never bill at zero.
///
/// Note the deliberate asymmetry, copied from Go: `output` and `cache_write` fall
/// back when `<= 0`, but `cache_read` only when `< 0`. A configured cache-read
/// charge of exactly 0 therefore means "cache hits are free", which is a real
/// (if generous) admin choice, whereas a 0 output charge is always a mistake.
pub fn model_rates_for(input: f64, output: f64, cache_read: f64, cache_write: f64) -> ModelRates {
    let input = if input < 0.0 { 0.0 } else { input };
    let mut rates = ModelRates {
        input,
        output,
        cache_read,
        cache_write,
    };
    if rates.output <= 0.0 {
        rates.output = input;
    }
    if rates.cache_read < 0.0 {
        // An ABSOLUTE charge (not a fraction of input), matching how the DB column
        // defaults.
        rates.cache_read = CACHE_HIT_BILLING_WEIGHT;
    }
    if rates.cache_write <= 0.0 {
        rates.cache_write = input;
    }
    rates
}

/// A provider-agnostic view of one request's token accounting for billing, broken
/// into the same buckets [`ModelRates`] prices independently.
///
/// `prompt`/`completion`/`total` are the standard fields every OpenAI-compatible
/// provider reports; the cache buckets are populated only by providers with cache
/// reporting (zero otherwise).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub prompt_cache_hit_tokens: i64,
    pub prompt_cache_miss_tokens: i64,
    pub prompt_cache_write_tokens: i64,
}

impl Usage {
    /// Defends against a malformed/negative token count from a provider silently
    /// corrupting a cumulative credit balance.
    fn clamp(mut self) -> Self {
        self.prompt_tokens = non_negative(self.prompt_tokens);
        self.completion_tokens = non_negative(self.completion_tokens);
        self.total_tokens = non_negative(self.total_tokens);
        self.prompt_cache_hit_tokens = non_negative(self.prompt_cache_hit_tokens);
        self.prompt_cache_miss_tokens = non_negative(self.prompt_cache_miss_tokens);
        self.prompt_cache_write_tokens = non_negative(self.prompt_cache_write_tokens);
        self
    }

    /// The credit-weighted token total, before any rounding.
    ///
    /// Falls back gracefully as less usage detail is available:
    ///
    /// 1. cache breakdown reported (any bucket > 0, e.g. DeepSeek): bill each bucket
    ///    at its own rate -- the accurate, cache-aware path;
    /// 2. no cache breakdown, but prompt/completion reported separately (true for
    ///    every OpenAI-compatible provider): bill each at its own rate instead of
    ///    collapsing to one, which alone fixes output-heavy requests being
    ///    mis-charged when input and output prices differ;
    /// 3. only a bare `total_tokens`: bill it all at the input rate, identical to
    ///    the original pre-cache-aware behaviour.
    fn weighted(self, rates: ModelRates) -> f64 {
        let u = self.clamp();
        if u.prompt_cache_hit_tokens > 0
            || u.prompt_cache_miss_tokens > 0
            || u.prompt_cache_write_tokens > 0
        {
            return u.prompt_cache_miss_tokens as f64 * rates.input
                + u.prompt_cache_hit_tokens as f64 * rates.cache_read
                + u.prompt_cache_write_tokens as f64 * rates.cache_write
                + u.completion_tokens as f64 * rates.output;
        }
        if u.prompt_tokens > 0 || u.completion_tokens > 0 {
            return u.prompt_tokens as f64 * rates.input
                + u.completion_tokens as f64 * rates.output;
        }
        u.total_tokens as f64 * rates.input
    }
}

/// Converts a token count into whole credits:
/// `ceil(total / 1_000_000 * baseline * multiplier)`.
///
/// Any positive usage costs at least 1 credit (ceil); zero tokens cost nothing.
/// This is the single-rate primitive, kept for display paths; the actual charge
/// goes through [`billable_tokens`], which prices each bucket independently.
pub fn for_tokens(total_tokens: i64, baseline_credits_per_1m: i64, multiplier: f64) -> i64 {
    let total_tokens = non_negative(total_tokens);
    if total_tokens <= 0 || baseline_credits_per_1m <= 0 || multiplier <= 0.0 {
        return 0;
    }
    (total_tokens as f64 / 1_000_000.0 * baseline_credits_per_1m as f64 * multiplier).ceil() as i64
}

/// Converts a provider's token usage into whole credits using per-bucket rates.
///
/// Rounds UP, so any positive usage costs at least one credit.
pub fn for_usage(u: Usage, baseline_credits_per_1m: i64, rates: ModelRates) -> i64 {
    let billable = u.weighted(rates);
    if billable <= 0.0 || baseline_credits_per_1m <= 0 {
        return 0;
    }
    (billable / 1_000_000.0 * baseline_credits_per_1m as f64).ceil() as i64
}

/// The FINE-GRAINED billing unit: the credit-weighted token count for one request.
///
/// Unlike [`for_usage`] it does NOT divide by 1M or round up to a whole credit, so
/// a tiny turn costs its TRUE fractional share instead of a full coarse credit.
/// The gateway accumulates this; credits are derived by dividing by
/// [`tokens_per_credit`].
///
/// This is the fix for "a 'hi' turn burned a whole 1M-token credit": with
/// 1 credit = 1M tokens, ceil-to-whole-credit charged 1M tokens for a ~10k-token
/// turn, and again for each per-turn side query.
pub fn billable_tokens(u: Usage, rates: ModelRates) -> i64 {
    let billable = u.weighted(rates);
    if billable <= 0.0 {
        return 0;
    }
    billable.round() as i64
}

/// The pre-flight billable-token hold: the raw token estimate weighted by the
/// model's input multiplier.
///
/// The real input/output/cache split isn't known until the upstream responds, so
/// settle reconciles to [`billable_tokens`] afterwards. At least 1, so a
/// reservation always claims a slot.
pub fn estimate_billable_tokens(est_tokens: i64, input_multiplier: f64) -> i64 {
    let est_tokens = est_tokens.max(0);
    let b = (est_tokens as f64 * input_multiplier).round() as i64;
    b.max(1)
}

/// How many billable tokens equal one credit, from the admin's
/// `baselineCreditsPer1M` (credits charged per 1M tokens at multiplier 1).
///
/// Defaults to 1M when unset. `credits = billable_tokens / tokens_per_credit`.
pub fn tokens_per_credit(baseline_credits_per_1m: i64) -> i64 {
    if baseline_credits_per_1m <= 0 {
        return 1_000_000;
    }
    (1_000_000.0 / baseline_credits_per_1m as f64).round() as i64
}

/// Converts billable tokens to whole credits for the audit ledger.
///
/// Rounds to nearest; a non-positive `tokens_per_credit` passes the value through
/// rather than dividing by zero.
pub fn credits_from_billable(billable: i64, tokens_per_credit: i64) -> i64 {
    if tokens_per_credit <= 0 {
        return billable;
    }
    (billable as f64 / tokens_per_credit as f64).round() as i64
}

/// The default `max_tokens` assumed when a request does not set one.
pub const DEFAULT_MAX_TOKENS: i64 = 2048;

/// Makes a conservative token estimate for the pre-flight reserve, from the prompt
/// size (~4 chars/token) plus the requested `max_tokens`.
///
/// Deliberately narrow, matching Go exactly: only `messages` is walked -- string
/// content and the `text` field of block parts -- and length is measured in BYTES,
/// not characters. `system` and `tools` are NOT counted. The settle step corrects
/// to actuals, so a low estimate costs only a slightly larger reconciliation.
pub fn estimate_tokens(req: &serde_json::Value, default_max_tokens: i64) -> i64 {
    let mut prompt_chars: usize = 0;
    if let Some(msgs) = req.get("messages").and_then(|v| v.as_array()) {
        for m in msgs {
            let Some(content) = m.get("content") else {
                continue;
            };
            match content {
                serde_json::Value::String(s) => prompt_chars += s.len(),
                serde_json::Value::Array(parts) => {
                    for part in parts {
                        if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                            prompt_chars += t.len();
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let input_tokens = (prompt_chars / 4) as i64;
    // Go reads max_tokens via a float64 type assertion, so a non-numeric or
    // non-positive value falls back to the default.
    let max_tok = req
        .get("max_tokens")
        .and_then(|v| v.as_f64())
        .filter(|mt| *mt > 0.0)
        .map(|mt| mt as i64)
        .unwrap_or(default_max_tokens);

    (input_tokens + max_tok).max(1)
}

/// RAYU's own cost for one request in cents (not what the user is charged).
///
/// Fresh input tokens at full price plus cache reads at the discounted fraction,
/// plus completion tokens. The per-bucket [`ModelRates`] are reused purely as a
/// discount RATIO (`cache_read / input`) so the internal cost ledger tracks what
/// the provider actually charged Rayu -- for whatever cache-read rate this model is
/// configured with -- instead of a hardcoded constant that could drift from what
/// the user was billed.
///
/// `fresh_input + cache_read` always equals the provider's `prompt_tokens`, so no
/// input token is missed or double-counted.
pub fn real_cost_cents(
    input_price_per_1m_cents: i64,
    output_price_per_1m_cents: i64,
    fresh_input_tokens: i64,
    cache_read_tokens: i64,
    completion_tokens: i64,
    rates: ModelRates,
) -> i64 {
    let cache_read_fraction = if rates.input > 0.0 {
        rates.cache_read / rates.input
    } else {
        1.0
    };
    let billable_input = fresh_input_tokens as f64 + cache_read_tokens as f64 * cache_read_fraction;
    let cost = billable_input / 1e6 * input_price_per_1m_cents as f64
        + completion_tokens as f64 / 1e6 * output_price_per_1m_cents as f64;
    cost.round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The four admin charges are used verbatim, with fallbacks only for
    /// unconfigured values.
    #[test]
    fn model_rates_for_fallbacks() {
        // Fully configured: nothing is derived.
        let r = model_rates_for(1.0, 2.0, 0.05, 1.25);
        assert_eq!(
            r,
            ModelRates {
                input: 1.0,
                output: 2.0,
                cache_read: 0.05,
                cache_write: 1.25
            }
        );

        // A non-positive output or cache-write charge falls back to input, so a
        // partially-filled row can never bill at zero.
        let r = model_rates_for(0.5, 0.0, 0.02, 0.0);
        assert_eq!(r.output, 0.5);
        assert_eq!(r.cache_write, 0.5);
        let r = model_rates_for(0.5, -3.0, 0.02, -1.0);
        assert_eq!(r.output, 0.5);
        assert_eq!(r.cache_write, 0.5);

        // A NEGATIVE cache-read charge falls back to the default weight...
        let r = model_rates_for(1.0, 2.0, -1.0, 1.0);
        assert_eq!(r.cache_read, CACHE_HIT_BILLING_WEIGHT);
        // ...but a configured ZERO means "cache hits are free" and is honoured.
        // This asymmetry (< 0 vs <= 0) is deliberate and copied from Go.
        let r = model_rates_for(1.0, 2.0, 0.0, 1.0);
        assert_eq!(r.cache_read, 0.0);

        // A negative input charge is clamped to zero, and the fallbacks follow it.
        let r = model_rates_for(-2.0, 0.0, -1.0, 0.0);
        assert_eq!(r.input, 0.0);
        assert_eq!(r.output, 0.0);
        assert_eq!(r.cache_write, 0.0);
        assert_eq!(r.cache_read, CACHE_HIT_BILLING_WEIGHT);
    }

    #[test]
    fn for_tokens_rounds_up_and_guards_its_inputs() {
        // 1M tokens at baseline 1000, multiplier 1 -> 1000 credits.
        assert_eq!(for_tokens(1_000_000, 1000, 1.0), 1000);
        // Any positive usage costs at least one credit.
        assert_eq!(for_tokens(1, 1000, 1.0), 1);
        assert_eq!(for_tokens(1000, 1, 1.0), 1);
        // Zero or unusable inputs cost nothing.
        assert_eq!(for_tokens(0, 1000, 1.0), 0);
        assert_eq!(for_tokens(-5, 1000, 1.0), 0);
        assert_eq!(for_tokens(1_000_000, 0, 1.0), 0);
        assert_eq!(for_tokens(1_000_000, -1, 1.0), 0);
        assert_eq!(for_tokens(1_000_000, 1000, 0.0), 0);
        assert_eq!(for_tokens(1_000_000, 1000, -1.0), 0);
        // The multiplier scales linearly.
        assert_eq!(for_tokens(1_000_000, 1000, 0.33), 330);
    }

    /// The bucket-selection order is what makes billing accurate for providers with
    /// and without cache reporting.
    #[test]
    fn billable_tokens_bucket_selection_order() {
        let rates = model_rates_for(1.0, 2.0, 0.1, 1.0);

        // 1. Any cache bucket present -> per-bucket pricing.
        let u = Usage {
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            prompt_cache_hit_tokens: 900,
            prompt_cache_miss_tokens: 100,
            prompt_cache_write_tokens: 0,
        };
        // 100*1 + 900*0.1 + 0*1 + 100*2 = 100 + 90 + 200 = 390
        assert_eq!(billable_tokens(u, rates), 390);

        // 2. No cache breakdown -> prompt and completion at their own rates. The
        // prompt total is used, NOT the cache buckets.
        let u = Usage {
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            ..Default::default()
        };
        // 1000*1 + 100*2 = 1200
        assert_eq!(billable_tokens(u, rates), 1200);

        // 3. Only a bare total -> everything at the input rate.
        let u = Usage {
            total_tokens: 500,
            ..Default::default()
        };
        assert_eq!(billable_tokens(u, rates), 500);

        // Nothing reported at all costs nothing.
        assert_eq!(billable_tokens(Usage::default(), rates), 0);
    }

    /// A cache-write bucket alone is enough to select the per-bucket path.
    #[test]
    fn billable_tokens_cache_write_selects_the_bucket_path() {
        let rates = model_rates_for(1.0, 2.0, 0.1, 1.5);
        let u = Usage {
            prompt_tokens: 1000,
            completion_tokens: 0,
            total_tokens: 1000,
            prompt_cache_write_tokens: 1000,
            ..Default::default()
        };
        // miss=0, hit=0, write=1000 -> 1000*1.5 = 1500. The 1000 prompt_tokens are
        // deliberately NOT added: the buckets replace them.
        assert_eq!(billable_tokens(u, rates), 1500);
    }

    #[test]
    fn negative_provider_counts_are_clamped() {
        let rates = model_rates_for(1.0, 1.0, 0.1, 1.0);
        let u = Usage {
            prompt_tokens: -1000,
            completion_tokens: -50,
            total_tokens: -100,
            prompt_cache_hit_tokens: -10,
            prompt_cache_miss_tokens: -10,
            prompt_cache_write_tokens: -10,
        };
        // Every bucket clamps to 0, so nothing is billed and nothing is subtracted
        // from a cumulative counter.
        assert_eq!(billable_tokens(u, rates), 0);
        assert_eq!(for_usage(u, 1000, rates), 0);
    }

    #[test]
    fn for_usage_rounds_up_where_billable_tokens_rounds_to_nearest() {
        let rates = model_rates_for(1.0, 1.0, 0.1, 1.0);
        let u = Usage {
            total_tokens: 1,
            ..Default::default()
        };
        // for_usage: ceil(1/1e6 * 1000) = ceil(0.001) = 1 whole credit.
        assert_eq!(for_usage(u, 1000, rates), 1);
        // billable_tokens keeps the fine-grained token count instead.
        assert_eq!(billable_tokens(u, rates), 1);

        // A zero baseline means no credits can be computed.
        assert_eq!(for_usage(u, 0, rates), 0);
    }

    /// Rust's `f64::round` and Go's `math.Round` both round half AWAY FROM ZERO
    /// (not banker's rounding), which is what keeps the settle numbers identical.
    #[test]
    fn rounding_is_half_away_from_zero() {
        let rates = ModelRates {
            input: 0.5,
            output: 0.5,
            cache_read: 0.5,
            cache_write: 0.5,
        };
        // 1 token * 0.5 = 0.5 -> rounds to 1, not 0.
        let u = Usage {
            total_tokens: 1,
            ..Default::default()
        };
        assert_eq!(billable_tokens(u, rates), 1);
        // 3 tokens * 0.5 = 1.5 -> rounds to 2, not 2-by-luck or 1 by banker's.
        let u = Usage {
            total_tokens: 3,
            ..Default::default()
        };
        assert_eq!(billable_tokens(u, rates), 2);
        // 5 * 0.5 = 2.5 -> 3 (banker's rounding would give 2).
        let u = Usage {
            total_tokens: 5,
            ..Default::default()
        };
        assert_eq!(billable_tokens(u, rates), 3);
    }

    #[test]
    fn estimate_billable_tokens_floors_at_one() {
        assert_eq!(estimate_billable_tokens(1000, 1.0), 1000);
        assert_eq!(estimate_billable_tokens(1000, 0.33), 330);
        // Rounds to nearest.
        assert_eq!(estimate_billable_tokens(3, 0.5), 2); // 1.5 -> 2
                                                         // Never zero: a reservation must always claim a slot.
        assert_eq!(estimate_billable_tokens(0, 1.0), 1);
        assert_eq!(estimate_billable_tokens(1000, 0.0), 1);
        assert_eq!(estimate_billable_tokens(-100, 1.0), 1);
    }

    #[test]
    fn tokens_per_credit_defaults_and_rounds() {
        assert_eq!(tokens_per_credit(1000), 1000);
        assert_eq!(tokens_per_credit(1), 1_000_000);
        assert_eq!(tokens_per_credit(1_000_000), 1);
        // Unset or nonsense -> 1M tokens per credit.
        assert_eq!(tokens_per_credit(0), 1_000_000);
        assert_eq!(tokens_per_credit(-5), 1_000_000);
        // 1e6/3 = 333333.33 -> rounds to nearest.
        assert_eq!(tokens_per_credit(3), 333_333);
        // 1e6/7 = 142857.14
        assert_eq!(tokens_per_credit(7), 142_857);
    }

    #[test]
    fn credits_from_billable_rounds_and_guards_division() {
        assert_eq!(credits_from_billable(1000, 1000), 1);
        assert_eq!(credits_from_billable(1500, 1000), 2); // 1.5 -> 2
        assert_eq!(credits_from_billable(1400, 1000), 1); // 1.4 -> 1
        assert_eq!(credits_from_billable(0, 1000), 0);
        // A non-positive divisor passes the value through rather than dividing by 0.
        assert_eq!(credits_from_billable(1234, 0), 1234);
        assert_eq!(credits_from_billable(1234, -1), 1234);
    }

    /// `estimate_tokens` is deliberately narrow: messages only, byte length, and
    /// `max_tokens` added on top.
    #[test]
    fn estimate_tokens_counts_messages_only() {
        // 8 bytes of content -> 8/4 = 2 input tokens, plus the default 2048.
        let req = json!({"messages": [{"role": "user", "content": "12345678"}]});
        assert_eq!(estimate_tokens(&req, DEFAULT_MAX_TOKENS), 2 + 2048);

        // Block parts contribute their `text` field.
        let req = json!({"messages": [{"role": "user", "content": [
            {"type": "text", "text": "1234"},
            {"type": "text", "text": "5678"},
        ]}]});
        assert_eq!(estimate_tokens(&req, DEFAULT_MAX_TOKENS), 2 + 2048);

        // An explicit max_tokens replaces the default.
        let req = json!({"messages": [{"role": "user", "content": "1234"}], "max_tokens": 100});
        assert_eq!(estimate_tokens(&req, DEFAULT_MAX_TOKENS), 1 + 100);

        // A non-positive or non-numeric max_tokens falls back to the default.
        for bad in [json!(0), json!(-5), json!("100"), json!(null)] {
            let req = json!({"messages": [{"role": "user", "content": "1234"}], "max_tokens": bad});
            assert_eq!(estimate_tokens(&req, DEFAULT_MAX_TOKENS), 1 + 2048, "{bad}");
        }

        // No messages at all still costs the max_tokens hold.
        assert_eq!(estimate_tokens(&json!({}), DEFAULT_MAX_TOKENS), 2048);
        // Floors at 1 even with nothing to go on.
        assert_eq!(estimate_tokens(&json!({}), 0), 1);
    }

    /// `system` and `tools` are NOT counted -- a quirk of the Go original that the
    /// settle step compensates for. Pinned so a future "improvement" is a conscious
    /// decision rather than an accident.
    #[test]
    fn estimate_tokens_ignores_system_and_tools_like_go() {
        let req = json!({
            "system": "a very long system prompt that would add many tokens",
            "tools": [{"name": "bash", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "1234"}],
        });
        assert_eq!(estimate_tokens(&req, DEFAULT_MAX_TOKENS), 1 + 2048);
    }

    /// Length is measured in BYTES, so multi-byte text estimates higher than its
    /// character count -- which errs on the safe side.
    #[test]
    fn estimate_tokens_measures_bytes_not_chars() {
        // 4 chars, 12 bytes in UTF-8.
        let req = json!({"messages": [{"role": "user", "content": "日本語だ"}]});
        assert_eq!(estimate_tokens(&req, 0), 12 / 4);
    }

    #[test]
    fn estimate_tokens_tolerates_malformed_messages() {
        // Non-array messages, non-object entries, missing content, and a non-string
        // content are all skipped rather than panicking.
        for req in [
            json!({"messages": "not an array"}),
            json!({"messages": [42, null, "text"]}),
            json!({"messages": [{"role": "user"}]}),
            json!({"messages": [{"role": "user", "content": 42}]}),
            json!({"messages": [{"role": "user", "content": [{"type": "image"}]}]}),
        ] {
            assert_eq!(estimate_tokens(&req, 10), 10, "{req}");
        }
    }

    #[test]
    fn real_cost_cents_discounts_cache_reads() {
        // input charge 1.0, cache-read charge 0.1 -> cache reads cost 10% of fresh.
        let rates = model_rates_for(1.0, 2.0, 0.1, 1.0);
        // 1M fresh input at 100c/1M = 100c; no cache, no output.
        assert_eq!(real_cost_cents(100, 200, 1_000_000, 0, 0, rates), 100);
        // 1M cache reads at the 10% fraction = 10c.
        assert_eq!(real_cost_cents(100, 200, 0, 1_000_000, 0, rates), 10);
        // Output priced separately.
        assert_eq!(real_cost_cents(100, 200, 0, 0, 1_000_000, rates), 200);
        // Combined, rounded to the nearest cent.
        assert_eq!(
            real_cost_cents(100, 200, 500_000, 500_000, 100_000, rates),
            (50.0 + 5.0 + 20.0f64).round() as i64
        );
        // A zero input charge cannot divide: the fraction falls back to 1.0, so a
        // cache read costs full price rather than crashing.
        let free = ModelRates {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
        };
        assert_eq!(real_cost_cents(100, 200, 0, 1_000_000, 0, free), 100);
        // Nothing consumed costs nothing.
        assert_eq!(real_cost_cents(100, 200, 0, 0, 0, rates), 0);
    }

    /// The invariant the cost ledger depends on: fresh + cache-read always equals
    /// the provider's prompt total, so no input token is billed twice or dropped.
    #[test]
    fn fresh_plus_cache_read_reconciles_to_the_prompt_total() {
        let rates = model_rates_for(1.0, 2.0, 0.1, 1.0);
        for (fresh, cached) in [(1000, 0), (0, 1000), (600, 400), (1, 999)] {
            let prompt = fresh + cached;
            let u = Usage {
                prompt_tokens: prompt,
                completion_tokens: 0,
                total_tokens: prompt,
                prompt_cache_hit_tokens: cached,
                prompt_cache_miss_tokens: fresh,
                prompt_cache_write_tokens: 0,
            };
            let billed = billable_tokens(u, rates);
            let expected = (fresh as f64 * 1.0 + cached as f64 * 0.1).round() as i64;
            assert_eq!(billed, expected, "fresh={fresh} cached={cached}");
        }
    }

    /// PARITY: every expected value below was produced by RUNNING the Go
    /// implementation's own arithmetic (`math.Round` / `math.Ceil` on the same
    /// float expressions) and is pinned here verbatim.
    ///
    /// This is the one module where a rounding disagreement would silently
    /// mis-bill customers rather than fail loudly, so the numbers are asserted
    /// against Go rather than against my reading of Go.
    #[test]
    fn arithmetic_matches_go_exactly() {
        // --- BillableTokens on half-boundaries (rate 0.5, total-only path) -----
        // Both languages round half AWAY FROM ZERO, so 1.5 -> 2 and 2.5 -> 3.
        // Banker's rounding would give 2 and 2, which is where a naive port drifts.
        let half = ModelRates {
            input: 0.5,
            output: 0.5,
            cache_read: 0.5,
            cache_write: 0.5,
        };
        for (total, want) in [(1, 1), (3, 2), (5, 3), (7, 4), (9, 5), (11, 6), (101, 51)] {
            let u = Usage {
                total_tokens: total,
                ..Default::default()
            };
            assert_eq!(billable_tokens(u, half), want, "total={total}");
        }

        // --- BillableTokens bucket paths --------------------------------------
        let r = model_rates_for(1.0, 2.0, 0.1, 1.0);
        assert_eq!(
            billable_tokens(
                Usage {
                    prompt_tokens: 1000,
                    completion_tokens: 100,
                    total_tokens: 1100,
                    prompt_cache_hit_tokens: 900,
                    prompt_cache_miss_tokens: 100,
                    prompt_cache_write_tokens: 0,
                },
                r
            ),
            390
        );
        assert_eq!(
            billable_tokens(
                Usage {
                    prompt_tokens: 1000,
                    completion_tokens: 100,
                    total_tokens: 1100,
                    ..Default::default()
                },
                r
            ),
            1200
        );
        assert_eq!(
            billable_tokens(
                Usage {
                    total_tokens: 500,
                    ..Default::default()
                },
                r
            ),
            500
        );
        assert_eq!(
            billable_tokens(
                Usage {
                    prompt_tokens: 1000,
                    total_tokens: 1000,
                    prompt_cache_write_tokens: 1000,
                    ..Default::default()
                },
                model_rates_for(1.0, 2.0, 0.1, 1.5)
            ),
            1500
        );

        // --- EstimateBillableTokens -------------------------------------------
        for (est, mult, want) in [
            (1000, 1.0, 1000),
            (1000, 0.33, 330),
            (3, 0.5, 2),
            (5, 0.5, 3),
            (0, 1.0, 1),
            (-100, 1.0, 1),
            (1000, 0.0, 1),
        ] {
            assert_eq!(
                estimate_billable_tokens(est, mult),
                want,
                "est={est} mult={mult}"
            );
        }

        // --- TokensPerCredit ---------------------------------------------------
        for (baseline, want) in [
            (1000, 1000),
            (1, 1_000_000),
            (1_000_000, 1),
            (0, 1_000_000),
            (-5, 1_000_000),
            (3, 333_333),
            (7, 142_857),
            (333, 3003),
            (999, 1001),
        ] {
            assert_eq!(tokens_per_credit(baseline), want, "baseline={baseline}");
        }

        // --- creditsFromBillable ----------------------------------------------
        for (billable, tpc, want) in [
            (1000, 1000, 1),
            (1500, 1000, 2),
            (1400, 1000, 1),
            (500, 1000, 1),  // 0.5 rounds up
            (2500, 1000, 3), // 2.5 rounds up
            (0, 1000, 0),
            (1234, 0, 1234),
            (1234, -1, 1234),
        ] {
            assert_eq!(
                credits_from_billable(billable, tpc),
                want,
                "billable={billable} tpc={tpc}"
            );
        }

        // --- ForTokens ---------------------------------------------------------
        assert_eq!(for_tokens(1_000_000, 1000, 1.0), 1000);
        assert_eq!(for_tokens(1, 1000, 1.0), 1);
        assert_eq!(for_tokens(1_000_000, 1000, 0.33), 330);

        // --- realCostCents -----------------------------------------------------
        assert_eq!(real_cost_cents(100, 200, 1_000_000, 0, 0, r), 100);
        assert_eq!(real_cost_cents(100, 200, 0, 1_000_000, 0, r), 10);
        assert_eq!(real_cost_cents(100, 200, 0, 0, 1_000_000, r), 200);
        assert_eq!(real_cost_cents(100, 200, 500_000, 500_000, 100_000, r), 75);
        // A zero input charge cannot form a discount ratio, so the fraction falls
        // back to 1.0 and a cache read costs full price.
        let zero = ModelRates {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
        };
        assert_eq!(real_cost_cents(100, 200, 0, 1_000_000, 0, zero), 100);
    }
}
