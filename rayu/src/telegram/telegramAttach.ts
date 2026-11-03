/**
 * Which local session Telegram prompts are routed to.
 *
 * ATTACHMENT IS NOT THE SAME AS ADDRESSABILITY, and keeping them separate is the
 * reason this file exists. The *attached* session is the one that receives chat
 * messages as prompts — exactly one at a time, because a chat is a single
 * conversation. But every registered session with an IPC listener remains
 * individually addressable, so a lifecycle operation (restart, uninstall) can
 * target a specific session regardless of which one currently owns the chat.
 *
 * Persisted rather than held in memory because the bridge leader can change
 * process: if the leader exits, another session takes the lock and must inherit
 * the same routing decision instead of silently re-pointing the chat.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../utils/envUtils.js'
import { saveAutoAttach } from './telegramConfig.js'

/** Persisted at <configHome>/telegram-attached.json (0600). */
export interface TelegramAttachment {
  /** Session id receiving prompts. */
  sessionId: string
  /** Pid at the time of attachment — a fast liveness probe before dialling. */
  pid: number
  /** Working directory, used to re-find the session after a `/resume`. */
  cwd: string
  /** When the attachment was made. */
  attachedAt: number
}

function attachPath(): string {
  return join(getRayuConfigHomeDir(), 'telegram-attached.json')
}

export function readAttachment(): TelegramAttachment | null {
  try {
    const path = attachPath()
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as TelegramAttachment).sessionId === 'string'
    ) {
      return parsed as TelegramAttachment
    }
    return null
  } catch {
    return null
  }
}

export function writeAttachment(attachment: TelegramAttachment): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = attachPath()
  writeFileSync(path, JSON.stringify(attachment, null, 2), { mode: 0o600 })
  // `mode` only applies at creation, so tighten an existing file too. This
  // records which session is being driven remotely — not a secret, but not
  // something to leave world-readable either.
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Non-fatal.
    }
  }
  // Also record the durable memory so reopening this session reconnects. Done
  // here so the two can never disagree about which session was last driving.
  saveAutoAttach(attachment.sessionId, attachment.cwd)
}

/** Forget the current attachment (session closed, or nothing left to attach). */
export function clearAttachment(): void {
  try {
    const path = attachPath()
    if (existsSync(path)) writeFileSync(path, '{}', { mode: 0o600 })
  } catch {
    // Non-fatal — a stale pointer is validated against the live registry anyway.
  }
}

/** The attached session id, or undefined when nothing is attached. */
export function attachedSessionId(): string | undefined {
  return readAttachment()?.sessionId
}
