-- Stripe (card) payment rail.
--
-- Every column added here is NULLABLE and every table is new, so this migration
-- is purely additive: existing ABA / Bakong KHQR / promo rows are untouched and
-- keep validating, and a deployment that never enables STRIPE_ENABLED behaves
-- exactly as it did before.
--
-- Deliberately EXCLUDED from this migration: `prisma migrate diff` also wants to
-- drop `users.githubId` and `users.googleId` (plus the `users_googleId_key`
-- index). That is pre-existing drift between the migration history and
-- schema.prisma, unrelated to Stripe, and dropping columns is irreversible — it
-- is left for a separate, deliberate migration.

-- AlterTable: link a payment to its Stripe objects.
-- `stripe_checkout_session_id` is the webhook's lookup key (a confirmation
-- carries the session, not our payment id). `stripe_payment_intent_id` is how a
-- `charge.refunded` event finds the payment. `stripe_checkout_url` is stored so
-- refreshing checkout hands back the same hosted page without a Stripe round
-- trip, mirroring how `khqr` is reused on the KHQR rails.
ALTER TABLE `payments` ADD COLUMN `stripe_charge_id` VARCHAR(255) NULL,
    ADD COLUMN `stripe_checkout_session_id` VARCHAR(255) NULL,
    ADD COLUMN `stripe_checkout_url` TEXT NULL,
    ADD COLUMN `stripe_payment_intent_id` VARCHAR(255) NULL;

-- AlterTable: recurring-billing headroom, UNUSED in v1. Card checkout prices
-- with inline price_data from `plans.price_cents` because an admin can change
-- that price at runtime; a stored Stripe Price would drift the moment they did.
ALTER TABLE `plans` ADD COLUMN `stripe_price_id_monthly` VARCHAR(255) NULL,
    ADD COLUMN `stripe_product_id` VARCHAR(255) NULL;

-- AlterTable: recurring-billing headroom, UNUSED in v1 (the card rail ships as
-- one-time `mode: 'payment'` Checkout, matching the existing one-shot model).
ALTER TABLE `subscriptions` ADD COLUMN `stripe_cancel_at_period_end` BOOLEAN NULL,
    ADD COLUMN `stripe_price_id` VARCHAR(255) NULL,
    ADD COLUMN `stripe_status` VARCHAR(32) NULL,
    ADD COLUMN `stripe_subscription_id` VARCHAR(255) NULL;

-- AlterTable: a Stripe Customer is per-PERSON, reused across every card payment.
ALTER TABLE `users` ADD COLUMN `stripe_customer_id` VARCHAR(255) NULL;

-- CreateTable: the card rail's idempotency ledger AND dispute forensics trail.
-- The row is inserted BEFORE an event is processed, so a duplicate delivery
-- collides on `stripe_event_id` and is answered 200 without re-running a grant.
CREATE TABLE `stripe_webhook_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `stripe_event_id` VARCHAR(255) NOT NULL,
    `type` VARCHAR(128) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'processed',
    `error` TEXT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    UNIQUE INDEX `stripe_webhook_events_stripe_event_id_key`(`stripe_event_id`),
    INDEX `stripe_webhook_events_type_createdAt_idx`(`type`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex: UNIQUE so a replayed completion can never be attributed to a
-- second payment row. MySQL permits any number of NULLs under a UNIQUE index,
-- so every existing (and future) ABA/Bakong row coexists here with NULL.
CREATE UNIQUE INDEX `payments_stripe_checkout_session_id_key` ON `payments`(`stripe_checkout_session_id`);

-- CreateIndex: not unique — a refund event arrives with the PaymentIntent.
CREATE INDEX `payments_stripe_payment_intent_id_idx` ON `payments`(`stripe_payment_intent_id`);

-- CreateIndex
CREATE UNIQUE INDEX `plans_stripe_product_id_key` ON `plans`(`stripe_product_id`);

-- CreateIndex
CREATE UNIQUE INDEX `subscriptions_stripe_subscription_id_key` ON `subscriptions`(`stripe_subscription_id`);

-- CreateIndex
CREATE UNIQUE INDEX `users_stripe_customer_id_key` ON `users`(`stripe_customer_id`);
