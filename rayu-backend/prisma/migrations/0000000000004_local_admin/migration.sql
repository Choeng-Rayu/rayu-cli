-- AlterTable: add optional passwordHash column for local admin login
ALTER TABLE `users` ADD COLUMN `passwordHash` VARCHAR(512) NULL;
