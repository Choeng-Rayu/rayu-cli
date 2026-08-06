-- Admin-set context window (tokens) per hosted model.
--
-- NULL means "unknown": the CLI then falls back to its own default for that
-- model, exactly as it did before this column existed. Once an admin fills it in
-- (e.g. 200000 or 1000000), it becomes the authoritative window the CLI uses for
-- auto-compaction, context warnings, and budgeting — no client release needed.
--
-- Backfill: the models seeded so far have known windows, so set them here rather
-- than leaving every existing row unknown. Anything not listed stays NULL.
ALTER TABLE `hosted_models`
  ADD COLUMN `contextWindow` INTEGER NULL;

UPDATE `hosted_models` SET `contextWindow` = 1000000
  WHERE `code` IN ('deepseek-v4-flash', 'deepseek-v4-pro', 'longcat-2', 'glm-5.2');

UPDATE `hosted_models` SET `contextWindow` = 256000
  WHERE `code` IN ('qwen3.5-397b', 'qwen3.5-122b', 'kimi-k2.7');

UPDATE `hosted_models` SET `contextWindow` = 128000
  WHERE `code` IN ('gpt-oss-120b', 'minimax-m3', 'llama-4');
