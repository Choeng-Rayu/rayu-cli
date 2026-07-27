-- Credit top-up: express the rate the way an admin (and a buyer) thinks about it.
--
-- BEFORE: topupCentsPer1kCredits — "cents per 1000 credits". Nobody buys credits
-- in fixed 1k blocks, the number had no natural minimum, and the UI had to invert
-- it to answer the only question that matters: "what do I get for $1?".
--
-- AFTER:
--   creditsPerDollar — how many credits $1 buys (0 = top-up unavailable)
--   minTopupCents    — smallest purchase, default 100 (= $1)
--
-- The backfill is exact and value-preserving: X cents per 1000 credits means
-- $1 (100¢) buys 1000 * 100 / X credits, i.e. 100000 / X. A rate of 0 (top-up
-- disabled) stays 0, so no plan silently gains a purchasable top-up.
ALTER TABLE `app_settings`
  ADD COLUMN `creditsPerDollar` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `minTopupCents` INTEGER NOT NULL DEFAULT 100;

UPDATE `app_settings`
   SET `creditsPerDollar` = ROUND(100000 / `topupCentsPer1kCredits`)
 WHERE `topupCentsPer1kCredits` > 0;

ALTER TABLE `app_settings` DROP COLUMN `topupCentsPer1kCredits`;
