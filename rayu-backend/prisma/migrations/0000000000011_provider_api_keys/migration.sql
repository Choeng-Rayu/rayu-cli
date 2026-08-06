-- Per-key provider credentials, encrypted at rest.
--
-- Each API key is its OWN row rather than a comma-separated blob, so a key can be
-- rotated, disabled, health-checked and cooled down independently. That is what
-- makes "one key rate-limits → use the next" both possible and visible.
--
-- SECURITY:
--   * encryptedKey is an AES-256-GCM envelope ("v1:base64(iv ‖ tag ‖ ciphertext)");
--     the master key lives only in RAYU_PROVIDER_SECRET, never in this database.
--   * maskedKey exists so listing keys never needs to decrypt anything.
--   * keyHash is UNIQUE per provider: adding the same key twice would make
--     rotation a no-op across identical credentials, so it is refused.
CREATE TABLE `provider_api_keys` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `provider_id` INTEGER NOT NULL,
  `label` VARCHAR(64) NOT NULL,
  `encryptedKey` TEXT NOT NULL,
  `keyHash` VARCHAR(64) NOT NULL,
  `maskedKey` VARCHAR(64) NOT NULL,
  `priority` INTEGER NOT NULL DEFAULT 0,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `lastUsedAt` DATETIME(3) NULL,
  `cooldownUntil` DATETIME(3) NULL,
  `lastError` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `provider_api_keys_provider_id_keyHash_key`(`provider_id`, `keyHash`),
  INDEX `provider_api_keys_provider_id_priority_idx`(`provider_id`, `priority`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Deleting a provider takes its keys with it: an orphaned credential is both
-- useless and a liability.
ALTER TABLE `provider_api_keys`
  ADD CONSTRAINT `provider_api_keys_provider_id_fkey`
  FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
