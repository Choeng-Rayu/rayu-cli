/**
 * Chat-type policy for the Telegram bridge.
 *
 * SECURITY (T-1). A linked chat drives this CLI: every plain message becomes an
 * agent turn and permission cards are answerable by whoever taps them. That
 * authority is only ever appropriate for a 1:1 private chat. In a group or
 * supergroup it belongs to every member — and with the bot's privacy mode off,
 * every message in the room becomes a prompt. A channel is worse still.
 *
 * The two predicates are deliberately NOT inverses of each other:
 *  - creating a link requires POSITIVE proof the chat is private, so an absent
 *    chat type fails closed;
 *  - retiring an existing link requires POSITIVE proof it is not, so a
 *    malformed payload can never sever a working setup.
 *
 * In hosted mode the backend enforces the same rule (telegram.util.ts), but BYO
 * mode talks to Telegram directly and has no server in the path — so the check
 * has to exist on both sides.
 */

import type { TelegramUpdate } from './telegramApi.js'

/** The chat type an update came from, if the payload carried one. */
export function updateChatType(update: TelegramUpdate): string | undefined {
  return update.message?.chat.type ?? update.callback_query?.message?.chat.type
}

/** True only when the chat is positively identified as a 1:1 private chat. */
export function isPrivateChat(chatType: string | undefined): boolean {
  return chatType === 'private'
}

/** True only when the chat is positively identified as NOT a private chat. */
export function isDefinitelyNonPrivateChat(
  chatType: string | undefined,
): boolean {
  return (
    chatType === 'group' || chatType === 'supergroup' || chatType === 'channel'
  )
}

/** Shown when a pairing attempt arrives from a group/supergroup/channel. */
export const NON_PRIVATE_PAIRING_NOTICE =
  '🚫 rayu-cli can only be linked from a private chat with this bot.\n\n' +
  'A linked chat can run commands on your computer, so every member of a group ' +
  'would get that access.\n\n' +
  'Open a direct message with me and send the same code there — it is still valid.'

/** Shown when an existing link is retired because its chat is not private. */
export const NON_PRIVATE_REVOKED_NOTICE =
  '🔌 This chat has been unlinked from rayu-cli.\n\n' +
  'Group chats can no longer drive the CLI, because every member would be able ' +
  'to run commands on your computer.\n\n' +
  'Run /telegram-bot in rayu-cli and scan the QR code from a private chat with me.'
