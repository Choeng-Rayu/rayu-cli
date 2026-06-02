import { useCallback, useEffect, useRef } from 'react'
import React from 'react'
import { getBotToken } from '../telegram/telegramConfig.js'
import {
  initTelegramBridge,
  type TelegramBridgeHandle,
} from '../telegram/telegramBridge.js'
import type { ContentBlock, WrappedMessage } from '../telegram/formatActivity.js'
import { isFileChangeReviewMessage } from '../telegram/formatActivity.js'
import { useSetAppState } from '../state/AppState.js'

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
 * Always-on Telegram bridge. Activates when TELEGRAM_BOT_TOKEN is in the env.
 *
 * Responsibilities:
 *  1. Long-polls api.telegram.org for inbound messages and routes them to the REPL.
 *  2. Mirrors completed user/assistant messages to the linked chat.
 *  3. Injects permission callbacks into AppState so tool-use prompts appear in chat.
 *  4. Streams live assistant output via throttled Telegram message edits.
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

  useEffect(() => {
    const token = getBotToken()
    if (!token) return

    const handle = initTelegramBridge({ token })
    handleRef.current = handle

    setAppState(prev => ({ ...prev, telegramPermissionCallbacks: handle.permissionCallbacks }))

    return () => {
      void handle.endTurn()
      handle.stop()
      handleRef.current = null
      lastSentIndexRef.current = 0
      inTurnRef.current = false
      setAppState(prev => ({ ...prev, telegramPermissionCallbacks: undefined }))
    }
  }, [setAppState])

  // Mirror completed user/assistant messages after each turn.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const start = Math.min(lastSentIndexRef.current, messages.length)
    const fresh: WrappedMessage[] = []
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      const isTR = msg ? isToolResultMessage(msg) : false
      // Forward assistant messages, tool-result user messages (images), and
      // file_change_review system messages. Skip plain human-typed user messages.
      if (msg && (msg.type === 'assistant' || isTR || isFileChangeReviewMessage(msg))) fresh.push(msg)
    }
    lastSentIndexRef.current = messages.length
    if (fresh.length > 0) handle.pushActivity(fresh)
  }, [messages])

  /**
   * Wrap the REPL's existing onStreamingText callback to also forward deltas
   * to the Telegram streaming mirror. The REPL calls this with a state updater
   * function `f`; we extract the new text by calling f(null) to get the first
   * token, then track accumulated text to compute the delta each time.
   *
   * Pattern: REPL does: onStreamingText(text => (text ?? '') + delta)
   * We detect the new token by passing '' as current (the delta is the full return
   * minus the empty seed, giving us back the delta string itself).
   */
  const accumulatedRef = useRef<string>('')

  const wrapOnStreamingText = useCallback(
    (
      base: (f: (current: string | null) => string | null) => void,
    ) => (f: (current: string | null) => string | null): void => {
      // Extract the delta by running f with empty string — returns accumulated delta
      const after = f(accumulatedRef.current)
      if (after !== null && after !== accumulatedRef.current) {
        const delta = after.slice(accumulatedRef.current.length)
        accumulatedRef.current = after
        const handle = handleRef.current
        if (handle) {
          // Start the streaming mirror on the first token of each turn
          if (!inTurnRef.current) {
            inTurnRef.current = true
            handle.startTurn()
          }
          handle.onTextDelta(delta)
        }
      } else if (after === null) {
        // null means the stream was reset (new content block started)
        // Finalize the previous turn mirror and reset state
        accumulatedRef.current = ''
        if (inTurnRef.current) {
          inTurnRef.current = false
          void handleRef.current?.endTurn()
        }
      }
      // Always call the original so REPL state stays in sync
      base(f)
    },
    [],
  )

  return { wrapOnStreamingText }
}
