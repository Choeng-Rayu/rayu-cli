-- Migration: pay-as-you-go credits for TEAMS.
--
-- A team admin could buy a team plan and nothing else, so a pool that ran dry
-- mid-month left only "renew or upgrade". Individuals already have a second
-- path (credit_topups, priced off app_settings.creditsPerDollar); this gives a
-- team the same, funding the shared pool its members draw from.
--
-- WHY A NEW COLUMN RATHER THAN credit_pools.total_credits
-- activateSubscription OVERWRITES total_credits and resets used_credits on every
-- activation and renewal. Purchased credits parked there would be erased (or
-- re-gifted) by the next renewal. Held in their own column, the team's hard cap
-- becomes total + extra, and because used_credits is ONE monotonic counter the
-- plan's allowance is necessarily spent before the purchased credits — the
-- required spend order falls out of the data model, with no second counter and no
-- second Redis key on the request path.
--
-- WHY A NEW TABLE RATHER THAN credit_topups.organization_id
-- The individual balance is DERIVED, in two independent places (the backend's
-- UsersService.getTopupBalance and the gateway's store.TopupBalance):
--   SUM(credit_topups.credits WHERE user_id=? AND status='paid')
--     - SUM(credit_ledger.credits WHERE source='topup')
-- A team purchase written into that table with the paying admin's user_id would
-- silently inflate that admin's PERSONAL spendable balance. Same reasoning that
-- keeps organization_subscriptions separate from subscriptions.
--
-- Strictly ADDITIVE: one defaulted column and one new table. Every existing team
-- is valid as-is with extra_credits = 0, and no existing query changes meaning.

-- AlterTable: purchased credits for the current period. DEFAULT 0 is what makes
-- this safe for existing rows — a team that never bought credits reads exactly
-- as it did before.
ALTER TABLE `credit_pools` ADD COLUMN `extra_credits` INTEGER NOT NULL DEFAULT 0;

-- CreateTable: the purchase record. This is the AUDIT + IDEMPOTENCY row; the
-- spendable number lives in credit_pools.extra_credits. status pending -> paid is
-- guarded on 'pending' so exactly one concurrent confirmation can ever grant.
--
-- target_user_id is the optional "credit this member's own bucket too" choice.
-- The pool is always credited as well, because the pool is the HARD cap: raising
-- a member's bucket alone would hand them a number they could not spend.
CREATE TABLE `organization_credit_topups` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organization_id` INTEGER NOT NULL,
  `purchased_by_id` INTEGER NOT NULL,
  `target_user_id` INTEGER NULL,
  `credits` INTEGER NOT NULL DEFAULT 0,
  `amount_cents` INTEGER NOT NULL DEFAULT 0,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `payment_id` INTEGER NULL,
  `expires_at` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `organization_credit_topups_organization_id_status_idx`(`organization_id`, `status`),
  INDEX `organization_credit_topups_payment_id_idx`(`payment_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organization_credit_topups` ADD CONSTRAINT `organization_credit_topups_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_credit_topups` ADD CONSTRAINT `organization_credit_topups_purchased_by_id_fkey`
  FOREIGN KEY (`purchased_by_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting the targeted member must not erase the purchase — the
-- credits were granted to the TEAM, so the row survives with a null target.
ALTER TABLE `organization_credit_topups` ADD CONSTRAINT `organization_credit_topups_target_user_id_fkey`
  FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
