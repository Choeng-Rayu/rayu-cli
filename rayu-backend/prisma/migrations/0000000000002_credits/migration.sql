-- Hosted model registry + credit system foundation

CREATE TABLE `hosted_models` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(64) NOT NULL,
  `label` VARCHAR(128) NOT NULL,
  `provider` VARCHAR(32) NOT NULL,
  `upstreamBaseUrl` VARCHAR(255) NOT NULL,
  `upstreamModelId` VARCHAR(128) NOT NULL,
  `inputPricePer1MCents` INTEGER NOT NULL DEFAULT 0,
  `outputPricePer1MCents` INTEGER NOT NULL DEFAULT 0,
  `creditMultiplier` DOUBLE NOT NULL DEFAULT 1,
  `allowedPlanCodes` JSON NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `hosted_models_code_key`(`code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `app_settings` (
  `id` INTEGER NOT NULL DEFAULT 1,
  `baselineCreditsPer1M` INTEGER NOT NULL DEFAULT 1000,
  `topupCentsPer1kCredits` INTEGER NOT NULL DEFAULT 0,
  `maxConcurrentStreams` INTEGER NOT NULL DEFAULT 3,
  `maxTokensPerRequest` INTEGER NOT NULL DEFAULT 0,
  `maxRequestsPer5h` INTEGER NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `credit_ledger` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `user_id` INTEGER NOT NULL,
  `modelCode` VARCHAR(64) NOT NULL,
  `inTokens` INTEGER NOT NULL DEFAULT 0,
  `outTokens` INTEGER NOT NULL DEFAULT 0,
  `credits` INTEGER NOT NULL DEFAULT 0,
  `realCostCents` INTEGER NOT NULL DEFAULT 0,
  `source` VARCHAR(16) NOT NULL DEFAULT 'plan',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `credit_ledger_user_id_createdAt_idx`(`user_id`, `createdAt`),
  INDEX `credit_ledger_createdAt_idx`(`createdAt`),
  INDEX `credit_ledger_modelCode_idx`(`modelCode`),
  PRIMARY KEY (`id`),
  CONSTRAINT `credit_ledger_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `credit_topups` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `user_id` INTEGER NOT NULL,
  `credits` INTEGER NOT NULL DEFAULT 0,
  `amountCents` INTEGER NOT NULL DEFAULT 0,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `paymentId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `credit_topups_user_id_idx`(`user_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `credit_topups_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
