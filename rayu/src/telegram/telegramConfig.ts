import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

/** One-time pairing token shown by /telegram-bot and consumed via /link. */
export interface PendingToken {
  token: string
  expiresAt: number
}

/** Persisted Telegram bridge state. Stored at <configHome>/telegram.json (0600). */
export interface TelegramConfig {
  linkedChatId?: number
  linkedUsername?: string
  pendingToken?: PendingToken
}

function configPath(): string {
  return join(getClaudeConfigHomeDir(), 'telegram.json')
}

/** Bot token: env-first (TELEGRAM_BOT_TOKEN), no config-file fallback for secrets. */
export function getBotToken(): string | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN
  return token && token.trim().length > 0 ? token.trim() : undefined
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
  const dir = getClaudeConfigHomeDir()
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
    linkedChatId: chatId,
    linkedUsername: username,
  }
  writeTelegramConfig(next)
  return next
}

export function unlink(): void {
  writeTelegramConfig({})
}
