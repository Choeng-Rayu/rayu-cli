-- Migration: OAuth + email/password auth
-- Adds an Account table for provider identities and updates User for local auth.

-- Make clerkUserId nullable so legacy Clerk users keep their id while new users
-- can sign in via Google/GitHub/email without one.
ALTER TABLE `users` MODIFY `clerkUserId` VARCHAR(191) NULL;

-- New OAuth identity columns (kept alongside Account table for quick lookups).
ALTER TABLE `users` ADD COLUMN `googleId` VARCHAR(191) NULL;
ALTER TABLE `users` ADD COLUMN `githubId` VARCHAR(191) NULL;
ALTER TABLE `users` ADD COLUMN `emailVerified` BOOLEAN NOT NULL DEFAULT false;

-- Make email unique for local email/password login.
ALTER TABLE `users` ADD UNIQUE INDEX `users_email_key`(`email`);

-- Unique index for Google single sign-on lookups.
ALTER TABLE `users` ADD UNIQUE INDEX `users_googleId_key`(`googleId`);

-- Account table: scalable identity provider store.
CREATE TABLE `accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `provider_account_id` VARCHAR(191) NOT NULL,
    `accessToken` TEXT NULL,
    `refreshToken` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `accounts_provider_provider_account_id_key`(`provider`, `provider_account_id`),
    INDEX `accounts_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign key from accounts to users.
ALTER TABLE `accounts` ADD CONSTRAINT `accounts_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
