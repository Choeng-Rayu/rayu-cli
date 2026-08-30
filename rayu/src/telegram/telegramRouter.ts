/**
 * Routes inbound Telegram prompts to the attached local session.
 *
 * The bridge leader (the process holding telegram-bridge.lock) owns the Telegram
 * transport. The session the user has attached may be a DIFFERENT process, so
 * delivery takes one of two paths:
 *
 *  - IN-PROCESS when the leader is itself the attached session. This is the
 *    common case (one session open) and it must not touch a socket: enqueueing
 *    directly keeps the single-session experience exactly as fast as before
 *    multi-session routing existed, and removes the IPC layer from the blast
 *    radius of the most-used path.
 *  - OVER IPC otherwise, dialling that session's published listener.
 *
 * Unreachable targets are reported, never silently queued: a prompt swallowed by
 * a dead session is indistinguishable from the model being slow, which is the
 * worst possible failure mode for a remote control.
 */

import { getSessionId } from '../bootstrap/state.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { ensureLeaderLink } from './telegramLeaderLink.js'
import { readSessionRecords, type SessionRecord } from '../utils/concurrentSessions.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { attachedSessionId, readAttachment, writeAttachment } from './telegramAttach.js'

/** IPC request type: deliver a prompt to a session's REPL queue. */
export const IPC_PROMPT = 'telegram:prompt'

/** Payload of an IPC_PROMPT request. */
export interface IpcPromptPayload {
  /**
   * What to enqueue: plain text / a slash command, or content blocks when the
   * user sent images. Content blocks are why MAX_FRAME_BYTES is sized for a
   * base64 image rather than for control messages alone.
   */
  value: string | ContentBlockParam[]
  /** Queue mode, mirroring QueuedCommand.mode. */
  mode: 'prompt' | 'task-notification'
}

/** Why a prompt could not be delivered. */
export type RouteFailure =
  | { kind: 'no-sessions' }
  | { kind: 'not-attached'; available: number }
  | { kind: 'session-gone'; title: string }
  | { kind: 'not-addressable'; title: string }
  | { kind: 'delivery-failed'; title: string; detail: string }

export type RouteResult =
  | { kind: 'delivered'; inProcess: boolean; title: string }
  | RouteFailure

function titleOf(record: SessionRecord): string {
  return record.name?.trim() || record.cwd || `pid ${record.pid}`
}

/**
 * Resolve the attached session from the registry.
 *
 * Matches on sessionId first. Falls back to cwd + liveness because `/resume`
 * MUTATES a session's id in place (bootstrap/state.switchSession), so a pointer
 * written before a resume would otherwise dangle even though the same terminal,
 * in the same directory, is still there and is obviously what the user meant.
 */
async function resolveAttached(): Promise<
  { record: SessionRecord } | { missing: 'none' | 'gone' }
> {
  const attachment = readAttachment()
  if (!attachment) return { missing: 'none' }

  const records = await readSessionRecords()
  if (records.length === 0) return { missing: 'gone' }

  const byId = records.find(r => r.sessionId === attachment.sessionId)
  if (byId) return { record: byId }

  const byCwd = records.find(
    r => r.cwd === attachment.cwd && isProcessRunning(r.pid),
  )
  if (byCwd) {
    // Re-pin the pointer to the new id so the next lookup is a direct hit.
    writeAttachment({
      sessionId: byCwd.sessionId,
      pid: byCwd.pid,
      cwd: byCwd.cwd,
      attachedAt: attachment.attachedAt,
    })
    return { record: byCwd }
  }
  return { missing: 'gone' }
}

/**
 * Deliver a prompt to the attached session.
 *
 * When nothing is attached but exactly ONE session exists, that session is
 * attached implicitly. Requiring an explicit `/switch` for the single-session
 * case would break every existing user's workflow for no benefit — the ambiguity
 * multi-session routing solves simply does not exist with one session.
 */
export async function routePrompt(
  payload: IpcPromptPayload,
): Promise<RouteResult> {
  const records = await readSessionRecords()
  if (records.length === 0) return { kind: 'no-sessions' }

  let target: SessionRecord | undefined
  const resolved = await resolveAttached()

  if ('record' in resolved) {
    target = resolved.record
  } else if (records.length === 1) {
    target = records[0]!
    writeAttachment({
      sessionId: target.sessionId,
      pid: target.pid,
      cwd: target.cwd,
      attachedAt: Date.now(),
    })
  } else if (resolved.missing === 'gone') {
    return { kind: 'session-gone', title: readAttachment()?.cwd ?? 'that session' }
  } else {
    return { kind: 'not-attached', available: records.length }
  }

  const title = titleOf(target)

  // Fast path: the leader IS the attached session.
  if (target.sessionId === getSessionId() || target.pid === process.pid) {
    enqueue({ value: payload.value, mode: payload.mode })
    return { kind: 'delivered', inProcess: true, title }
  }

  if (!target.ipcAddress || !target.ipcToken) {
    return { kind: 'not-addressable', title }
  }
  if (!isProcessRunning(target.pid)) {
    return { kind: 'session-gone', title }
  }

  // Use the leader's PERSISTENT link rather than dialling per prompt: the same
  // connection carries permission cards and streamed output back from the
  // session, so it has to stay open between messages.
  const connection = await ensureLeaderLink(target)
  if (!connection) {
    return { kind: 'delivery-failed', title, detail: 'could not open ipc link' }
  }

  try {
    await connection.request(IPC_PROMPT, payload)
    return { kind: 'delivered', inProcess: false, title }
  } catch (e) {
    const detail = errorMessage(e)
    logForDebugging(`[telegram-router] delivery to ${title} failed: ${detail}`)
    return { kind: 'delivery-failed', title, detail }
  }
}

/** User-facing explanation for a failed route. */
export function describeRouteFailure(failure: RouteFailure): string {
  switch (failure.kind) {
    case 'no-sessions':
      return '⚠️ No rayu-cli session is running. Start one on your computer, then try again.'
    case 'not-attached':
      return (
        `⚠️ ${failure.available} sessions are open, so I don't know which one to use.\n\n` +
        'Send /sessions to see them, then /switch <n> to pick one.'
      )
    case 'session-gone':
      return (
        `🔌 The attached session (${failure.title}) has closed.\n\n` +
        'Send /sessions to see what is still open, then /switch <n>.'
      )
    case 'not-addressable':
      return (
        `⚠️ ${failure.title} has no local IPC listener, so it can't be driven from Telegram.\n\n` +
        'It is still usable at its own terminal. Send /sessions to pick another.'
      )
    case 'delivery-failed':
      return `⚠️ Could not reach ${failure.title}. Send /sessions to check it is still open.`
  }
}
