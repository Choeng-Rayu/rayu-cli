import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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
  /**
   * The @username of the BOT this link was established with (no leading '@').
   *
   * Distinct from `linkedUsername`, which is the *human's* Telegram handle.
   * Recorded so a later connect can tell whether the stored link still belongs
   * to the bot we would use today: the hosted/default bot's identity lives
   * entirely on the backend (RAYU_SHARED_BOT_TOKEN), so if the deployment
   * switches to a different bot, a stale link here would silently keep the CLI
   * pointed at the old one with no way to re-pair. Absent on configs written
   * before this field existed.
   */
  linkedBotUsername?: string
  pendingToken?: PendingToken
  /**
   * The session that was last driving the chat, remembered across restarts so
   * reopening it reconnects Telegram automatically.
   *
   * Distinct from `telegram-attached.json`, which is the LIVE pointer used for
   * routing right now: that file is about "where do prompts go", this is about
   * "should this session reconnect at all". Keeping them separate means a
   * closed session can be forgotten for routing while still being remembered
   * for auto-reconnect.
   */
  autoAttach?: {
    sessionId: string
    cwd: string
    /** Epoch ms, used to expire the memory — see AUTO_ATTACH_TTL_MS. */
    savedAt: number
  }
  /**
   * Whether reopening the remembered session reconnects Telegram without
   * `/telegram-bot`. Absent = enabled; set false to require an explicit connect
   * every time.
   */
  autoReconnect?: boolean
  /**
   * Whether `/uninstall` from Telegram may remove RAYU from this machine.
   *
   * ABSENT MEANS DISABLED. This is the only setting in this file that defaults to
   * the restrictive value, because it is the only one whose failure mode is
   * irreversible: with it on, control of the linked Telegram account is
   * sufficient to destroy the install and its credentials. Turning it on is
   * therefore a decision that must be made AT THE MACHINE — see the
   * `telegram-remote-uninstall` command, which is deliberately unreachable from
   * Telegram itself so the chat cannot raise its own privileges.
   */
  allowRemoteUninstall?: boolean
}

/**
 * How long the auto-reconnect memory is honoured.
 *
 * A week covers "I closed my laptop on Friday and came back Monday" while
 * ensuring a session abandoned months ago never silently re-exposes a machine to
 * a chat the user has forgotten about.
 */
export const AUTO_ATTACH_TTL_MS = 7 * 24 * 60 * 60 * 1000

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
export function setLinkedChat(
  chatId: number,
  username?: string,
  botUsername?: string,
): void {
  const cfg = readTelegramConfig()
  cfg.linkedChatId = chatId
  cfg.linkedUsername = username
  if (botUsername) cfg.linkedBotUsername = botUsername
  writeTelegramConfig(cfg)
}

/**
 * Record which bot the current link belongs to. Called once the bot's identity
 * is known (hosted: backend /telegram/bot, BYO: getMe), including as a backfill
 * for links created before `linkedBotUsername` was persisted.
 */
export function setLinkedBotUsername(botUsername: string): void {
  const cfg = readTelegramConfig()
  cfg.linkedBotUsername = botUsername
  writeTelegramConfig(cfg)
}

/**
 * @BotFather token shape: `<numeric bot id>:<secret>`.
 *
 * Deliberately permissive about the secret's length/alphabet so a future
 * BotFather format tweak can't lock users out — the length floor only exists
 * to reject obvious partial input (a single keystroke, a bare bot id).
 */
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{10,}$/

/**
 * Clean up a token the way it actually arrives from a terminal paste.
 *
 * A pasted token is not necessarily a bare string: with bracketed paste mode
 * enabled (which the Ink renderer turns on) the terminal wraps it in
 * `ESC[200~ … ESC[201~`, some terminals split long pastes across lines, and
 * users frequently paste with surrounding quotes copied from a config snippet.
 * Normalising here means the caller compares the token the user *meant* to
 * paste, not the terminal's transport encoding.
 */
export function normalizeBotToken(raw: string): string {
  return raw
    // Bracketed-paste guards, then any other CSI/escape sequence.
    .replace(/\u001b\[20[01]~/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // A wrapped paste can contain spaces/newlines inside the token itself.
    .replace(/\s+/g, '')
    .replace(/^["']|["']$/g, '')
    .trim()
}

/**
 * Is this a syntactically plausible bot token? Single source of truth so the
 * connect UI and the config layer can't disagree about what "valid" means.
 * Syntax only — it says nothing about whether Telegram will accept the token.
 */
export function isValidBotToken(raw: string): boolean {
  return BOT_TOKEN_RE.test(normalizeBotToken(raw))
}

/**
 * The BYO bot token, from telegram.json only.
 *
 * DELIBERATELY NOT an env-var fallback (T-9). This used to fall back to
 * `process.env.TELEGRAM_BOT_TOKEN`, which is the variable rayu-backend uses for
 * the ABA *payment* bot — a different bot entirely. On any host running both
 * (a developer machine, or a box where the backend's .env is sourced into the
 * shell) the CLI would silently adopt the payments bot's token and start a
 * second `getUpdates` consumer against it. Telegram allows exactly one consumer
 * per token, so the two would steal each other's updates — producing the 409
 * Conflict that TelegramService.onPollError warns about at length, and the
 * "messages don't reach the CLI" / "linked successfully AND invalid" pairing
 * symptoms that are hardest to diagnose.
 *
 * A user who wants a BYO bot pastes the token into `/telegram-bot`, which stores
 * it here at 0600. Set RAYU_TELEGRAM_BOT_TOKEN to override for automation — a
 * Rayu-namespaced variable that cannot collide with the backend's.
 */
export function getBotToken(): string | undefined {
  const cfg = readTelegramConfig()
  if (cfg.botToken && cfg.botToken.trim().length > 0) return cfg.botToken.trim()
  const env = process.env.RAYU_TELEGRAM_BOT_TOKEN
  return env && env.trim().length > 0 ? env.trim() : undefined
}

/** Save a bot token to the config file. */
export function saveBotToken(token: string): void {
  const cfg = readTelegramConfig()
  cfg.botToken = normalizeBotToken(token)
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
  const path = configPath()
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
  // `mode` only applies when the file is CREATED. This file holds the bot token
  // and the linked chat, so tighten an already-existing file too. Best-effort:
  // POSIX permissions are meaningless on Windows and chmod can fail there.
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Non-fatal — the config is still written.
    }
  }
}

export function setPendingToken(token: string, ttlMs: number): TelegramConfig {
  const next: TelegramConfig = {
    ...readTelegramConfig(),
    pendingToken: { token, expiresAt: Date.now() + ttlMs },
  }
  writeTelegramConfig(next)
  return next
}

/**
 * Failed `/start <token>` attempts against the current pending token.
 *
 * The pending token is the only thing standing between a stranger's chat and
 * control of this CLI, and the bot accepts messages from anyone. Telegram's own
 * flood limits make online guessing slow, but a bounded attempt count removes
 * the possibility entirely: after MAX_PAIRING_ATTEMPTS misses the token is burnt
 * and the user has to run /telegram-bot again.
 */
const MAX_PAIRING_ATTEMPTS = 5
let pairingAttempts = 0

/** Length-safe, non-short-circuiting compare so a miss leaks no timing signal. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** Bind a chat to a valid, unexpired pending token. Returns updated config or null on mismatch/expiry. */
export function consumePendingToken(
  token: string,
  chatId: number,
  username: string | undefined,
): TelegramConfig | null {
  const current = readTelegramConfig()
  const pending = current.pendingToken
  if (!pending || pending.expiresAt < Date.now()) {
    return null
  }
  if (!tokensMatch(pending.token, token)) {
    if (++pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
      // Burn the token — a real user retries with a fresh QR, a guesser is out.
      pairingAttempts = 0
      writeTelegramConfig({ ...current, pendingToken: undefined })
    }
    return null
  }
  pairingAttempts = 0
  const next: TelegramConfig = {
    ...current,
    linkedChatId: chatId,
    linkedUsername: username,
    pendingToken: undefined, // consumed
  }
  writeTelegramConfig(next)
  return next
}

/**
 * Stable identity of the bot the CLI would talk to right now:
 * `hosted:<botUsername>` or `byo:<botId>`.
 *
 * This is the bridge's lifecycle key. The bridge captures its transport (a bot
 * token, or the hosted router) once at init and never re-reads it, so a boolean
 * "bridge is active" flag cannot express "still active, but to a DIFFERENT bot" —
 * that is how a session could report a successful connect to the shared bot while
 * every message kept flowing through the previously used BYO bot.
 *
 * Deliberately does NOT include the linked chat: the bridge resolves the chat id
 * dynamically on every send, so a chat binding change needs no rebuild. Keying on
 * the chat too would restart the bridge the moment pairing completes, and a
 * restart can abandon an un-confirmed Telegram update — which Telegram then
 * redelivers to the new instance.
 */
export function telegramTransportKey(): string {
  const cfg = readTelegramConfig()
  const mode = getTelegramMode()
  return mode === 'hosted'
    ? // The shared bot's identity lives on the backend; linkedBotUsername is the
      // local record of it, and 'shared' is the placeholder before it's known.
      `hosted:${cfg.linkedBotUsername ?? 'shared'}`
    : // Numeric bot id — the public half of the token, before the ':'.
      `byo:${getBotToken()?.split(':')[0] ?? 'none'}`
}

/**
 * Remember that this session is driving the chat, so reopening it reconnects.
 * Called on every attach, so the memory always names the most recent session.
 */
export function saveAutoAttach(sessionId: string, cwd: string): void {
  const cfg = readTelegramConfig()
  cfg.autoAttach = { sessionId, cwd, savedAt: Date.now() }
  writeTelegramConfig(cfg)
}

/** The remembered session, or undefined when absent or expired. */
export function readAutoAttach(): { sessionId: string; cwd: string } | undefined {
  const saved = readTelegramConfig().autoAttach
  if (!saved || typeof saved.sessionId !== 'string') return undefined
  if (Date.now() - (saved.savedAt ?? 0) > AUTO_ATTACH_TTL_MS) return undefined
  return { sessionId: saved.sessionId, cwd: saved.cwd }
}

/** Forget the remembered session (explicit disconnect, or nothing left to hold). */
export function clearAutoAttach(): void {
  const cfg = readTelegramConfig()
  if (!cfg.autoAttach) return
  delete cfg.autoAttach
  writeTelegramConfig(cfg)
}

/** Whether auto-reconnect is enabled. Defaults to true when unset. */
export function isAutoReconnectEnabled(): boolean {
  return readTelegramConfig().autoReconnect !== false
}

/** Turn auto-reconnect on or off. */
export function setAutoReconnect(enabled: boolean): void {
  const cfg = readTelegramConfig()
  cfg.autoReconnect = enabled
  writeTelegramConfig(cfg)
}

/**
 * Whether remote uninstall over Telegram is permitted on this machine.
 *
 * FAILS CLOSED: anything other than an explicit `true` is a no. An absent field,
 * a hand-edited truthy string, or a config file that failed to parse all read as
 * disabled, because the cost of wrongly allowing this is an unrecoverable wipe.
 */
export function isRemoteUninstallAllowed(): boolean {
  return readTelegramConfig().allowRemoteUninstall === true
}

/**
 * Enable or disable remote uninstall.
 *
 * Callers must be local — the command that exposes this is on the Telegram
 * blocked list, so a chat cannot grant itself the capability.
 */
export function setRemoteUninstallAllowed(allowed: boolean): void {
  const cfg = readTelegramConfig()
  if (allowed) cfg.allowRemoteUninstall = true
  else delete cfg.allowRemoteUninstall
  writeTelegramConfig(cfg)
}

/**
 * Forget the current link so the next connect re-pairs from scratch.
 *
 * Keeps `mode` and the BYO `botToken` — the user's *choice* of transport and
 * their own credentials survive an unlink; only the chat binding goes. (This
 * previously rewrote the file as `{ botToken }` alone, which also dropped the
 * explicit mode and made getTelegramMode() fall back to inferring it from the
 * presence of a token.)
 */
export function unlink(): void {
  const next: TelegramConfig = { ...readTelegramConfig() }
  delete next.linkedChatId
  delete next.linkedUsername
  delete next.linkedBotUsername
  delete next.pendingToken
  // An unlink is an explicit "stop driving my machine from this chat", so the
  // auto-reconnect memory must go too — otherwise reopening the remembered
  // session would quietly re-establish exactly what the user just revoked.
  delete next.autoAttach
  writeTelegramConfig(next)
}
