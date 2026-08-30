import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import React from 'react'
import {
  getBotToken,
  getTelegramMode,
  isAutoReconnectEnabled,
  readAutoAttach,
  readTelegramConfig,
  telegramTransportKey,
} from '../telegram/telegramConfig.js'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { readSessionRecords } from '../utils/concurrentSessions.js'
import {
  initTelegramBridge,
  type TelegramBridgeHandle,
} from '../telegram/telegramBridge.js'
import type { ContentBlock, WrappedMessage } from '../telegram/formatActivity.js'
import { isFileChangeReviewMessage } from '../telegram/formatActivity.js'
import { sendMessage, setHostedRouter } from '../telegram/telegramApi.js'
import { createHostedRouter } from '../telegram/telegramTransport.js'
import {
  getTelegramHealthSnapshot,
  subscribeToTelegramHealth,
} from '../telegram/telegramHealth.js'
import {
  getRemotePermissionCallbacks,
  isRemotelyAttached,
  remoteActivity,
  remoteStreamDelta,
  remoteStreamEnd,
  remoteStreamStart,
  subscribeToRemoteBridge,
} from '../telegram/telegramRemoteBridge.js'
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
      // Notify the linked chat that this session closed (routes via the hosted
      // backend or directly, depending on mode). Clear the hosted router only
      // AFTER that notice is sent so it doesn't race to Telegram directly.
      // On a hand-off this goes out over the OLD token, which is exactly what
      // stops the previous bot from looking still-connected.
      //
      // The wording depends on what is LEFT: claiming "rayu-cli disconnected"
      // while three other sessions are still running would be wrong, and would
      // hide the fact that /switch can recover the chat immediately.
      const notice =
        chatId !== undefined
          ? readSessionRecords()
              .then(records => {
                const others = records.filter(r => r.pid !== process.pid)
                const text =
                  others.length === 0
                    ? '🔌 Session closed — rayu-cli disconnected.'
                    : `🔌 This session closed. ${others.length} other session${others.length === 1 ? '' : 's'} still open — send /sessions to pick one.`
                return sendMessage(token, chatId, text)
              })
              .then(() => undefined)
              .catch(() => undefined)
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

  /**
   * Auto-reconnect: reopening the session that was last driving the chat brings
   * the bridge back without `/telegram-bot`.
   *
   * Gated on four things, all of which must hold:
   *  - a link still exists (an explicit /disconnect clears both link and memory);
   *  - auto-reconnect has not been turned off;
   *  - the memory is within its TTL (see AUTO_ATTACH_TTL_MS); and
   *  - THIS session is the remembered one — by id, or by cwd because /resume
   *    mutates the session id in place.
   *
   * Runs once per session. If another session already holds the bridge lock this
   * still resolves correctly: that session keeps the transport and this one gets
   * a no-op handle.
   */
  useEffect(() => {
    if (bridgeActive) return
    if (!isAutoReconnectEnabled()) return
    const cfg = readTelegramConfig()
    if (cfg.linkedChatId === undefined) return
    const remembered = readAutoAttach()
    if (!remembered) return
    const isRemembered =
      remembered.sessionId === getSessionId() || remembered.cwd === getOriginalCwd()
    if (!isRemembered) return
    setAppState(prev => ({
      ...prev,
      telegramBridgeActive: true,
      telegramTransportKey: telegramTransportKey(),
    }))
    // Deliberately runs only on mount: this is a one-shot decision about how the
    // session starts, not a rule that should re-fire whenever state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Remote attachment (this session is driven by ANOTHER process's bridge).
   *
   * Ungated by `bridgeActive` on purpose: a session the user attaches with
   * /switch may never have run /telegram-bot itself, so it has no bridge of its
   * own — the leader tells it over IPC that it is driving the chat, and these
   * forwarding callbacks are what make its permission prompts reachable.
   */
  const remoteCallbacks = useSyncExternalStore(
    subscribeToRemoteBridge,
    getRemotePermissionCallbacks,
  )

  useEffect(() => {
    // Never override this session's OWN bridge callbacks: if it holds the lock
    // it can talk to Telegram directly, which is strictly better than a hop.
    if (bridgeActive) return
    setAppState(prev => ({
      ...prev,
      telegramPermissionCallbacks: remoteCallbacks,
    }))
    return () => {
      setAppState(prev =>
        prev.telegramPermissionCallbacks === remoteCallbacks
          ? { ...prev, telegramPermissionCallbacks: undefined }
          : prev,
      )
    }
  }, [remoteCallbacks, bridgeActive, setAppState])

  /**
   * T-6: the link can be revoked server-side at any time (the user sends
   * /disconnect in Telegram, which the backend intercepts and never forwards).
   * The poll loop detects that, drops the local binding and stops itself; this
   * lowers the session latch so the footer indicator, `/telegram-bot`, and the
   * bridge all agree there is no connection.
   */
  useEffect(() => {
    if (!bridgeActive) return
    return subscribeToTelegramHealth(() => {
      if (getTelegramHealthSnapshot().lastFailureKind === 'unlinked') {
        setAppState(prev => ({ ...prev, telegramBridgeActive: false }))
      }
    })
  }, [bridgeActive, setAppState])

  // Mirror completed user/assistant messages after each turn.
  useEffect(() => {
    const handle = handleRef.current
    const remote = isRemotelyAttached()
    // Nothing to mirror to: no local bridge and no leader driving this session.
    if ((!handle || handle.isNoOp) && !remote) return
    const start = Math.min(lastSentIndexRef.current, messages.length)
    const fresh: WrappedMessage[] = []
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      const isTR = msg ? isToolResultMessage(msg) : false
      if (msg && (msg.type === 'assistant' || isTR || isFileChangeReviewMessage(msg))) fresh.push(msg)
    }
    lastSentIndexRef.current = messages.length
    if (fresh.length === 0) return
    if (handle && !handle.isNoOp) handle.pushActivity(fresh)
    else if (remote) remoteActivity(fresh)
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
        } else if (isRemotelyAttached()) {
          // No local bridge — forward to the leader, which owns the mirror and
          // applies the same 800 ms edit throttle to remote and local turns.
          if (!inTurnRef.current) {
            inTurnRef.current = true
            remoteStreamStart()
          }
          remoteStreamDelta(delta)
        }
      } else if (after === null) {
        accumulatedRef.current = ''
        if (inTurnRef.current) {
          inTurnRef.current = false
          if (handleRef.current) void handleRef.current.endTurn()
          else if (isRemotelyAttached()) remoteStreamEnd()
        }
      }
      base(f)
    },
    [],
  )

  return { wrapOnStreamingText }
}
