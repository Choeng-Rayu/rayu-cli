/**
 * "Stop the AI" from Telegram — the remote equivalent of pressing Esc.
 *
 * Two entry points, because neither alone is enough:
 *  - a ⛔ Stop button on a small control card posted when a turn starts, so
 *    stopping is one tap while output is streaming;
 *  - /interrupt (aliases /cancel, /esc, /abort) for when the card has scrolled
 *    away, or the turn was started from the keyboard rather than from chat.
 *
 * Note `/stop` is NOT used: the hosted backend treats `/stop` as a disconnect
 * command and consumes it before the CLI ever sees it (isDisconnectCommand in
 * rayu-backend), and locally it already means unlink. Reusing it would make
 * "stop the AI" silently sever the link instead.
 */

import { clearCommandQueue, hasCommandsInQueue } from '../utils/messageQueueManager.js'
import { interruptActiveTurn, isTurnInterruptible } from '../utils/activeTurn.js'
import { type InlineKeyboard } from './telegramApi.js'
import { interactiveTransport } from './telegramInteractive.js'

/** callback_data namespace. Single action, so no parameters are needed. */
const CB_STOP = 'int:stop'

/** Commands that mean "stop the AI now". `/stop` is reserved for disconnect. */
const INTERRUPT_COMMANDS = new Set([
  '/interrupt',
  '/cancel',
  '/esc',
  '/abort',
])

export function isInterruptCommand(cmd: string): boolean {
  return INTERRUPT_COMMANDS.has(cmd.toLowerCase())
}

export function stopKeyboard(): InlineKeyboard {
  return [[{ text: '⛔ Stop', callback_data: CB_STOP }]]
}

export type InterruptOutcome = 'stopped' | 'queue-cleared' | 'idle'

/**
 * Perform the interrupt. Aborting the running turn is the primary effect; if
 * nothing is running, drop anything still queued (messages sent from chat that
 * have not started yet) so a burst of requests can be called off too.
 */
export function performInterrupt(): InterruptOutcome {
  // 'interrupt' (not 'user-cancel'): counts as a user interrupt for labelling,
  // but does not trigger the REPL's rewind-and-restore, which would drop the
  // turn from the transcript and paste the remote prompt into the local input.
  if (interruptActiveTurn('interrupt')) return 'stopped'
  if (hasCommandsInQueue()) {
    clearCommandQueue()
    return 'queue-cleared'
  }
  return 'idle'
}

export function interruptMessage(outcome: InterruptOutcome): string {
  if (outcome === 'stopped') return '⛔ <b>Stopped.</b> The current response was interrupted.'
  if (outcome === 'queue-cleared') {
    return '⛔ <b>Queue cleared.</b> Nothing was running, so pending messages were dropped.'
  }
  return 'ℹ️ Nothing is running right now.'
}

// ---------------------------------------------------------------------------
// The per-turn control card
// ---------------------------------------------------------------------------

interface StopCard {
  chatId: number
  token: string
  messageId: number
}

let card: StopCard | null = null

/**
 * Post the control card for a turn that is about to run. Safe to call twice —
 * the existing card is reused so a chat never accumulates Stop buttons.
 */
export async function showStopCard(token: string, chatId: number): Promise<void> {
  if (card) return
  // Claim the slot before awaiting so two near-simultaneous turns can't both send.
  card = { chatId, token, messageId: 0 }
  const messageId = await interactiveTransport()
    .sendCard(token, chatId, '⏳ <b>Working…</b>', stopKeyboard())
    .catch(() => 0)
  if (!messageId) {
    card = null
    return
  }
  if (card) card.messageId = messageId
}

/** Remove the buttons when the turn ends (or was stopped). */
export async function clearStopCard(finalText?: string): Promise<void> {
  const current = card
  card = null
  if (!current?.messageId) return
  await interactiveTransport()
    .editCard(
      current.token,
      current.chatId,
      current.messageId,
      finalText ?? '✅ <b>Done.</b>',
      [],
    )
    .catch(() => {})
}

export function hasStopCard(): boolean {
  return card !== null
}

/** Test helper. */
export function resetStopCard(): void {
  card = null
}

/**
 * Handle a tap on ⛔ Stop. Returns true when the callback belonged to this
 * module, so the bridge stops routing it.
 */
export async function handleInterruptCallback(
  token: string,
  chatId: number,
  callbackQueryId: string,
  data: string,
): Promise<boolean> {
  if (data !== CB_STOP) return false
  const transport = interactiveTransport()
  const outcome = performInterrupt()
  await transport.answerCallback(
    token,
    callbackQueryId,
    outcome === 'idle' ? 'Nothing is running' : 'Stopped',
  )
  if (hasStopCard()) {
    await clearStopCard(interruptMessage(outcome))
  } else {
    await transport.sendCard(token, chatId, interruptMessage(outcome), [])
  }
  return true
}
