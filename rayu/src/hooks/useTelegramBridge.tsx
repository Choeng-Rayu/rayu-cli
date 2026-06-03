import { useCallback, useEffect, useRef } from 'react'
import React from 'react'
import { getBotToken, readTelegramConfig } from '../telegram/telegramConfig.js'
import {
  initTelegramBridge,
  type TelegramBridgeHandle,
} from '../telegram/telegramBridge.js'
import type { ContentBlock, WrappedMessage } from '../telegram/formatActivity.js'
import { isFileChangeReviewMessage } from '../telegram/formatActivity.js'
import { sendMessage } from '../telegram/telegramApi.js'
import { useAppState, useSetAppState } from '../state/AppState.js'

/** True for user messages that are tool results (not human-typed text). */
function isToolResultMessage(msg: WrappedMessage): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    b => b != null && typeof b === 'object' && (b as ContentBlock).type === 'tool_result',
  )
}

/**
 * Telegram bridge hook — only active when the user explicitly connects
 * via `/telegram-bot` in this session (sets telegramBridgeActive = true).
 *
 * Responsibilities when active:
 *  1. Long-polls api.telegram.org for inbound messages and routes them to the REPL.
 *  2. Mirrors completed user/assistant messages to the linked chat.
 *  3. Injects permission callbacks into AppState so tool-use prompts appear in chat.
 *  4. Streams live assistant output via throttled Telegram message edits.
 *
 * When the session closes (component unmounts), the bridge stops automatically.
 * Next session starts disconnected — user must run /telegram-bot again.
 *
 * Returns a wrapOnStreamingText function that the REPL wraps its existing
 * onStreamingText with — this is the tap point for streaming deltas.
 */
export function useTelegramBridge(
  messages: WrappedMessage[],
): {
  wrapOnStreamingText: (
    base: (f: (current: string | null) => string | null) => void,
  ) => (f: (current: string | null) => string | null) => void
} {
  const handleRef = useRef<TelegramBridgeHandle | null>(null)
  const lastSentIndexRef = useRef(0)
  const inTurnRef = useRef(false)
  const setAppState = useSetAppState()

  // Only activate the bridge when the user has explicitly connected via /telegram-bot.
  const bridgeActive = useAppState(s => s.telegramBridgeActive)

  useEffect(() => {
    if (!bridgeActive) return

    const token = getBotToken()
    if (!token) return

    const handle = initTelegramBridge({ token })
    handleRef.current = handle

    setAppState(prev => ({ ...prev, telegramPermissionCallbacks: handle.permissionCallbacks }))

    return () => {
      void handle.endTurn()
      // Notify the Telegram user that the CLI session has disconnected.
      const chatId = readTelegramConfig().linkedChatId
      if (chatId && token) {
        void sendMessage(token, chatId, '🔌 Session closed — rayu-cli disconnected.').catch(() => {})
      }
      handle.stop()
      handleRef.current = null
      lastSentIndexRef.current = 0
      inTurnRef.current = false
      setAppState(prev => ({
        ...prev,
        telegramPermissionCallbacks: undefined,
        telegramBridgeActive: false,
      }))
    }
  }, [bridgeActive, setAppState])

  // Mirror completed user/assistant messages after each turn.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || handle.isNoOp) return
    const start = Math.min(lastSentIndexRef.current, messages.length)
    const fresh: WrappedMessage[] = []
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      const isTR = msg ? isToolResultMessage(msg) : false
      if (msg && (msg.type === 'assistant' || isTR || isFileChangeReviewMessage(msg))) fresh.push(msg)
    }
    lastSentIndexRef.current = messages.length
    if (fresh.length > 0) handle.pushActivity(fresh)
  }, [messages])

  /**
   * Wrap the REPL's existing onStreamingText callback to also forward deltas
   * to the Telegram streaming mirror.
   */
  const accumulatedRef = useRef<string>('')

  const wrapOnStreamingText = useCallback(
    (
      base: (f: (current: string | null) => string | null) => void,
    ) => (f: (current: string | null) => string | null): void => {
      const after = f(accumulatedRef.current)
      if (after !== null && after !== accumulatedRef.current) {
        const delta = after.slice(accumulatedRef.current.length)
        accumulatedRef.current = after
        const handle = handleRef.current
        if (handle) {
          if (!inTurnRef.current) {
            inTurnRef.current = true
            handle.startTurn()
          }
          handle.onTextDelta(delta)
        }
      } else if (after === null) {
        accumulatedRef.current = ''
        if (inTurnRef.current) {
          inTurnRef.current = false
          void handleRef.current?.endTurn()
        }
      }
      base(f)
    },
    [],
  )

  return { wrapOnStreamingText }
}
