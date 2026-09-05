/**
 * The rayu-cli REPL's Web Bridge session.
 *
 * Makes THIS terminal session drivable from the rayu-web studio: the studio lists every
 * signed-in worker, and a prompt typed in the browser lands in this REPL's input queue
 * as though it had been typed here. The rayucode extension is the other worker and
 * speaks the identical protocol, so a browser tab cannot tell them apart.
 *
 * The handle deliberately mirrors `TelegramBridgeHandle` (telegram/telegramBridge.ts)
 * field for field — pushActivity / startTurn / onTextDelta / onThinkingDelta / endTurn
 * / permissionCallbacks / stop / isNoOp. That is not incidental symmetry: `useWebBridge`
 * and `useTelegramBridge` then have the same shape, and the REPL's streaming tap wraps
 * both the same way, so a change to how turns are observed cannot land on one remote
 * surface and miss the other.
 *
 * ARCHITECTURALLY SIMPLER THAN TELEGRAM, FOR ONE REASON. Telegram has ONE chat for
 * however many sessions are open, so it needs a leader election, a bridge lock, an
 * attachment pointer and cross-process IPC to route a message to the right session.
 * The Web Bridge has no such contention: each session dials its own socket and the
 * backend keys them by `(user, machineId)`, so the studio's picker IS the routing.
 * There is no leader, no lock and no IPC here, and that absence is the design.
 */

import {
  WebBridgeClient,
  WebBridgePermissionRelay,
  resolveHostname,
  resolveMachineId,
  type WebBridgeConnectionState,
} from '@rayu-dev/web-bridge-client'

import type { BridgePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import type { WrappedMessage } from '../telegram/formatActivity.js'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { getRayuApiBaseUrl, getValidRayuAccessToken } from '../services/rayuAuth/rayuSession.js'
import { getRayuConfigHomeDir } from '../utils/envUtils.js'
import { interruptActiveTurn, isTurnInterruptible } from '../utils/activeTurn.js'
import { clearCommandQueue, enqueue, hasCommandsInQueue } from '../utils/messageQueueManager.js'
import { logForDebugging } from '../utils/debug.js'
import { formatActivityForWeb } from './formatActivityForWeb.js'
import { createWebBridgePermissionCallbacks } from './webBridgePermissions.js'

/**
 * The session surface the REPL drives.
 *
 * Mirrors `TelegramBridgeHandle`. `isNoOp` is retained for shape compatibility even
 * though the Web Bridge has no lock to lose — see the header. It is always false here,
 * which keeps the two hooks interchangeable at the call site.
 */
export interface WebBridgeHandle {
  /** Mirror complete REPL messages to the studio. */
  pushActivity: (messages: WrappedMessage[]) => void
  /** A new assistant turn began streaming. */
  startTurn: () => void
  /** One streamed text delta. */
  onTextDelta: (delta: string) => void
  /** One streamed thinking delta. */
  onThinkingDelta: (delta: string) => void
  /** The streaming turn finished. */
  endTurn: () => Promise<void>
  /** Injected into AppState so tool prompts reach the browser. */
  permissionCallbacks: BridgePermissionCallbacks
  stop: () => void
  /** Always false: there is no bridge lock to lose. Kept for handle parity. */
  isNoOp: boolean
  /** Current socket state, for the REPL footer indicator. */
  connectionState: () => WebBridgeConnectionState
  /** The backend session id, once the handshake completed. */
  sessionId: () => string | null
}

export interface WebBridgeOptions {
  /** Reflects connection changes into the REPL's state. */
  onConnectionChange?: (state: WebBridgeConnectionState) => void
}

/**
 * A label that identifies this worker in the studio's picker.
 *
 * Names the WORKER, not the machine. Without it a browser cannot tell this apart from
 * a rayucode extension host running on the same computer, and the two behave
 * differently enough that the user has to be able to choose.
 */
function sessionLabel(cwd: string): string {
  const leaf = cwd.split(/[\\/]/).filter(Boolean).pop()
  return leaf ? `rayu CLI — ${leaf}` : 'rayu CLI'
}

/**
 * Start the Web Bridge for this session.
 *
 * Never throws. The bridge is an optional, opt-in surface and a failure to reach the
 * backend must not be able to disturb the REPL — the caller learns about it through
 * `onConnectionChange`, and every emit is a no-op while disconnected.
 */
export function initWebBridge(options: WebBridgeOptions = {}): WebBridgeHandle {
  const cwd = getOriginalCwd() ?? process.cwd()

  const client = new WebBridgeClient({
    apiBaseUrl: getRayuApiBaseUrl(),
    getToken: getValidRayuAccessToken,
    hello: {
      // Persisted under the CLI's own config home, so `RAYU_CONFIG_DIR` isolation
      // gives an isolated machine identity too rather than leaking into `~/.rayu`.
      machineId: resolveMachineId(getRayuConfigHomeDir()),
      hostname: resolveHostname(),
      cwd,
      pid: process.pid,
      sessionLabel: sessionLabel(cwd),
    },
    handlers: {
      onPrompt: prompt => {
        /*
         * Straight into the REPL's input queue.
         *
         * `enqueue` is the same path a typed prompt takes, so a remote prompt inherits
         * queueing, slash-command parsing and the busy-session behaviour for free. It
         * also means a prompt sent while a turn is running QUEUES rather than being
         * dropped, which matches what happens when the user types during a turn.
         */
        enqueue({ value: prompt.text, mode: 'prompt' })
        logForDebugging(`[web-bridge] queued remote prompt (${prompt.text.length} chars)`)
      },

      onInterrupt: () => {
        /*
         * The remote equivalent of pressing Esc, using the same primitives as
         * telegram/telegramInterrupt.ts.
         *
         * Queued-but-unstarted work is cleared as well as the live turn. A remote user
         * pressing stop means "stop working", and stopping only the current turn while
         * three queued prompts then start executing is the opposite of that.
         */
        if (isTurnInterruptible()) interruptActiveTurn()
        else if (hasCommandsInQueue()) clearCommandQueue()
        // Acked unconditionally: the browser's composer must be re-enabled even when
        // there was nothing to stop, or a mistimed click leaves it disabled forever.
        client.interruptAck()
      },

      onDecision: decision => relay.handleDecision(decision),

      onHelloAck: ack => {
        logForDebugging(
          `[web-bridge] session ${getSessionId()} registered as ${ack.sessionId}`,
        )
      },

      onBridgeError: ({ message }) => {
        logForDebugging(`[web-bridge] backend refused a frame: ${message}`)
      },

      onConnectionChange: state => {
        // Drop pending correlations on a lost connection WITHOUT answering them: the
        // terminal dialog is still up and still authoritative. See
        // webBridgePermissions.ts.
        if (state === 'reconnecting' || state === 'error') relay.clear()
        options.onConnectionChange?.(state)
      },
    },
  })

  const relay = new WebBridgePermissionRelay(client)

  // Fire-and-forget: the REPL must not block its prompt on an optional network call.
  void client.connect()

  let inTurn = false

  return {
    pushActivity(messages: WrappedMessage[]): void {
      for (const line of formatActivityForWeb(messages)) {
        client.activity(line)
      }
    },

    startTurn(): void {
      inTurn = true
    },

    onTextDelta(delta: string): void {
      client.streamDelta(delta, 'text')
    },

    onThinkingDelta(delta: string): void {
      client.streamDelta(delta, 'thinking')
    },

    async endTurn(): Promise<void> {
      // Guarded so an end without a start cannot emit a stray `stream_end`, which the
      // browser reads as "turn finished" and would use to re-enable its composer
      // mid-turn.
      if (!inTurn) return
      inTurn = false
      client.streamEnd({})
    },

    permissionCallbacks: createWebBridgePermissionCallbacks(relay),

    stop(): void {
      relay.clear()
      client.stop()
    },

    isNoOp: false,

    connectionState: () => client.connectionState,
    sessionId: () => client.sessionId,
  }
}
