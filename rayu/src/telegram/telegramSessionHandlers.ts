/**
 * The receiving half of Telegram session routing.
 *
 * Registered by EVERY session, not just the bridge leader: any session may be
 * the one the user attaches to, and the leader dials in over IPC to hand it a
 * prompt. Kept separate from telegramRouter.ts (the sending half) so a session
 * that never runs a bridge still carries the receiver and nothing more.
 */

import { registerIpcHandler, registerIpcNotifyHandler } from '../ipc/sessionServer.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { logForDebugging } from '../utils/debug.js'
import { IPC_PROMPT, type IpcPromptPayload } from './telegramRouter.js'
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
export function parsePromptPayload(payload: unknown): IpcPromptPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('prompt payload must be an object')
  }
  const { value, mode } = payload as Partial<IpcPromptPayload>
  const hasValue =
    (typeof value === 'string' && value.length > 0) ||
    (Array.isArray(value) && value.length > 0)
  if (!hasValue) {
    throw new Error('prompt payload missing a non-empty `value`')
  }
  if (mode !== 'prompt' && mode !== 'task-notification') {
    throw new Error('prompt payload has an unsupported `mode`')
  }
  return { value: value as IpcPromptPayload['value'], mode }
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
    enqueue({ value: prompt.value, mode: prompt.mode })
    logForDebugging(`[telegram-session] enqueued remote prompt (${prompt.mode})`)
    // The ack only means "queued", never "answered" — the turn's output travels
    // back separately as streamed mirror traffic.
    return { queued: true }
  })

  // The leader tells us when we are the session driving the chat. That is what
  // installs the forwarding permission callbacks, so permission cards from THIS
  // session reach Telegram even though the transport lives in another process.
  registerIpcNotifyHandler(IPC_ATTACH, () => {
    setRemotelyAttached(true)
    logForDebugging('[telegram-session] attached to the Telegram chat')
  })

  registerIpcNotifyHandler(IPC_DETACH, () => {
    setRemotelyAttached(false)
    logForDebugging('[telegram-session] detached from the Telegram chat')
  })

  registerIpcNotifyHandler(IPC_PERMISSION_DECISION, payload => {
    applyRemotePermissionDecision(payload)
  })
}
