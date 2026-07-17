-- Migration: drop deprecated clerkUserId column.
--
-- Native Google OAuth + email/password auth replaced Clerk. OAuth identities
-- now live in the Account table (provider + providerAccountId). The clerkUserId
-- column was kept nullable through the transition (migration 20250713000000)
-- but is no longer read by any production code path.

ALTER TABLE `users` DROP INDEX `users_clerkUserId_key`;
ALTER TABLE `users` DROP COLUMN `clerkUserId`;