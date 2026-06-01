import { useEffect, useRef } from 'react'
import React from 'react'
import { getBotToken } from '../telegram/telegramConfig.js'
import {
  initTelegramBridge,
  type TelegramBridgeHandle,
} from '../telegram/telegramBridge.js'
import type { WrappedMessage } from '../telegram/formatActivity.js'

/**
 * Always-on Telegram bridge: injects inbound chat messages as REPL turns and
 * mirrors new user/assistant messages to the linked chat. Activates only when
 * TELEGRAM_BOT_TOKEN is present in the environment.
 */
export function useTelegramBridge(
  messages: WrappedMessage[],
  onIncomingPromptRef: React.RefObject<((text: string) => void) | null>,
): void {
  const handleRef = useRef<TelegramBridgeHandle | null>(null)
  const lastSentIndexRef = useRef(0)

  useEffect(() => {
    const token = getBotToken()
    if (!token) return

    handleRef.current = initTelegramBridge({
      token,
      onInboundPrompt: (text: string) => onIncomingPromptRef.current?.(text),
    })

    return () => {
      handleRef.current?.stop()
      handleRef.current = null
      lastSentIndexRef.current = 0
    }
  }, [onIncomingPromptRef])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return

    const start = Math.min(lastSentIndexRef.current, messages.length)
    const fresh: WrappedMessage[] = []
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      if (msg && (msg.type === 'user' || msg.type === 'assistant')) {
        fresh.push(msg)
      }
    }
    lastSentIndexRef.current = messages.length
    if (fresh.length > 0) handle.pushActivity(fresh)
  }, [messages])
}
