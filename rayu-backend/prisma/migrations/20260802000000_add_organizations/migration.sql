-- Migration: Teams — organizations, per-seat credit buckets, shared credit pool.
--
-- Everything the accounts schema had before this was PER-USER
-- (subscriptions.user_id, payments.user_id, credit_ledger.user_id). A team needs
-- ONE payer and MANY spenders, so an organization owns the subscription and a
-- credit pool, and each member holds a bucket carved out of that pool.
--
-- This migration is strictly ADDITIVE and requires no backfill:
--   * every new column is NULL-able or has a default, so existing rows are valid
--     as-is (payments.organization_id / credit_ledger.organization_id = NULL
--     means "individual", which is what every pre-existing row is);
--   * no existing column, index, or constraint is altered or dropped;
--   * organization_subscriptions is a NEW table rather than a nullable user_id on
--     `subscriptions`, so every existing query in the backend AND the gateway
--     (`SELECT ... FROM subscriptions WHERE user_id = ?`) keeps returning exactly
--     what it returned before.

-- AlterTable: team-plan metadata. seat_credits = default per-member bucket quota
-- when the org's pool is seeded (0 = split the pool equally across members).
ALTER TABLE `plans`
  ADD COLUMN `is_team_plan` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `seat_credits` INTEGER NOT NULL DEFAULT 0;

-- AlterTable: a payment can now be owned by an org (NULL = individual payment).
ALTER TABLE `payments` ADD COLUMN `organization_id` INTEGER NULL;

-- AlterTable: a ledger row can be attributed to an org + the member who spent
-- it. user_id is still written for team usage (it equals member_user_id), so a
-- member's personal credit history needs no query change.
ALTER TABLE `credit_ledger`
  ADD COLUMN `organization_id` INTEGER NULL,
  ADD COLUMN `member_user_id` INTEGER NULL;

-- CreateTable: the team. sso_domain is what makes Google Workspace auto-join
-- work — an ID token with hd="company.com" matches "@company.com" here and the
-- signer becomes a member on the spot. UNIQUE so two teams can never claim the
-- same company domain.
CREATE TABLE `organizations` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `slug` VARCHAR(64) NOT NULL,
  `sso_domain` VARCHAR(191) NULL,
  `admin_id` INTEGER NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `organizations_slug_key`(`slug`),
  UNIQUE INDEX `organizations_sso_domain_key`(`sso_domain`),
  INDEX `organizations_admin_id_idx`(`admin_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: a seat. Removal is a status flip, not a delete, so the record of
-- who spent the team's credits survives.
CREATE TABLE `organization_members` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organization_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'member',
  `bucket_credits` INTEGER NOT NULL DEFAULT 0,
  `bucket_quota` INTEGER NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `organization_members_user_id_idx`(`user_id`),
  UNIQUE INDEX `organization_members_organization_id_user_id_key`(`organization_id`, `user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: pending email invites — for teams without a Workspace domain, and
-- for inviting someone before their first sign-in.
CREATE TABLE `organization_invites` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organization_id` INTEGER NOT NULL,
  `email` VARCHAR(320) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'member',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `token` VARCHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `organization_invites_token_key`(`token`),
  INDEX `organization_invites_email_idx`(`email`),
  UNIQUE INDEX `organization_invites_organization_id_email_key`(`organization_id`, `email`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: the org-owned subscription (one per org).
CREATE TABLE `organization_subscriptions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organization_id` INTEGER NOT NULL,
  `plan_id` INTEGER NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `currentPeriodEnd` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `organization_subscriptions_organization_id_key`(`organization_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: the shared pool — the HARD cap on total team usage. Member
-- buckets are soft quotas carved out of it, so unlimited members can join and
-- the pool is the only limit.
CREATE TABLE `credit_pools` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organization_id` INTEGER NOT NULL,
  `total_credits` INTEGER NOT NULL DEFAULT 0,
  `used_credits` INTEGER NOT NULL DEFAULT 0,
  `period_end` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `credit_pools_organization_id_key`(`organization_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `credit_ledger_organization_id_createdAt_idx` ON `credit_ledger`(`organization_id`, `createdAt`);

-- CreateIndex
CREATE INDEX `payments_organization_id_idx` ON `payments`(`organization_id`);

-- AddForeignKey: deleting an org must not delete its payment history, so the
-- reference is nulled instead (the row reverts to looking individual).
ALTER TABLE `payments` ADD CONSTRAINT `payments_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organizations` ADD CONSTRAINT `organizations_admin_id_fkey`
  FOREIGN KEY (`admin_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_invites` ADD CONSTRAINT `organization_invites_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_subscriptions` ADD CONSTRAINT `organization_subscriptions_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_subscriptions` ADD CONSTRAINT `organization_subscriptions_plan_id_fkey`
  FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_pools` ADD CONSTRAINT `credit_pools_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
