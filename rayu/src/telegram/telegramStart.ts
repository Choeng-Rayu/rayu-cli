/**
 * The ONE place that decides whether this process runs the Telegram bridge, and with
 * which transport.
 *
 * ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────────
 *
 * The bridge used to be started by `useTelegramBridge`, a React hook, which only the
 * Ink REPL mounts. The Rayucode VS Code engine is headless (`--print`), so it never
 * mounted the REPL, so nothing ever polled Telegram inside the editor: the Settings
 * card said "connected" because a pairing record existed, while every inbound message
 * stayed parked on the backend. The fix is not a second bridge implementation — it is
 * putting the decision (and the transport wiring) somewhere both hosts can call.
 *
 * `resolveTelegramTransport` is shared with the REPL hook so the hosted/BYO rules
 * cannot drift between the terminal and the editor.
 *
 * ── WHO SHOULD ATTACH ──────────────────────────────────────────────────────────
 *
 * Only the process the chat is attached to. A link alone is not enough: `telegram.json`
 * is machine-wide, and a machine may run several `rayu-cli` processes (a terminal REPL,
 * one engine child per open conversation in the editor). If every process started a
 * poller, they would fight over `telegram-bridge.lock` and every turn would be mirrored
 * into the chat by whichever process happened to win.
 *
 * The rule is the same one the REPL has always used for auto-reconnect: a link exists,
 * auto-reconnect is enabled, and the remembered session is this one — matched by session
 * id, or by working directory because `/resume` mutates the id in place. The remembered
 * session is written by `/telegram-bot`, by `/switch`, and by the editor when a pairing
 * completes (see `restartTelegramLinkedSession` in the extension).
 *
 * ── A LINK MADE WHILE RUNNING IS PICKED UP BY A RESTART ────────────────────────
 *
 * An engine reads `telegram.json`, `telegram-attached.json` and the auto-attach memory
 * when it starts. A link made later needs a restart, which both hosts already perform:
 * the REPL hook re-runs when `telegramTransportKey` changes, and the extension restarts
 * the linked conversation's engine. This module therefore needs no watcher.
 */
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { hasRayuSession } from '../services/rayuAuth/rayuSession.js'
import { initTelegramBridge, type TelegramBridgeHandle } from './telegramBridge.js'
import { setHostedRouter } from './telegramApi.js'
import { createHostedRouter } from './telegramTransport.js'
import {
  getBotToken,
  getTelegramMode,
  isAutoReconnectEnabled,
  readAutoAttach,
  readTelegramConfig,
  telegramTransportKey,
} from './telegramConfig.js'

/** Where the bridge should talk, resolved at start time. */
export interface TelegramTransport {
  /**
   * The bot token for BYO, or the `'hosted'` sentinel. The hosted router ignores the
   * token; every call is relayed through `rayu-backend` with the Rayu session.
   */
  token: string
  /** `hosted:<bot>` / `byo:<botId>` — the bridge's lifecycle key. */
  transportKey: string
}

/**
 * Resolve the transport and install it, or return null when this process cannot talk to
 * Telegram at all (hosted without a Rayu session, BYO without a saved token).
 *
 * Installing is a side effect on purpose: `sendMessage`/`getUpdates` read the router from
 * module state, so whichever host starts a bridge must set it first.
 */
export function resolveTelegramTransport(): TelegramTransport | null {
  const mode = getTelegramMode()
  if (mode === 'hosted') {
    // The shared bot's token lives on the backend; without a session there is nothing
    // to authenticate the relay with.
    if (!hasRayuSession()) return null
    setHostedRouter(createHostedRouter())
    return { token: 'hosted', transportKey: telegramTransportKey() }
  }

  const byo = getBotToken()
  if (!byo) return null
  // Clear a router left behind by an earlier hosted session: the BYO path talks to
  // api.telegram.org directly.
  setHostedRouter(null)
  return { token: byo, transportKey: telegramTransportKey() }
}

/** The decisions `shouldAutoAttach` needs, so the rule is testable without disk. */
export interface AutoAttachInput {
  /** `telegram.json`'s link, if any. */
  linkedChatId: number | undefined
  autoReconnect: boolean
  /** The remembered session, if present and within its TTL. */
  remembered: { sessionId: string; cwd: string } | undefined
  /** This process's session id. */
  sessionId: string
  /** This process's working directory, normalized like the remembered one. */
  cwd: string
}

/**
 * Whether this process should attach itself to the linked chat on startup.
 *
 * Pure, so every branch is unit-testable. An empty remembered id never matches on the
 * id — the editor writes `''` when a conversation's engine has not reported an id yet,
 * and two empty strings matching would attach an unrelated workspace — so that case
 * must match on the working directory.
 */
export function shouldAutoAttach(input: AutoAttachInput): boolean {
  if (input.linkedChatId === undefined) return false
  if (!input.autoReconnect) return false
  if (!input.remembered) return false
  const rememberedId = input.remembered.sessionId
  if (rememberedId !== '' && rememberedId === input.sessionId) return true
  return input.remembered.cwd === input.cwd
}

/**
 * A BYO pairing is waiting for its `/start <token>`.
 *
 * The pending token is CONSUMED BY THE BRIDGE (`consumePendingToken` runs on the
 * `/start` update), so pairing cannot finish unless some process is polling. In the
 * editor the engine is the only candidate — without this branch, a BYO link started
 * from Settings would wait forever unless a terminal REPL happened to be running.
 *
 * Time-bound by the token's own TTL, and only in BYO mode (the shared bot pairs
 * server-side, with no local polling involved).
 */
export function hasPendingByoPairing(): boolean {
  if (getTelegramMode() !== 'byo') return false
  if (!getBotToken()) return false
  const pending = readTelegramConfig().pendingToken
  return pending !== undefined && pending.expiresAt > Date.now()
}

/**
 * Whether this process should run the bridge.
 *
 * A live link with this session remembered, OR a BYO pairing in flight anywhere on
 * the machine — whichever comes first. See `shouldAutoAttach` for why "a link exists"
 * alone is not enough.
 */
export function shouldStartTelegramBridge(): boolean {
  if (hasPendingByoPairing()) return true
  return shouldAutoAttach({
    linkedChatId: readTelegramConfig().linkedChatId,
    autoReconnect: isAutoReconnectEnabled(),
    remembered: readAutoAttach(),
    sessionId: getSessionId(),
    cwd: getOriginalCwd(),
  })
}

/**
 * Start the bridge for this process, or return null when it should not run here.
 *
 * A returned handle may still be a no-op: another live process can own
 * `telegram-bridge.lock`. Callers must check `handle.isNoOp` before using it as a
 * mirror, and should instead forward through the IPC attachment (see
 * `telegramRemoteBridge.ts`).
 */
export function startTelegramBridge(): TelegramBridgeHandle | null {
  if (!shouldStartTelegramBridge()) return null
  const transport = resolveTelegramTransport()
  if (!transport) return null
  return initTelegramBridge({ token: transport.token })
}
