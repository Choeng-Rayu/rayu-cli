-- Explicit, admin-entered credit charges per model + a tools capability flag.
--
-- Until now only the INPUT charge was stored: the gateway DERIVED the output
-- charge from the cost-price ratio (`creditMultiplier × outputPrice/inputPrice`)
-- and fell back to global defaults for the cache buckets. That coupled what a
-- customer pays to Rayu's own cost figures — editing a cost price silently
-- changed billing — and left two of the four charges invisible in the dashboard.
--
-- Now all four are stored and used verbatim. The backfill below reproduces each
-- model's CURRENT effective rate exactly, so no bill changes at migration time:
--   output     = creditMultiplier × outputPrice/inputPrice   (when both > 0)
--              = creditMultiplier                            (otherwise)
--   cacheRead  = COALESCE(existing, 0.10)   -- the gateway's CacheHitBillingWeight
--   cacheWrite = COALESCE(existing, creditMultiplier)  -- no premium by default
ALTER TABLE `hosted_models`
  ADD COLUMN `outputCreditMultiplier` DOUBLE NOT NULL DEFAULT 1,
  ADD COLUMN `supportsTools` BOOLEAN NOT NULL DEFAULT true;

UPDATE `hosted_models`
  SET `outputCreditMultiplier` =
    CASE
      WHEN `inputPricePer1MCents` > 0 AND `outputPricePer1MCents` > 0
        THEN `creditMultiplier` * `outputPricePer1MCents` / `inputPricePer1MCents`
      ELSE `creditMultiplier`
    END;

-- Fill the cache buckets BEFORE tightening them to NOT NULL, so no row is lost.
UPDATE `hosted_models`
  SET `cacheReadCreditMultiplier` = COALESCE(`cacheReadCreditMultiplier`, 0.1),
      `cacheWriteCreditMultiplier` = COALESCE(`cacheWriteCreditMultiplier`, `creditMultiplier`);

ALTER TABLE `hosted_models`
  MODIFY COLUMN `cacheReadCreditMultiplier` DOUBLE NOT NULL DEFAULT 0.1,
  MODIFY COLUMN `cacheWriteCreditMultiplier` DOUBLE NOT NULL DEFAULT 1;
