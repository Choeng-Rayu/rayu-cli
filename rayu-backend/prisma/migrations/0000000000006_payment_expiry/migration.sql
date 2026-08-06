-- KHQR payments now have an explicit 30-minute pending/QR lifetime. Add the
-- per-payment expiry timestamp and backfill existing rows to createdAt + 30min
-- so historical payments have a well-defined (already-past) deadline.
ALTER TABLE `payments` ADD COLUMN `expiresAt` DATETIME(3) NULL;

UPDATE `payments`
  SET `expiresAt` = DATE_ADD(`createdAt`, INTERVAL 30 MINUTE)
  WHERE `expiresAt` IS NULL;
