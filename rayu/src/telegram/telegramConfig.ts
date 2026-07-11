import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../utils/envUtils.js'

/** One-time pairing token shown by /telegram-bot and consumed via /link. */
export interface PendingToken {
  token: string
  expiresAt: number
}

/** Persisted Telegram bridge state. Stored at <configHome>/telegram.json (0600). */
export interface TelegramConfig {
  /**
   * Connection mode:
   *  - 'hosted' (default): use the shared Rayu-hosted bot via the backend — no
   *    bot token needed; linking + routing happen server-side.
   *  - 'byo': bring your own @BotFather token (stored in `botToken`); the CLI
   *    talks to Telegram directly.
   * Absent = inferred: 'byo' when a botToken is present (back-compat with users
   * who already pasted one), else 'hosted'.
   */
  mode?: 'hosted' | 'byo'
  /** The bot token (from @BotFather). Only used in BYO mode. */
  botToken?: string
  linkedChatId?: number
  linkedUsername?: string
  pendingToken?: PendingToken
}

function configPath(): string {
  return join(getRayuConfigHomeDir(), 'telegram.json')
}

/**
 * Resolve the active connection mode. Defaults to 'hosted' (shared Rayu bot).
 * For back-compat, a config that already has a BYO token but no explicit mode
 * is treated as 'byo' so existing setups keep working unchanged.
 */
export function getTelegramMode(): 'hosted' | 'byo' {
  const cfg = readTelegramConfig()
  if (cfg.mode === 'hosted' || cfg.mode === 'byo') return cfg.mode
  return cfg.botToken && cfg.botToken.trim().length > 0 ? 'byo' : 'hosted'
}

/** Persist the connection mode. */
export function setTelegramMode(mode: 'hosted' | 'byo'): void {
  const cfg = readTelegramConfig()
  cfg.mode = mode
  writeTelegramConfig(cfg)
}

/**
 * Record the linked chat locally. In BYO mode this is set by consumePendingToken
 * (the CLI does the linking); in hosted mode the backend owns the link and the
 * CLI mirrors it here so the bridge's chat filter (chatId === linkedChatId)
 * works unchanged.
 */
export function setLinkedChat(chatId: number, username?: string): void {
  const cfg = readTelegramConfig()
  cfg.linkedChatId = chatId
  cfg.linkedUsername = username
  writeTelegramConfig(cfg)
}

/**
 * Bot token: config-first (telegram.json → botToken), then env fallback (TELEGRAM_BOT_TOKEN).
 * This way users can paste their token into rayu-cli instead of setting an env var.
 */
export function getBotToken(): string | undefined {
  const cfg = readTelegramConfig()
  if (cfg.botToken && cfg.botToken.trim().length > 0) return cfg.botToken.trim()
  const env = process.env.TELEGRAM_BOT_TOKEN
  return env && env.trim().length > 0 ? env.trim() : undefined
}

/** Save a bot token to the config file. */
export function saveBotToken(token: string): void {
  const cfg = readTelegramConfig()
  cfg.botToken = token.trim()
  writeTelegramConfig(cfg)
}

/**
 * Remove the stored BYO bot token (and any half-finished pairing) so the user
 * can enter a fresh one — e.g. after the old token was revoked/expired. Leaves
 * the mode as-is; the connect flow re-prompts for a token when none is set.
 */
export function clearBotToken(): void {
  const cfg = readTelegramConfig()
  delete cfg.botToken
  delete cfg.pendingToken
  delete cfg.linkedChatId
  delete cfg.linkedUsername
  writeTelegramConfig(cfg)
}

export function readTelegramConfig(): TelegramConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as TelegramConfig) : {}
  } catch {
    return {}
  }
}

export function writeTelegramConfig(config: TelegramConfig): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function setPendingToken(token: string, ttlMs: number): TelegramConfig {
  const next: TelegramConfig = {
    ...readTelegramConfig(),
    pendingToken: { token, expiresAt: Date.now() + ttlMs },
  }
  writeTelegramConfig(next)
  return next
}

/** Bind a chat to a valid, unexpired pending token. Returns updated config or null on mismatch/expiry. */
export function consumePendingToken(
  token: string,
  chatId: number,
  username: string | undefined,
): TelegramConfig | null {
  const current = readTelegramConfig()
  const pending = current.pendingToken
  if (!pending || pending.token !== token || pending.expiresAt < Date.now()) {
    return null
  }
  const next: TelegramConfig = {
    ...current,
    linkedChatId: chatId,
    linkedUsername: username,
    pendingToken: undefined, // consumed
  }
  writeTelegramConfig(next)
  return next
}

export function unlink(): void {
  const current = readTelegramConfig()
  // Keep botToken but clear linking state
  writeTelegramConfig({ botToken: current.botToken })
}
