//! Pay-as-you-go top-up quoting.
//!
//! Port of the Go gateway's `internal/credits/topup.go`.
//!
//! The gateway quotes a price so the CLI does not need a backend round trip (the
//! `app_settings` schema comment says exactly this: "the gateway reads both so the
//! CLI can quote a price without calling the backend"), but it deliberately does
//! NOT grant credits -- granting stays in the backend's `activatePaid` so there is a
//! single write path.
//!
//! Every number below is derived from the admin's live `app_settings` values
//! (`creditsPerDollar` / `minTopupCents`). Nothing here hardcodes a rate;
//! [`MAX_TOPUP_CREDITS`] is an anti-abuse validation bound that mirrors the
//! backend's `CreateTopupDto` maximum, not a price.

/// The ceiling on one purchase, mirroring the backend's `TOPUP_MAX_CREDITS` so a
/// client clamping against the gateway quote cannot build a request the backend
/// would reject.
pub const MAX_TOPUP_CREDITS: i64 = 100_000_000;

/// The wire shape of `GET /v1/credits/topup/quote`.
///
/// Field-for-field identical to the backend's `GET /payments/topup/quote` so a
/// client can use either interchangeably.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TopupQuote {
    /// False when the admin has not turned top-up on (`creditsPerDollar = 0`); the
    /// client should hide the top-up UI.
    pub enabled: bool,
    /// The amount this quote prices, clamped to `[min_credits, max_credits]`.
    pub credits: i64,
    /// What those credits cost. 0 when disabled.
    #[serde(rename = "amountCents")]
    pub amount_cents: i64,
    pub currency: String,
    /// The cheapest payable purchase at the current rate.
    #[serde(rename = "minCredits")]
    pub min_credits: i64,
    /// The validation ceiling on one purchase.
    #[serde(rename = "maxCredits")]
    pub max_credits: i64,
    /// Echoes the live settings this quote used, so a client never has to assume
    /// either.
    #[serde(rename = "rateCreditsPerDollar")]
    pub rate_credits_per_dollar: i64,
    #[serde(rename = "minTopupCents")]
    pub min_topup_cents: i64,
    /// Whether the REQUESTED amount already cleared the dollar floor.
    ///
    /// False means it was raised to `min_credits`, so a UI can explain the bump
    /// instead of silently charging more than the user asked for.
    #[serde(rename = "meetsMinimum")]
    pub meets_minimum: bool,
}

/// Whether top-up is available: the admin must have set a positive
/// credits-per-dollar rate. 0 means "unavailable", per the `app_settings` schema.
pub fn topup_enabled(credits_per_dollar: i64) -> bool {
    credits_per_dollar > 0
}

/// The dollar floor, never below 1 cent.
///
/// A free "purchase" has no payment to confirm, so a 0-cent QR would sit pending
/// forever.
pub fn effective_min_topup_cents(min_topup_cents: i64) -> i64 {
    if min_topup_cents < 1 {
        1
    } else {
        min_topup_cents
    }
}

/// Prices a credit amount.
///
/// Rounds UP, matching the backend exactly, so a buyer never receives credits that
/// were not paid for and the quote never undercuts what the backend will charge.
pub fn topup_amount_cents(credits_wanted: i64, credits_per_dollar: i64) -> i64 {
    if !topup_enabled(credits_per_dollar) || credits_wanted <= 0 {
        return 0;
    }
    (credits_wanted as f64 / credits_per_dollar as f64 * 100.0).ceil() as i64
}

/// Converts the cents floor into a credit floor at the CURRENT rate.
///
/// Derived on every quote, never cached: the floor is stored in cents while the
/// client's input is in credits, so a cached value would go stale the moment the
/// admin changed the rate.
pub fn min_topup_credits(credits_per_dollar: i64, min_topup_cents: i64) -> i64 {
    if !topup_enabled(credits_per_dollar) {
        return 0;
    }
    let cents = effective_min_topup_cents(min_topup_cents);
    (cents as f64 / 100.0 * credits_per_dollar as f64).ceil() as i64
}

/// Prices `requested_credits` at the live rate.
///
/// A below-floor request is raised to `min_credits` (flagged via `meets_minimum`)
/// rather than rejected, so the endpoint can always answer with a payable price;
/// the backend still rejects a below-floor CREATE outright, because that charges
/// real money.
///
/// `requested_credits <= 0` means "no amount chosen yet" and yields the cheapest
/// payable purchase, which is what a client needs to render the screen first.
pub fn quote_topup(
    credits_per_dollar: i64,
    min_topup_cents: i64,
    requested_credits: i64,
) -> TopupQuote {
    let min_cents = effective_min_topup_cents(min_topup_cents);

    if !topup_enabled(credits_per_dollar) {
        return TopupQuote {
            enabled: false,
            credits: 0,
            amount_cents: 0,
            currency: "USD".into(),
            min_credits: 0,
            max_credits: MAX_TOPUP_CREDITS,
            rate_credits_per_dollar: 0,
            min_topup_cents: min_cents,
            meets_minimum: false,
        };
    }

    let min_credits = min_topup_credits(credits_per_dollar, min_topup_cents);
    let asked = if requested_credits <= 0 {
        min_credits
    } else {
        requested_credits
    };
    let meets_minimum = asked >= min_credits;
    let credits = asked.clamp(min_credits, MAX_TOPUP_CREDITS);

    TopupQuote {
        enabled: true,
        credits,
        amount_cents: topup_amount_cents(credits, credits_per_dollar),
        currency: "USD".into(),
        min_credits,
        max_credits: MAX_TOPUP_CREDITS,
        rate_credits_per_dollar: credits_per_dollar,
        min_topup_cents: min_cents,
        meets_minimum,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every case feeds the rate in as DATA. If any of these could pass with a rate
    // baked into the module, the module would be hardcoding a price -- which is the
    // one thing the top-up design forbids.

    #[test]
    fn topup_enabled_is_off_at_rate_zero() {
        for (name, rate, want) in [
            ("admin has not enabled top-up", 0, false),
            ("nonsense negative rate", -5, false),
            ("smallest positive rate", 1, true),
            ("typical rate", 1000, true),
        ] {
            assert_eq!(topup_enabled(rate), want, "{name}");
        }
    }

    #[test]
    fn effective_min_topup_cents_never_allows_a_free_purchase() {
        for (name, given, want) in [
            ("admin floor used verbatim", 250, 250),
            ("default floor", 100, 100),
            // A 0-cent purchase has no payment to confirm, so the QR would sit
            // pending forever -- clamp to 1 cent instead.
            ("zero clamps to one cent", 0, 1),
            ("negative clamps to one cent", -100, 1),
        ] {
            assert_eq!(effective_min_topup_cents(given), want, "{name}");
        }
    }

    #[test]
    fn topup_amount_cents_rounds_up() {
        for (name, credits, rate, want) in [
            ("exact dollar", 1000, 1000, 100),
            ("five dollars", 5000, 1000, 500),
            // 5 credits at 3/$ is $1.6667: must be 167c, not 166c, or the buyer
            // gets credits they did not pay for.
            ("rounds up, never down", 5, 3, 167),
            ("disabled prices at zero", 5000, 0, 0),
            ("zero credits cost nothing", 0, 1000, 0),
        ] {
            assert_eq!(topup_amount_cents(credits, rate), want, "{name}");
        }
    }

    #[test]
    fn min_topup_credits_is_derived_from_the_live_rate() {
        for (name, rate, floor, want) in [
            ("$1 floor at 1000/$", 1000, 100, 1000),
            ("$2.50 floor at 1000/$", 1000, 250, 2500),
            ("$1 floor at 5/$", 5, 100, 5),
            ("1c floor at 1000/$ rounds up", 1000, 1, 10),
            ("disabled has no floor", 0, 100, 0),
        ] {
            assert_eq!(min_topup_credits(rate, floor), want, "{name}");
        }
    }

    /// Buying exactly `min_credits` must always cost at least the floor. If rounding
    /// went the other way anywhere, the backend would reject a purchase the gateway
    /// just told the client was the minimum.
    #[test]
    fn min_topup_credits_always_clears_the_floor() {
        for rate in [1, 3, 5, 7, 100, 999, 1000] {
            for floor in [1, 50, 100, 250, 999] {
                let credits = min_topup_credits(rate, floor);
                let cents = topup_amount_cents(credits, rate);
                let min_cents = effective_min_topup_cents(floor);
                assert!(
                    cents >= min_cents,
                    "rate={rate} floor={floor}: minCredits={credits} costs {cents}c, \
                     below the {min_cents}c floor"
                );
            }
        }
    }

    #[test]
    fn quote_prices_from_the_live_rate() {
        let q = quote_topup(1000, 100, 5000);
        assert!(q.enabled);
        assert_eq!(q.credits, 5000);
        assert_eq!(q.amount_cents, 500);
        // The rate and floor are echoed so a client never has to assume one.
        assert_eq!(q.rate_credits_per_dollar, 1000);
        assert_eq!(q.min_topup_cents, 100);
        assert_eq!(q.min_credits, 1000);
        assert_eq!(q.max_credits, MAX_TOPUP_CREDITS);
        assert_eq!(q.currency, "USD");
        assert!(q.meets_minimum);
    }

    /// An admin rate change must re-price with no code change and no redeploy -- the
    /// whole point of keeping the rate in `app_settings`.
    #[test]
    fn quote_reprices_when_the_admin_changes_the_rate() {
        let before = quote_topup(1000, 100, 5000);
        let after = quote_topup(500, 100, 5000);
        assert_eq!(before.amount_cents, 500);
        assert_eq!(
            after.amount_cents, 1000,
            "halving the rate doubles the price"
        );
        // And the derived credit floor moves with it, never cached across the change.
        assert_eq!(before.min_credits, 1000);
        assert_eq!(after.min_credits, 500);
    }

    #[test]
    fn quote_clamps_to_the_floor_and_flags_the_bump() {
        let q = quote_topup(1000, 100, 10);
        assert!(
            !q.meets_minimum,
            "a below-floor request must be flagged, not silently charged"
        );
        assert_eq!(q.credits, 1000);
        assert_eq!(q.amount_cents, 100);
    }

    #[test]
    fn quote_defaults_to_the_cheapest_payable_amount() {
        for asked in [0, -1] {
            let q = quote_topup(1000, 100, asked);
            assert_eq!(q.credits, 1000, "asked={asked}");
            assert_eq!(q.amount_cents, 100, "asked={asked}");
            // "No amount chosen yet" is not a failure to meet the minimum.
            assert!(q.meets_minimum, "asked={asked}");
        }
    }

    #[test]
    fn quote_caps_at_the_abuse_ceiling() {
        let q = quote_topup(1000, 100, MAX_TOPUP_CREDITS * 10);
        assert_eq!(q.credits, MAX_TOPUP_CREDITS);
        // The clamp happens before pricing, so the amount matches the capped credits.
        assert_eq!(q.amount_cents, topup_amount_cents(MAX_TOPUP_CREDITS, 1000));
    }

    /// Rate 0 means the admin switched top-up off. The client must be told that
    /// explicitly rather than shown a $0 price it might try to buy.
    #[test]
    fn quote_reports_disabled_rather_than_a_free_price() {
        let q = quote_topup(0, 100, 5000);
        assert!(!q.enabled);
        assert_eq!(q.credits, 0);
        assert_eq!(q.amount_cents, 0);
        assert_eq!(q.min_credits, 0);
        assert_eq!(q.rate_credits_per_dollar, 0);
        // The currency and ceiling are still reported so the client can render.
        assert_eq!(q.currency, "USD");
        assert_eq!(q.max_credits, MAX_TOPUP_CREDITS);
    }

    /// The JSON field names are a contract with the CLI and the dashboard, which
    /// share this shape with the backend's own quote endpoint.
    #[test]
    fn quote_json_field_names() {
        let json = serde_json::to_value(quote_topup(1000, 100, 5000)).unwrap();
        assert_eq!(json["enabled"], true);
        assert_eq!(json["credits"], 5000);
        assert_eq!(json["amountCents"], 500);
        assert_eq!(json["currency"], "USD");
        assert_eq!(json["minCredits"], 1000);
        assert_eq!(json["maxCredits"], MAX_TOPUP_CREDITS);
        assert_eq!(json["rateCreditsPerDollar"], 1000);
        assert_eq!(json["minTopupCents"], 100);
        assert_eq!(json["meetsMinimum"], true);
    }

    /// PARITY: these values were produced by RUNNING Go's `math.Ceil` on the same
    /// expressions. Pricing rounds up in both directions of the conversion, and an
    /// off-by-one cent here is money.
    #[test]
    fn pricing_matches_go_exactly() {
        for (credits, rate, want) in [
            (1000, 1000, 100),
            (5000, 1000, 500),
            (5, 3, 167),
            (5000, 0, 0),
            (0, 1000, 0),
            (1, 3, 34),  // $0.3333 -> 34c
            (7, 3, 234), // $2.3333 -> 234c
        ] {
            assert_eq!(
                topup_amount_cents(credits, rate),
                want,
                "credits={credits} rate={rate}"
            );
        }

        for (rate, floor, want) in [
            (1000, 100, 1000),
            (1000, 250, 2500),
            (5, 100, 5),
            (1000, 1, 10),
            (0, 100, 0),
            (3, 100, 3),
            (7, 50, 4), // 0.5 * 7 = 3.5 -> ceil 4
        ] {
            assert_eq!(
                min_topup_credits(rate, floor),
                want,
                "rate={rate} floor={floor}"
            );
        }
    }
}
