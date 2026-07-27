-- Provider registry: move rayu-hosted routing config out of the gateway env
-- (RAYU_PROVIDERS / RAYU_DISABLED_PROVIDERS / OLLAMA_PROVIDER_NAME) into an
-- admin-managed table, and attach hosted_models to it by FK.
--
-- Ordering is deliberate: create -> seed from existing data -> backfill ->
-- enforce NOT NULL/FK -> drop the old columns. Every existing model keeps
-- routing to exactly the same upstream it does today, with no data re-entry.
--
-- SECURITY: no API key is stored here. `keyEnv` holds only the NAME of the
-- gateway env var that carries the secret.

-- 1. The registry itself.
CREATE TABLE `providers` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(64) NOT NULL,
  `label` VARCHAR(128) NOT NULL,
  `format` VARCHAR(32) NOT NULL,
  `baseUrl` VARCHAR(255) NOT NULL,
  `endpointPath` VARCHAR(191) NULL,
  `authScheme` VARCHAR(32) NOT NULL,
  `keyEnv` VARCHAR(64) NOT NULL,
  `supportsReasoning` BOOLEAN NOT NULL DEFAULT false,
  `supportsImage` BOOLEAN NOT NULL DEFAULT false,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `providers_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. One provider row per distinct provider name already in the catalog. The
-- CASE arms reproduce the gateway's previous built-in defaults
-- (knownProviderDefaults in rayu-gateway/internal/config/config.go) so routing
-- is byte-identical after the cutover:
--   longcat      -> Bearer + {host}/anthropic/v1/messages
--   *ollama*     -> Bearer + {host}/v1/messages          (key env: OLLAMA_API_KEY)
--   anything else-> x-api-key + {host}/anthropic/v1/messages   (deepseek, ...)
-- All existing upstreams speak Anthropic Messages, hence format for every
-- migrated row is 'anthropic_messages'.
--
-- Capability flags are seeded PERMISSIVE (true/true) for migrated providers and
-- models on purpose: today the gateway forwards thinking/image content and lets
-- the upstream decide, so seeding them false would newly reject requests that
-- currently work. The admin tightens them per model in the dashboard, which is
-- what turns on the CLI's "this model can't read images" warning.
INSERT INTO `providers`
  (`name`, `label`, `format`, `baseUrl`, `endpointPath`, `authScheme`, `keyEnv`,
   `supportsReasoning`, `supportsImage`, `enabled`, `updatedAt`)
SELECT
  m.`provider`,
  m.`provider`,
  'anthropic_messages',
  MIN(m.`upstreamBaseUrl`),
  CASE WHEN m.`provider` LIKE '%ollama%' THEN '/v1/messages'
       ELSE '/anthropic/v1/messages' END,
  CASE WHEN m.`provider` = 'longcat' THEN 'bearer'
       WHEN m.`provider` LIKE '%ollama%' THEN 'bearer'
       ELSE 'x_api_key' END,
  CASE WHEN m.`provider` LIKE '%ollama%' THEN 'OLLAMA_API_KEY'
       ELSE CONCAT(UPPER(REPLACE(REPLACE(m.`provider`, '-', '_'), '.', '_')), '_API_KEY') END,
  true,
  true,
  true,
  CURRENT_TIMESTAMP(3)
FROM `hosted_models` m
WHERE m.`provider` IS NOT NULL AND m.`provider` <> ''
GROUP BY m.`provider`;

-- 3. Attach hosted_models to the registry (nullable first so the backfill can run).
ALTER TABLE `hosted_models`
  ADD COLUMN `provider_id` INTEGER NULL,
  ADD COLUMN `supportsReasoning` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `supportsImage` BOOLEAN NOT NULL DEFAULT false;

UPDATE `hosted_models` m
  JOIN `providers` p ON p.`name` = m.`provider`
  SET m.`provider_id` = p.`id`,
      m.`supportsReasoning` = true,
      m.`supportsImage` = true;

-- 4. Any row whose provider name was blank/NULL cannot route today either. Park
-- it on a DISABLED placeholder provider instead of deleting data, so the admin
-- can repoint it in the dashboard; disabled means it can never be billed.
INSERT INTO `providers`
  (`name`, `label`, `format`, `baseUrl`, `endpointPath`, `authScheme`, `keyEnv`,
   `supportsReasoning`, `supportsImage`, `enabled`, `updatedAt`)
SELECT 'unconfigured', 'Unconfigured (fix in dashboard)', 'anthropic_messages',
       'https://invalid.invalid', '/v1/messages', 'x_api_key', 'UNCONFIGURED_API_KEY',
       false, false, false, CURRENT_TIMESTAMP(3)
FROM DUAL
WHERE EXISTS (SELECT 1 FROM `hosted_models` WHERE `provider_id` IS NULL);

UPDATE `hosted_models` m
  JOIN `providers` p ON p.`name` = 'unconfigured'
  SET m.`provider_id` = p.`id`
WHERE m.`provider_id` IS NULL;

-- 5. Enforce the relationship, then drop the replaced columns.
ALTER TABLE `hosted_models` MODIFY COLUMN `provider_id` INTEGER NOT NULL;

CREATE INDEX `hosted_models_provider_id_idx` ON `hosted_models`(`provider_id`);

ALTER TABLE `hosted_models`
  ADD CONSTRAINT `hosted_models_provider_id_fkey`
  FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `hosted_models`
  DROP COLUMN `provider`,
  DROP COLUMN `upstreamBaseUrl`;
