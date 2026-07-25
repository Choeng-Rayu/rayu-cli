import { useCallback, useEffect, useRef } from 'react'
import React from 'react'
import {
  getBotToken,
  getTelegramMode,
  readTelegramConfig,
  telegramTransportKey,
} from '../telegram/telegramConfig.js'
import {
  initTelegramBridge,
  type TelegramBridgeHandle,
} from '../telegram/telegramBridge.js'
import type { ContentBlock, WrappedMessage } from '../telegram/formatActivity.js'
import { isFileChangeReviewMessage } from '../telegram/formatActivity.js'
import { sendMessage, setHostedRouter } from '../telegram/telegramApi.js'
import { createHostedRouter } from '../telegram/telegramTransport.js'
import { hasRayuSession } from '../services/rayuAuth/rayuSession.js'
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
  // Which bot the bridge should be talking to. Re-running the effect on a change
  // is what makes switching bots mid-session actually switch: `token` and the
  // hosted router below are captured once per bridge instance.
  const transportKey = useAppState(s => s.telegramTransportKey)

  useEffect(() => {
    if (!bridgeActive) return

    // Resolve the transport: hosted (shared Rayu bot via backend) or BYO token.
    const mode = getTelegramMode()
    let token: string
    if (mode === 'hosted') {
      // Shared bot needs a signed-in Rayu session; route all Telegram calls
      // through the backend. A sentinel token satisfies the (now unused) token
      // params — the hosted router ignores it.
      if (!hasRayuSession()) {
        // Don't leave the session claiming to be connected when it isn't.
        setAppState(prev => ({ ...prev, telegramBridgeActive: false }))
        return
      }
      setHostedRouter(createHostedRouter())
      token = 'hosted'
    } else {
      const byo = getBotToken()
      if (!byo) {
        setAppState(prev => ({ ...prev, telegramBridgeActive: false }))
        return
      }
      setHostedRouter(null)
      token = byo
    }

    const handle = initTelegramBridge({ token })
    handleRef.current = handle

    setAppState(prev => ({ ...prev, telegramPermissionCallbacks: handle.permissionCallbacks }))

    // The bot this bridge instance was built for. Cleanup compares it against
    // live config to tell a genuine stop apart from a hand-off to another bot
    // (the effect re-running because the transport changed).
    const builtTransport = telegramTransportKey()

    return () => {
      void handle.endTurn()
      const chatId = readTelegramConfig().linkedChatId
      const isHandoff = telegramTransportKey() !== builtTransport
      // Notify the linked chat that the CLI session closed (routes via the
      // hosted backend or directly, depending on mode). Clear the hosted router
      // only AFTER that notice is sent so it doesn't race to Telegram directly.
      // On a hand-off this goes out over the OLD token, which is exactly what
      // stops the previous bot from looking still-connected.
      const notice =
        chatId !== undefined
          ? sendMessage(token, chatId, '🔌 Session closed — rayu-cli disconnected.').catch(() => {})
          : Promise.resolve()
      handle.stop()
      void notice.finally(() => setHostedRouter(null))
      handleRef.current = null
      lastSentIndexRef.current = 0
      inTurnRef.current = false
      setAppState(prev => ({
        ...prev,
        telegramPermissionCallbacks: undefined,
        // Only lower the latch when this really is the end of the connection.
        // On a hand-off the next effect run is already starting a replacement
        // bridge, and clearing the flag here would immediately tear it down.
        ...(isHandoff ? {} : { telegramBridgeActive: false }),
      }))
    }
  }, [bridgeActive, transportKey, setAppState])

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
