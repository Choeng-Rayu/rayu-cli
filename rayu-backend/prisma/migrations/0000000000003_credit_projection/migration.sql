-- Credit profit/cost projection config
ALTER TABLE `app_settings`
  ADD COLUMN `baselineModelCode` VARCHAR(64) NULL,
  ADD COLUMN `assumedInputRatio` DOUBLE NOT NULL DEFAULT 0.67,
  ADD COLUMN `assumedUsagePercent` INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN `infraCostCentsPerUser` INTEGER NOT NULL DEFAULT 0;
