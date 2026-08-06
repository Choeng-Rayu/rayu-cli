-- Migration: Rayu Studio server-side state.
--
-- Studio (the in-browser agent at rayucode.com/studio) is a pure frontend and
-- holds no secrets. These two tables are its entire backend state; everything
-- else it needs is either an LLM call (rayu-gateway) or already-existing
-- accounts data.
--
-- studio_connections replaces bolt.diy's practice of keeping third-party PATs
-- (GitHub/GitLab/Netlify/Vercel/Supabase) in a browser cookie and handing them
-- back to its own server routes. Tokens are sealed with AES-256-GCM under
-- RAYU_PROVIDER_SECRET — the same envelope used by provider_api_keys — so a
-- database dump alone yields no usable credential. The UNIQUE (user_id, kind)
-- constraint makes reconnecting a service REPLACE the credential rather than
-- accumulate duplicates, so there is never ambiguity about which token is live.
--
-- studio_mcp_config replaces bolt's process-global MCPService singleton, which
-- in a multi-tenant backend would let one user's MCP servers serve another
-- user's session.

CREATE TABLE `studio_connections` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `user_id` INTEGER NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `encrypted_token` TEXT NOT NULL,
  `masked_token` VARCHAR(64) NOT NULL,
  `meta` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `studio_connections_user_id_kind_key`(`user_id`, `kind`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `studio_mcp_config` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `user_id` INTEGER NOT NULL,
  `config` JSON NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `studio_mcp_config_user_id_key`(`user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Deleting an account must take its studio credentials with it.
ALTER TABLE `studio_connections`
  ADD CONSTRAINT `studio_connections_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `studio_mcp_config`
  ADD CONSTRAINT `studio_mcp_config_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
