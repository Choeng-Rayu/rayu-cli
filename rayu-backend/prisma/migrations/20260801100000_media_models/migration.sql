-- Migration: media_models — the admin-owned catalog of IMAGE- and
-- VIDEO-generation models the CLI offers.
--
-- Why a new table instead of columns on hosted_models:
--   1. Media models are NOT proxied by the gateway. The CLI calls NVIDIA /
--      Vertex / fal directly with the user's own key, so there is no provider
--      row, wire format, base URL, or credential to attach. hosted_models
--      REQUIRES a provider_id FK, which would mean inventing fake provider rows
--      for backends the gateway never routes to.
--   2. hosted_models is what /me/entitlements publishes as the CHAT model list
--      (it drives the CLI's /model picker). Mixing flux/veo in there would make
--      image models selectable as chat models.
--   3. family / nvcfFunctionId / estimatedSeconds are meaningless for a chat
--      model, so they would be permanently-NULL columns on most rows.
--
-- SECURITY: metadata only. No API key, no upstream credential, no base URL that
-- the gateway would follow. Provider keys continue to live only in the gateway
-- env / provider_api_keys.

CREATE TABLE `media_models` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  -- Exact upstream model id (NVIDIA/fal ids are slash-paths, hence 191).
  `code` VARCHAR(191) NOT NULL,
  `label` VARCHAR(128) NOT NULL,
  -- 'image' | 'video'
  `mediaType` VARCHAR(16) NOT NULL,
  -- JSON string array. image: ['generate'] / ['edit'] / both.
  -- video: ['text2video'] / ['image2video'] / both (cosmos-predict1-5b does both).
  `capabilities` JSON NOT NULL,
  -- 'nvidia' | 'vertex' | 'nvcf' | 'nvidia-svd' | 'fal'
  `backend` VARCHAR(24) NOT NULL,
  -- Request-shape family; the CLI keys its body builder off this.
  `family` VARCHAR(32) NOT NULL,
  -- NVCF function UUID (video, 'nvcf' backend only; legacy cosmos host needs none).
  `nvcfFunctionId` VARCHAR(64) NULL,
  -- Rough generation seconds for the CLI wait message; NULL = unknown.
  `estimatedSeconds` INTEGER NULL,
  -- Per-model request defaults merged into the family body builder, e.g.
  -- {"cfg_scale":0,"steps":4}. This is what lets two models share one family.
  `defaultParams` JSON NULL,
  -- Plans allowed to use this model. EMPTY array = every plan (media generation
  -- is separately gated by the image_generation/video_generation feature flags).
  `allowedPlanCodes` JSON NULL,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `media_models_code_key`(`code`),
  INDEX `media_models_mediaType_enabled_idx`(`mediaType`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
