/**
 * Web Bridge hook — makes this REPL session drivable from the rayu-web studio.
 *
 * A deliberate mirror of `useTelegramBridge`, and the symmetry is the point: both
 * remotes are observed through the same three seams, so a change to how turns are
 * watched cannot land on one and miss the other.
 *
 *   1. an effect gated on an explicit opt-in flag (`webBridgeActive`, set by
 *      `/web-bridge`), which owns the connection's lifetime;
 *   2. permission callbacks injected into AppState, so tool prompts reach the browser;
 *   3. `wrapOnStreamingText`, which the REPL wraps around its own streaming callback to
 *      tap deltas without the bridge having to know how streaming works.
 *
 * OPT-IN, AND THAT IS A SECURITY DECISION. Connecting means a browser tab can send
 * prompts to this machine and approve tool calls on it. Nobody gets that by upgrading
 * the CLI. The connection also does not survive the session: closing the terminal
 * unmounts this hook and drops the socket, so the next session starts disconnected.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { WebBridgeConnectionState } from '@rayu-dev/web-bridge-client'

import { hasRayuSession } from '../services/rayuAuth/rayuSession.js'
import type { WrappedMessage } from '../telegram/formatActivity.js'
import { isFileChangeReviewMessage } from '../telegram/formatActivity.js'
import { initWebBridge, type WebBridgeHandle } from '../webBridge/webBridgeSession.js'
import { useAppState, useSetAppState } from '../state/AppState.js'

/** True for user messages that are tool results rather than human-typed text. */
function isToolResultMessage(msg: WrappedMessage): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    b => b != null && typeof b === 'object' && b.type === 'tool_result',
  )
}

export function useWebBridge(
  messages: WrappedMessage[],
): {
  wrapOnStreamingText: (
    base: (f: (current: string | null) => string | null) => void,
  ) => (f: (current: string | null) => string | null) => void
} {
  const handleRef = useRef<WebBridgeHandle | null>(null)
  const lastSentIndexRef = useRef(0)
  const inTurnRef = useRef(false)
  const setAppState = useSetAppState()

  const bridgeActive = useAppState(s => s.webBridgeActive)

  useEffect(() => {
    if (!bridgeActive) return

    /*
     * A signed-in Rayu account is the whole authorisation model: the socket presents
     * that account's JWT and the backend routes only to sessions owned by it.
     *
     * Checked here rather than inside the client so the flag is lowered too — leaving
     * `webBridgeActive` true while nothing is connected would make the footer claim a
     * connection that does not exist, and `/web-bridge` would then report it as
     * already on.
     */
    if (!hasRayuSession()) {
      setAppState(prev => ({ ...prev, webBridgeActive: false }))
      return
    }

    const handle = initWebBridge({
      onConnectionChange: (state: WebBridgeConnectionState) => {
        setAppState(prev => ({ ...prev, webBridgeConnection: state }))
      },
    })
    handleRef.current = handle

    setAppState(prev => ({
      ...prev,
      webBridgePermissionCallbacks: handle.permissionCallbacks,
    }))

    return () => {
      void handle.endTurn()
      handle.stop()
      handleRef.current = null
      lastSentIndexRef.current = 0
      inTurnRef.current = false
      setAppState(prev => ({
        ...prev,
        webBridgePermissionCallbacks: undefined,
        webBridgeConnection: 'idle',
        webBridgeActive: false,
      }))
    }
  }, [bridgeActive, setAppState])

  /*
   * Mirror settled messages after each turn.
   *
   * Only assistant messages, tool results and file-change reviews — the same selection
   * the Telegram bridge makes. User prompts are excluded on purpose: the backend
   * already echoes a prompt to every tab when it routes one, so mirroring it here would
   * show remotely-sent prompts twice.
   */
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const start = Math.min(lastSentIndexRef.current, messages.length)
    const fresh: WrappedMessage[] = []
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      if (
        msg.type === 'assistant' ||
        isToolResultMessage(msg) ||
        isFileChangeReviewMessage(msg)
      ) {
        fresh.push(msg)
      }
    }
    lastSentIndexRef.current = messages.length
    if (fresh.length > 0) handle.pushActivity(fresh)
  }, [messages])

  /**
   * Wrap the REPL's `onStreamingText` so deltas also reach the studio.
   *
   * The REPL hands the accumulated string, not the increment, so the delta is derived
   * by diffing against what was last seen. A null value is the REPL's signal that the
   * turn ended, which is what closes the stream.
   */
  const accumulatedRef = useRef<string>('')

  const wrapOnStreamingText = useCallback(
    (base: (f: (current: string | null) => string | null) => void) =>
      (f: (current: string | null) => string | null): void => {
        const after = f(accumulatedRef.current)
        const handle = handleRef.current

        if (after !== null && after !== accumulatedRef.current) {
          const delta = after.slice(accumulatedRef.current.length)
          accumulatedRef.current = after
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
            if (handle) void handle.endTurn()
          }
        }

        base(f)
      },
    [],
  )

  return { wrapOnStreamingText }
}
