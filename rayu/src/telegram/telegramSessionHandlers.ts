/**
 * The receiving half of Telegram session routing.
 *
 * Registered by EVERY session, not just the bridge leader: any session may be
 * the one the user attaches to, and the leader dials in over IPC to hand it a
 * prompt. Kept separate from telegramRouter.ts (the sending half) so a session
 * that never runs a bridge still carries the receiver and nothing more.
 */

import { registerIpcHandler, registerIpcNotifyHandler, registerIpcDisconnectHandler } from '../ipc/sessionServer.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { logForDebugging } from '../utils/debug.js'
import {
  applyRemoteModelSelection,
  IPC_APPLY_MODEL,
  IPC_PROMPT,
  type IpcPromptPayload,
} from './telegramRouter.js'
import type { PastedContent } from '../utils/config.js'
import {
  applyRemotePermissionDecision,
  IPC_ATTACH,
  IPC_DETACH,
  IPC_PERMISSION_DECISION,
  setRemotelyAttached,
} from './telegramRemoteBridge.js'

let registered = false

/**
 * Validate an inbound prompt payload.
 *
 * The peer is another local process authenticated by the per-session IPC token,
 * so this is not an adversarial boundary in the way a network socket is — but a
 * version-skewed build IS a realistic source of malformed payloads, and
 * enqueueing `undefined` as a prompt would corrupt the REPL queue. Validate
 * explicitly and reject with a message the caller can surface.
 */
/**
 * Image bytes travelling with a prompt, or undefined.
 *
 * Drops malformed entries instead of rejecting the whole prompt: the text is still
 * useful, and one bad paste must not cost the user their message. The peer is a
 * local process authenticated by the per-session IPC token, so this is a robustness
 * check, not an adversarial boundary.
 */
function parsePastedContents(value: unknown): Record<number, PastedContent> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const parsed: Record<number, PastedContent> = {}
  let kept = false
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id < 0) continue
    if (typeof entry !== 'object' || entry === null) continue
    const paste = entry as Partial<PastedContent>
    if (paste.type !== 'image' && paste.type !== 'text') continue
    if (typeof paste.content !== 'string') continue
    parsed[id] = { ...paste, id, type: paste.type, content: paste.content }
    kept = true
  }
  return kept ? parsed : undefined
}

export function parsePromptPayload(payload: unknown): IpcPromptPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('prompt payload must be an object')
  }
  const { value, mode, priority, operationId, pastedContents } =
    payload as Partial<IpcPromptPayload>
  const hasValue =
    (typeof value === 'string' && value.length > 0) ||
    (Array.isArray(value) && value.length > 0)
  if (!hasValue) {
    throw new Error('prompt payload missing a non-empty `value`')
  }
  if (mode !== 'prompt' && mode !== 'task-notification') {
    throw new Error('prompt payload has an unsupported `mode`')
  }
  if (priority !== undefined && priority !== 'now' && priority !== 'next' && priority !== 'later') {
    throw new Error('prompt payload has an unsupported `priority`')
  }
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId)) {
    throw new Error('prompt payload has an invalid `operationId`')
  }
  const images = parsePastedContents(pastedContents)
  return {
    value: value as IpcPromptPayload['value'],
    mode,
    ...(priority ? { priority } : {}),
    ...(operationId ? { operationId } : {}),
    ...(images ? { pastedContents: images } : {}),
  }
}

/**
 * Validate a model switch request.
 *
 * Rejects rather than coercing: a bad model id must surface to the chat as a failed
 * switch, not be written into the override and break the next request.
 */
export function parseApplyModelPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('model payload must be an object')
  }
  const { model } = payload as { model?: unknown }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('model payload missing a non-empty `model`')
  }
  if (model.length > 200) throw new Error('model id is too long')
  return model
}

/**
 * Accept prompts delivered over IPC. Idempotent so a bridge restart re-arming
 * its handlers is harmless.
 */
export function registerTelegramSessionHandlers(): void {
  if (registered) return
  registered = true

  registerIpcHandler(IPC_PROMPT, payload => {
    const prompt = parsePromptPayload(payload)
    enqueue({
      value: prompt.value,
      mode: prompt.mode,
      priority: prompt.priority,
      ...(prompt.pastedContents ? { pastedContents: prompt.pastedContents } : {}),
    })
    logForDebugging(`[telegram-session] enqueued remote prompt (${prompt.mode})`)
    // The ack only means "queued", never "answered" — the turn's output travels
    // back separately as streamed mirror traffic. `operationId` is echoed back
    // unchanged so the caller can confirm which submission this ack belongs to;
    // an older peer that never sent one gets an ack with no `operationId` field.
    return { queued: true, ...(prompt.operationId ? { operationId: prompt.operationId } : {}) }
  })

  // A model switch made in the chat, applied in THIS process — the one whose next
  // request will use it. The leader persists the choice in the Rayu config; this is
  // the live half. Replaces the old behaviour of mutating the leader's own override,
  // which left a remote session on the previous model.
  registerIpcHandler(IPC_APPLY_MODEL, payload => {
    const model = parseApplyModelPayload(payload)
    applyRemoteModelSelection(model)
    logForDebugging(`[telegram-session] applied remote model switch: ${model}`)
    return { applied: true }
  })

  // The leader tells us when we are the session driving the chat. That is what
  // installs the forwarding permission callbacks, so permission cards from THIS
  // session reach Telegram even though the transport lives in another process.
  registerIpcNotifyHandler(IPC_ATTACH, (_payload, peerId) => {
    setRemotelyAttached(true, peerId)
    logForDebugging('[telegram-session] attached to the Telegram chat')
  })

  registerIpcNotifyHandler(IPC_DETACH, (_payload, peerId) => {
    setRemotelyAttached(false, peerId)
    logForDebugging('[telegram-session] detached from the Telegram chat')
  })

  registerIpcNotifyHandler(IPC_PERMISSION_DECISION, payload => {
    applyRemotePermissionDecision(payload)
  })
  registerIpcDisconnectHandler(peerId => setRemotelyAttached(false, peerId))
}
