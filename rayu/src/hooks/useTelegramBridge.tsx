import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import type { Message } from '../types/message.js'
import { getBotToken } from '../telegram/telegramConfig.js'
import {
  initTelegramBridge,
  type TelegramBridgeHandle,
} from '../telegram/telegramBridge.js'

/**
 * Always-on Telegram bridge: injects inbound chat messages as REPL turns and
 * mirrors new user/assistant messages to the linked chat. No middle server —
 * the CLI process long-polls api.telegram.org directly.
 *
 * Inbound prompts are routed through onIncomingPromptRef so the bridge can be
 * wired before REPL's handleIncomingPrompt is defined.
 */
export function useTelegramBridge(
  messages: Message[],
  onIncomingPromptRef: React.RefObject<((text: string) => void) | null>,
): void {
  const handleRef = useRef<TelegramBridgeHandle | null>(null)
  const lastSentIndexRef = useRef(0)

  useEffect(() => {
    if (!feature('TELEGRAM_BRIDGE')) return
    const token = getBotToken()
    if (!token) return
    handleRef.current = initTelegramBridge({
      token,
      onInboundPrompt: text => onIncomingPromptRef.current?.(text),
    })
    return () => {
      handleRef.current?.stop()
      handleRef.current = null
      lastSentIndexRef.current = 0
    }
  }, [onIncomingPromptRef])

  // Mirror new user/assistant messages to the linked chat as they appear.
  useEffect(() => {
    if (!feature('TELEGRAM_BRIDGE')) return
    const handle = handleRef.current
    if (!handle) return
    const start = Math.min(lastSentIndexRef.current, messages.length)
    const fresh: Message[] = []
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      if (msg && (msg.type === 'user' || msg.type === 'assistant')) fresh.push(msg)
    }
    lastSentIndexRef.current = messages.length
    if (fresh.length > 0) handle.pushActivity(fresh)
  }, [messages])
}
