-- Migration: shareable team join links + admin-approved join requests.
--
-- The team could only grow two ways before this: a Google Workspace domain that
-- auto-joins its signers, or an email invite issued to ONE address. Neither
-- covers "drop a link in the group chat", which is how most teams actually
-- onboard people whose addresses the admin does not have.
--
-- A link cannot be an invite with the email left blank, because an invite IS the
-- entitlement — bearer of the token gets the seat. A link that spreads by design
-- must not do that, so it grants only the right to ASK: opening it files an
-- OrganizationJoinRequest, and the admin approves or rejects it. That keeps the
-- security property of the email invite (nobody joins a paid team without the
-- admin's consent) while removing its requirement (knowing the address).
--
-- Strictly ADDITIVE: two new tables, no existing column, index, or constraint is
-- touched, and no backfill is needed — a team with no link simply has no row, and
-- the email-invite path is unchanged.

-- CreateTable: the shareable link. organization_id is UNIQUE — one live link per
-- team, so "regenerate" is a token replacement (the only way to kill a link that
-- has already been shared) rather than an ever-growing list of live secrets.
CREATE TABLE `organization_join_links` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organization_id` INTEGER NOT NULL,
  `token` VARCHAR(64) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'member',
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `expires_at` DATETIME(3) NULL,
  `use_count` INTEGER NOT NULL DEFAULT 0,
  `created_by_id` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `organization_join_links_organization_id_key`(`organization_id`),
  UNIQUE INDEX `organization_join_links_token_key`(`token`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: a pending "let me in". Keyed by USER id, not by an email the
-- requester typed, so approving grants the seat to the exact account that asked.
-- UNIQUE per (org, user): asking twice updates one row instead of flooding the
-- admin's queue, and a decision is kept so a re-ask shows its history.
CREATE TABLE `organization_join_requests` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organization_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `join_link_id` INTEGER NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `message` VARCHAR(280) NULL,
  `decided_by_id` INTEGER NULL,
  `decided_at` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `organization_join_requests_user_id_idx`(`user_id`),
  INDEX `organization_join_requests_organization_id_status_idx`(`organization_id`, `status`),
  UNIQUE INDEX `organization_join_requests_organization_id_user_id_key`(`organization_id`, `user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organization_join_links` ADD CONSTRAINT `organization_join_links_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_join_links` ADD CONSTRAINT `organization_join_links_created_by_id_fkey`
  FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_join_requests` ADD CONSTRAINT `organization_join_requests_organization_id_fkey`
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_join_requests` ADD CONSTRAINT `organization_join_requests_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: rotating or deleting the link must not erase the requests it
-- produced — they lose their provenance, not their validity.
ALTER TABLE `organization_join_requests` ADD CONSTRAINT `organization_join_requests_join_link_id_fkey`
  FOREIGN KEY (`join_link_id`) REFERENCES `organization_join_links`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
