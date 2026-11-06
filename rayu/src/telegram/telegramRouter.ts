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

import { getSessionId, setMainLoopModelOverride } from '../bootstrap/state.js'
import { notifySessionMetadataChanged } from '../utils/sessionState.js'
import { invalidateRayuConfigCache } from '../utils/rayuConfig.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { QueuePriority } from '../types/textInputTypes.js'
import { ensureLeaderLink } from './telegramLeaderLink.js'
import { readSessionRecords, type SessionRecord } from '../utils/concurrentSessions.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { setRemoteModelOverride } from '../utils/remoteModelOverride.js'
import type { PastedContent } from '../utils/config.js'
import { readAttachment, writeAttachment } from './telegramAttach.js'

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
  /**
   * Image bytes for the `[Image #N]` markers in `value`.
   *
   * Without this the markers arrived with nothing behind them: a Telegram photo
   * became a text reference the model could not see. Mirrors
   * `QueuedCommand.pastedContents` so the receiving session can enqueue it as-is.
   */
  pastedContents?: Record<number, PastedContent>
  /** Optional SDK delivery priority (`now` steers, `next` queues). */
  priority?: QueuePriority
  /**
   * Caller-generated correlation id, additive and optional so an older peer on
   * either end of this request simply omits it. Two prompts with identical text
   * sent close together are otherwise indistinguishable once they round-trip
   * back as a mirrored activity echo — matching by text alone picks the OLDEST
   * unconsumed match, which is correct only while echoes arrive in the same
   * order the prompts were sent. The ack below carries this same id back so the
   * caller can confirm which specific submission was queued, even though the
   * value is not yet threaded through to the later activity echo itself (that
   * requires `commandLifecycle.ts` and the bridge's message filter to carry it
   * too, which is a separate, larger change).
   */
  operationId?: string
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
export async function resolveAttachedSession(): Promise<
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
 * Resolve the attached session, or the failure the caller should report.
 *
 * Shared by every routed operation (prompt, model switch) so the
 * "one session auto-attaches" rule and the `/resume` cwd fallback cannot drift
 * between them.
 */
async function resolveTarget(): Promise<
  { target: SessionRecord; title: string } | { failure: RouteFailure }
> {
  const records = await readSessionRecords()
  if (records.length === 0) return { failure: { kind: 'no-sessions' } }

  let target: SessionRecord | undefined
  const resolved = await resolveAttachedSession()

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
    return {
      failure: { kind: 'session-gone', title: readAttachment()?.cwd ?? 'that session' },
    }
  } else {
    return { failure: { kind: 'not-attached', available: records.length } }
  }

  return { target, title: titleOf(target) }
}

/**
 * Apply a model chosen outside this process (Telegram `/model` or `/connect`).
 *
 * Both setters are needed: the signal makes the REPL re-render
 * (`useMainLoopModel`), and the bootstrap override makes the next request use it.
 * In the headless engine only the override matters, and calling both is harmless.
 *
 * Deliberately lives here rather than in `remoteModelOverride.ts`: this module is
 * already in the bootstrap-state graph, so the pair stays in one place without
 * adding an import edge to a leaf utility.
 */
export function applyRemoteModelSelection(model: string): void {
  // ── RE-READ THE PROVIDER CONFIG FIRST ──────────────────────────────────────
  //
  // The caller persisted the choice to disk in ANOTHER process (the bridge leader),
  // and `loadRayuConfig()` memoizes its first read for the life of this process. A
  // `/connect` or `/model <id> <provider>` also moves the ACTIVE PROVIDER, so without
  // this the session would apply the new model id against the OLD provider — the
  // half-applied switch this routing exists to prevent. The engine's own `set_model`
  // control handler invalidates for the same reason.
  invalidateRayuConfigCache()
  setRemoteModelOverride(model)
  setMainLoopModelOverride(model)
  // Same metadata notice the engine's own `set_model` control request emits, so a
  // panel attached to this session learns about a phone-initiated switch.
  notifySessionMetadataChanged({ model })
}

/** Whether this process is the session being addressed. */
function isSelf(target: SessionRecord): boolean {
  return target.sessionId === getSessionId() || target.pid === process.pid
}

/** The failure for a target that cannot be reached over IPC, if any. */
function unreachableFailure(target: SessionRecord, title: string): RouteFailure | null {
  if (!target.ipcAddress || !target.ipcToken) {
    return { kind: 'not-addressable', title }
  }
  if (!isProcessRunning(target.pid)) return { kind: 'session-gone', title }
  return null
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
  const resolved = await resolveTarget()
  if ('failure' in resolved) return resolved.failure
  const { target, title } = resolved

  // Fast path: the leader IS the attached session.
  if (isSelf(target)) {
    enqueue({
      value: payload.value,
      mode: payload.mode,
      ...(payload.priority ? { priority: payload.priority } : {}),
      ...(payload.pastedContents ? { pastedContents: payload.pastedContents } : {}),
    })
    return { kind: 'delivered', inProcess: true, title }
  }

  const unreachable = unreachableFailure(target, title)
  if (unreachable) return unreachable

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

/**
 * IPC request type: switch the ATTACHED session's model.
 *
 * A model switch must land in the process whose next `ask()` will use it, which is
 * not necessarily the bridge leader — the chat is often attached to the editor's
 * engine or to a second terminal. Mutating the leader's module-level override (the
 * old behaviour) left the real session on the previous model.
 */
export const IPC_APPLY_MODEL = 'telegram:apply-model'

/** Payload of an IPC_APPLY_MODEL request. */
export interface ApplyModelPayload {
  model: string
}

export type ApplyModelResult =
  | { kind: 'applied'; inProcess: boolean; title: string }
  | RouteFailure

/**
 * Apply a model switch to the attached session.
 *
 * The caller persists the choice in the Rayu config first — that file is the durable
 * source of truth, so a failure here means "saved, but no running session took it".
 */
export async function routeApplyModel(model: string): Promise<ApplyModelResult> {
  const resolved = await resolveTarget()
  if ('failure' in resolved) return resolved.failure
  const { target, title } = resolved

  if (isSelf(target)) {
    applyRemoteModelSelection(model)
    return { kind: 'applied', inProcess: true, title }
  }

  const unreachable = unreachableFailure(target, title)
  if (unreachable) return unreachable

  const connection = await ensureLeaderLink(target)
  if (!connection) {
    return { kind: 'delivery-failed', title, detail: 'could not open ipc link' }
  }

  try {
    await connection.request(IPC_APPLY_MODEL, { model } satisfies ApplyModelPayload)
    return { kind: 'applied', inProcess: false, title }
  } catch (e) {
    const detail = errorMessage(e)
    logForDebugging(`[telegram-router] model switch for ${title} failed: ${detail}`)
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
