/**
 * Transport seam shared by the interactive Telegram cards (question flow, plan
 * approval).
 *
 * Production code forwards to telegramApi; tests swap in stubs so the state
 * machines can be driven end-to-end without touching the network. Keeping the
 * seam in its own module avoids each card module growing its own copy.
 */

import {
  answerCallbackQuery,
  editMessageWithInlineKeyboard,
  sendMessageWithForceReply,
  sendMessageWithInlineKeyboard,
  type InlineKeyboard,
} from './telegramApi.js'

export interface InteractiveTransport {
  /** Send a card with buttons. Resolves to its message_id. */
  sendCard(
    token: string,
    chatId: number,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<number>
  /** Replace a card's text/keyboard in place. Pass `[]` to drop the buttons. */
  editCard(
    token: string,
    chatId: number,
    messageId: number,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<void>
  /** Prompt for free text with the reply box focused. Resolves to its message_id. */
  sendForceReply(
    token: string,
    chatId: number,
    text: string,
    placeholder?: string,
  ): Promise<number>
  /** Dismiss the spinner on a tapped button (must happen within ~10s). */
  answerCallback(
    token: string,
    callbackQueryId: string,
    text?: string,
  ): Promise<void>
}

const productionTransport: InteractiveTransport = {
  sendCard: (token, chatId, text, keyboard) =>
    sendMessageWithInlineKeyboard(token, chatId, text, keyboard, 'HTML'),
  editCard: (token, chatId, messageId, text, keyboard) =>
    editMessageWithInlineKeyboard(token, chatId, messageId, text, keyboard, 'HTML'),
  sendForceReply: (token, chatId, text, placeholder) =>
    sendMessageWithForceReply(token, chatId, text, 'HTML', placeholder),
  answerCallback: (token, callbackQueryId, text) =>
    answerCallbackQuery(token, callbackQueryId, text),
}

let active: InteractiveTransport = productionTransport

export function interactiveTransport(): InteractiveTransport {
  return active
}

/**
 * Override part of the transport (tests only). Returns a restore function —
 * call it in afterEach so one test can't leak stubs into the next.
 */
export function setInteractiveTransport(
  overrides: Partial<InteractiveTransport>,
): () => void {
  const previous = active
  active = { ...active, ...overrides }
  return () => {
    active = previous
  }
}
