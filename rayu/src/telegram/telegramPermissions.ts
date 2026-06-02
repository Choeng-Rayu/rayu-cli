/**
 * BridgePermissionCallbacks implementation for the Telegram bridge.
 * When the REPL needs a permission decision it sends a y/n/always question to
 * the linked chat and resolves once the user replies.
 */

import type { BridgePermissionCallbacks, BridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js'
import { sendMessage } from './telegramApi.js'
import { readTelegramConfig } from './telegramConfig.js'

type ResponseHandler = (r: BridgePermissionResponse) => void

const PENDING = new Map<string, ResponseHandler>()
const YES_WORDS = new Set(['y', 'yes', 'allow', 'ok', 'approve', '1', 'true'])
const NO_WORDS = new Set(['n', 'no', 'deny', 'reject', 'block', 'cancel', '0', 'false'])
const ALWAYS_WORDS = new Set(['a', 'always', 'allow_always', 'always_allow', 'aa'])

/** Call from the poll loop when the linked chat sends any message. */
export function handlePermissionReply(text: string): boolean {
  if (PENDING.size === 0) return false
  const lower = text.trim().toLowerCase()

  let response: BridgePermissionResponse | null = null

  if (ALWAYS_WORDS.has(lower)) {
    // "always" — allow this turn AND add a permanent allow rule for the tool.
    // The pending map stores the toolName so we can build the updatedPermissions.
    const toolName = PENDING_TOOL_NAMES.get([...PENDING.keys()][0] ?? '')
    response = {
      behavior: 'allow',
      updatedPermissions: toolName
        ? [{
            type: 'addRules' as const,
            rules: [{ toolName }],
            behavior: 'allow' as const,
            destination: 'localSettings' as const,
          }]
        : undefined,
    }
  } else if (YES_WORDS.has(lower)) {
    response = { behavior: 'allow' }
  } else if (NO_WORDS.has(lower)) {
    response = { behavior: 'deny' }
  }

  if (response === null) return false

  for (const [, handler] of PENDING) {
    handler(response)
  }
  PENDING.clear()
  PENDING_TOOL_NAMES.clear()
  return true
}

/** Maps requestId → toolName so "always" replies can name the rule. */
const PENDING_TOOL_NAMES = new Map<string, string>()

export function createTelegramPermissionCallbacks(token: string): BridgePermissionCallbacks {
  return {
    sendRequest(requestId, toolName, _input, _toolUseId, description) {
      const chatId = readTelegramConfig().linkedChatId
      if (chatId === undefined) return

      // Store toolName for potential "always" reply
      PENDING_TOOL_NAMES.set(requestId, toolName)

      const msg = [
        `🔐 *Permission required*`,
        `\`${toolName}\``,
        description,
        ``,
        `Reply:`,
        `• *y* — allow once`,
        `• *always* — allow always (saves to settings)`,
        `• *n* — deny`,
      ].join('\n')
      void sendMessage(token, chatId, msg).catch(() => {})
    },

    sendResponse(_requestId, _response) {
      // no-op: responses come in from the poll loop, not pushed by us
    },

    cancelRequest(requestId) {
      PENDING.delete(requestId)
      PENDING_TOOL_NAMES.delete(requestId)
    },

    onResponse(requestId, handler) {
      PENDING.set(requestId, handler)
      return () => {
        PENDING.delete(requestId)
        PENDING_TOOL_NAMES.delete(requestId)
      }
    },
  }
}
