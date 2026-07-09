-- Promo / discount codes: admin-created codes applied when buying a paid plan.
-- percent (0-100) or fixed (cents off); all-plans or per-plan; optional usage
-- cap ("first N accounts") and active window; apply/end via `active`.
CREATE TABLE `promo_codes` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(64) NOT NULL,
  `description` VARCHAR(255) NULL,
  `discountType` VARCHAR(16) NOT NULL DEFAULT 'percent',
  `discountValue` INTEGER NOT NULL DEFAULT 0,
  `appliesToPlans` JSON NULL,
  `maxRedemptions` INTEGER NULL,
  `usedCount` INTEGER NOT NULL DEFAULT 0,
  `startsAt` DATETIME(3) NULL,
  `endsAt` DATETIME(3) NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `promo_codes_code_key`(`code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One redemption row per (promo code, user): enforces one-use-per-user and is
-- the source of truth for usedCount / the "first N accounts" cap.
CREATE TABLE `promo_redemptions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `promo_code_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `planCode` VARCHAR(32) NULL,
  `payment_id` INTEGER NULL,
  `originalCents` INTEGER NOT NULL DEFAULT 0,
  `discountCents` INTEGER NOT NULL DEFAULT 0,
  `finalCents` INTEGER NOT NULL DEFAULT 0,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `promo_redemptions_user_id_idx`(`user_id`),
  UNIQUE INDEX `promo_redemptions_promo_code_id_user_id_key`(`promo_code_id`, `user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Record the promo + discount applied on a payment (for history/display).
ALTER TABLE `payments`
  ADD COLUMN `promo_code_id` INTEGER NULL,
  ADD COLUMN `discount_cents` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `promo_redemptions`
  ADD CONSTRAINT `promo_redemptions_promo_code_id_fkey`
  FOREIGN KEY (`promo_code_id`) REFERENCES `promo_codes`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `promo_redemptions`
  ADD CONSTRAINT `promo_redemptions_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
