-- Reconcile `payments` with the Prisma schema.
--
-- WHY THIS MIGRATION EXISTS
--
-- The KHQR checkout columns (khqr, md5, paidAt) and the plan relation (plan_id)
-- were added to schema.prisma and to running databases with `prisma db push`, but
-- no migration ever recorded them. The migration history and the schema had
-- therefore drifted: a database built purely by `prisma migrate deploy` — which is
-- exactly what a FRESH production deployment does — came up without those columns,
-- and the first checkout would fail with "Unknown column 'khqr'".
--
-- WHY IT IS GUARDED
--
-- Existing databases (dev, and any production that was ever `db push`ed) already
-- have these columns. A plain ALTER TABLE ADD COLUMN would fail there, and since
-- migrations run in the backend's entrypoint, a failure means the container
-- crash-loops on deploy. MySQL has no `ADD COLUMN IF NOT EXISTS`, so each step
-- checks information_schema first and becomes a no-op when the object is present.
--
-- The result is safe in all three states: fresh DB (adds), pushed DB (no-op),
-- partially-pushed DB (adds only what is missing).
--
-- Additive only. Nothing is dropped, so no data can be lost. (users.googleId /
-- users.githubId also linger from the pre-OAuth schema; they are nullable and
-- absent from schema.prisma, so Prisma ignores them and they are harmless. They
-- are deliberately NOT dropped here — that would destroy data for no functional
-- gain.)

-- payments.plan_id ------------------------------------------------------------
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'plan_id') = 0,
  'ALTER TABLE `payments` ADD COLUMN `plan_id` INTEGER NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- payments.md5 ---------------------------------------------------------------
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'md5') = 0,
  'ALTER TABLE `payments` ADD COLUMN `md5` VARCHAR(64) NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- payments.khqr --------------------------------------------------------------
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'khqr') = 0,
  'ALTER TABLE `payments` ADD COLUMN `khqr` TEXT NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- payments.paidAt ------------------------------------------------------------
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'paidAt') = 0,
  'ALTER TABLE `payments` ADD COLUMN `paidAt` DATETIME(3) NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- UNIQUE(md5): the Bakong status poll looks a payment up by its QR hash, so a
-- duplicate would make that lookup ambiguous.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND INDEX_NAME = 'payments_md5_key') = 0,
  'ALTER TABLE `payments` ADD UNIQUE INDEX `payments_md5_key`(`md5`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- FK payments.plan_id → plans.id. ON DELETE SET NULL matches the optional
-- relation in schema.prisma (`plan Plan?`): deleting a plan must not delete the
-- payment history that references it, it just detaches it.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'payments_plan_id_fkey') = 0,
  'ALTER TABLE `payments` ADD CONSTRAINT `payments_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
