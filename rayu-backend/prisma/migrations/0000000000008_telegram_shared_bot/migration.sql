-- Shared Telegram bot: ONE bot (TELEGRAM_BOT_TOKEN) serves all users. The
-- backend polls getUpdates centrally and routes each chat's messages to the
-- owning Rayu user; the CLI long-polls its inbound queue and relays outbound.

-- One Telegram chat bound to one Rayu user (1:1). chat_id is a string to
-- sidestep BigInt/JSON friction (Telegram group/channel ids exceed i32).
CREATE TABLE `telegram_links` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `user_id` INTEGER NOT NULL,
  `chat_id` VARCHAR(64) NOT NULL,
  `username` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `telegram_links_user_id_key`(`user_id`),
  UNIQUE INDEX `telegram_links_chat_id_key`(`chat_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Short-lived, single-use pairing codes (CLI requests one; user sends /start).
CREATE TABLE `telegram_pairings` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(32) NOT NULL,
  `user_id` INTEGER NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `telegram_pairings_code_key`(`code`),
  INDEX `telegram_pairings_user_id_idx`(`user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Per-user inbound queue: raw Telegram updates routed to a user, consumed by
-- the CLI via long-poll and deleted on ack.
CREATE TABLE `telegram_inbound` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `user_id` INTEGER NOT NULL,
  `payload` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `telegram_inbound_user_id_id_idx`(`user_id`, `id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Singleton (id=1) persisting the central poller's getUpdates offset so a
-- backend restart doesn't reprocess (and double-deliver) recent updates.
CREATE TABLE `telegram_cursor` (
  `id` INTEGER NOT NULL DEFAULT 1,
  `offset` BIGINT NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `telegram_links`
  ADD CONSTRAINT `telegram_links_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `telegram_pairings`
  ADD CONSTRAINT `telegram_pairings_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `telegram_inbound`
  ADD CONSTRAINT `telegram_inbound_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
