-- Per-tool usage tracking
ALTER TABLE `usage_events` ADD COLUMN `tool` VARCHAR(64) NULL;
CREATE INDEX `usage_events_tool_idx` ON `usage_events`(`tool`);
