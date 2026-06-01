/**
 * BridgePermissionCallbacks implementation for the Telegram bridge.
 * When the REPL needs a permission decision it sends a y/n question to
 * the linked chat and resolves once the user replies.
 */

import type { BridgePermissionCallbacks, BridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js'
import { sendMessage } from './telegramApi.js'
import { readTelegramConfig } from './telegramConfig.js'

type ResponseHandler = (r: BridgePermissionResponse) => void

const PENDING = new Map<string, ResponseHandler>()
const YES_WORDS = new Set(['y', 'yes', 'allow', 'ok', 'approve', '1', 'true'])
const NO_WORDS = new Set(['n', 'no', 'deny', 'reject', 'block', 'cancel', '0', 'false'])

/** Call from the poll loop when the linked chat sends any message. */
export function handlePermissionReply(text: string): boolean {
  if (PENDING.size === 0) return false
  const lower = text.trim().toLowerCase()
  const behavior: 'allow' | 'deny' | null =
    YES_WORDS.has(lower) ? 'allow' :
    NO_WORDS.has(lower) ? 'deny' :
    null
  if (behavior === null) return false
  for (const [, handler] of PENDING) {
    handler({ behavior })
  }
  PENDING.clear()
  return true
}

export function createTelegramPermissionCallbacks(token: string): BridgePermissionCallbacks {
  return {
    sendRequest(requestId, toolName, _input, _toolUseId, description) {
      const chatId = readTelegramConfig().linkedChatId
      if (chatId === undefined) return
      const msg = `🔐 *Permission required*\n\`${toolName}\`\n${description}\n\nReply *y* to allow or *n* to deny.`
      void sendMessage(token, chatId, msg).catch(() => {})
    },

    sendResponse(_requestId, _response) {
      // no-op: responses come in from the poll loop, not pushed by us
    },

    cancelRequest(requestId) {
      PENDING.delete(requestId)
    },

    onResponse(requestId, handler) {
      PENDING.set(requestId, handler)
      return () => PENDING.delete(requestId)
    },
  }
}
