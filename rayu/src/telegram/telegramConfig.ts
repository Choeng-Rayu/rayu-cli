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
  /** The bot token (from @BotFather). Stored here so users don't need env vars. */
  botToken?: string
  linkedChatId?: number
  linkedUsername?: string
  pendingToken?: PendingToken
}

function configPath(): string {
  return join(getRayuConfigHomeDir(), 'telegram.json')
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
