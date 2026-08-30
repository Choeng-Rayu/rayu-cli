/**
 * Telegram bridge connection health + poll backoff (T-4, T-6).
 *
 * WHY THIS EXISTS. The bridge used to answer "am I connected?" with "the last
 * poll call did not throw" — and every failure path returned a benign empty
 * value (`[]` / `{linked:false, updates:[]}`), so a dead backend was
 * indistinguishable from an idle chat. Two consequences:
 *
 *  1. the poll loop spun with no delay, hammering the backend and burning CPU
 *     (there was no `await` that actually waited on a failure); and
 *  2. the CLI kept reporting a live connection after the link was revoked
 *     server-side, because the `linked` flag was discarded by the transport.
 *
 * So failures are now TYPED (PollOutcome, declared next to the transport seam in
 * telegramApi.ts), retries are BACKED OFF with jitter, and the resulting state
 * is published here as a small store the TUI can subscribe to.
 *
 * Module-level store + signal rather than AppState: the poll loop is plain
 * module code with no React context, and non-React callers need to read the same
 * state. Consumers use useSyncExternalStore over
 * subscribeToTelegramHealth/getTelegramHealthSnapshot.
 */

import type { PollFailureKind } from './telegramApi.js'
import { createSignal } from '../utils/signal.js'

/**
 * What the TUI shows:
 *  - `unconfigured` — no bridge in this session (never linked, or stopped).
 *    The indicator renders nothing at all in this state.
 *  - `connected`    — the transport is working.
 *  - `reconnecting` — failing but still retrying; may recover on its own.
 *  - `disconnected` — not usable: the link was revoked, the Rayu session is
 *    invalid, or retries have failed long enough that calling it "reconnecting"
 *    would be misleading. Retries continue (at the ceiling) unless the link is
 *    gone, so this can still recover.
 */
export type TelegramConnectionStatus =
  | 'unconfigured'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

export interface TelegramHealth {
  status: TelegramConnectionStatus
  /** Epoch ms of the last successful poll, or null if there has never been one. */
  lastSuccessAt: number | null
  /** Consecutive failures since the last success. 0 when healthy. */
  consecutiveFailures: number
  /** Why the most recent failure happened, for the status detail line. */
  lastFailureKind: PollFailureKind | null
}

/**
 * Consecutive failures before `reconnecting` becomes `disconnected`.
 *
 * Five failures is ~31 s of elapsed backoff (1+2+4+8+16), i.e. long enough that
 * a transient blip has already recovered. Past that, describing the bridge as
 * "reconnecting" oversells it.
 */
const DISCONNECT_AFTER_FAILURES = 5

const UNCONFIGURED: TelegramHealth = Object.freeze({
  status: 'unconfigured' as const,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastFailureKind: null,
})

let snapshot: TelegramHealth = UNCONFIGURED
const healthChanged = createSignal()

/**
 * Sticky flag for "the link was revoked server-side".
 *
 * Without it the red indicator would flash for only a few milliseconds: the poll
 * loop reports the revocation, then immediately stops the bridge, and a normal
 * stop resets the state to `unconfigured` (which renders nothing). The user would
 * never see WHY their connection went away. Cleared when a new bridge starts.
 */
let linkRevoked = false

/** useSyncExternalStore subscribe half. */
export const subscribeToTelegramHealth = healthChanged.subscribe

/**
 * useSyncExternalStore snapshot half. The returned object is frozen and only
 * changes identity when something actually changed, so React won't re-render on
 * every poll tick.
 */
export function getTelegramHealthSnapshot(): TelegramHealth {
  return snapshot
}

function publish(next: TelegramHealth): void {
  if (
    next.status === snapshot.status &&
    next.lastSuccessAt === snapshot.lastSuccessAt &&
    next.consecutiveFailures === snapshot.consecutiveFailures &&
    next.lastFailureKind === snapshot.lastFailureKind
  ) {
    return
  }
  snapshot = Object.freeze(next)
  healthChanged.emit()
}

/**
 * The bridge has started for a chat that is already linked.
 *
 * Reports `connected` OPTIMISTICALLY. A hosted long-poll parks for up to 25 s
 * when the chat is idle, so waiting for the first response would leave the
 * indicator amber for half a minute after a successful pairing — which reads as
 * a bug. A genuine outage fails fast and flips this to `reconnecting` within
 * milliseconds, so the optimism is bounded by one failed request.
 */
export function reportBridgeStarted(): void {
  linkRevoked = false
  publish({
    status: 'connected',
    lastSuccessAt: Date.now(),
    consecutiveFailures: 0,
    lastFailureKind: null,
  })
}

/** A poll came back cleanly. */
export function reportPollSuccess(): void {
  publish({
    status: 'connected',
    lastSuccessAt: Date.now(),
    consecutiveFailures: 0,
    lastFailureKind: null,
  })
}

/** A poll failed. `kind` decides whether this is recoverable. */
export function reportPollFailure(kind: PollFailureKind): void {
  const consecutiveFailures = snapshot.consecutiveFailures + 1
  // `unlinked` and `auth` are not transient: the chat binding is gone, or there
  // is no usable Rayu session. Retrying cannot fix either, so don't imply it.
  const terminal = kind === 'unlinked' || kind === 'auth'
  publish({
    status:
      terminal || consecutiveFailures >= DISCONNECT_AFTER_FAILURES
        ? 'disconnected'
        : 'reconnecting',
    lastSuccessAt: snapshot.lastSuccessAt,
    consecutiveFailures,
    lastFailureKind: kind,
  })
}

/**
 * The backend reported that this account has no linked chat. Terminal AND
 * sticky: it survives the bridge teardown that immediately follows, so the
 * terminal keeps showing why the connection ended until the user re-pairs.
 */
export function reportLinkRevoked(): void {
  linkRevoked = true
  publish({
    status: 'disconnected',
    lastSuccessAt: snapshot.lastSuccessAt,
    consecutiveFailures: snapshot.consecutiveFailures + 1,
    lastFailureKind: 'unlinked',
  })
}

/** The bridge stopped (session closing, or handed off to another bot). */
export function reportBridgeStopped(): void {
  // A revoked link is the one stop reason worth keeping on screen.
  if (linkRevoked) return
  publish(UNCONFIGURED)
}

/** Test helper — restores the pristine unconfigured state. */
export function _resetTelegramHealth(): void {
  linkRevoked = false
  snapshot = UNCONFIGURED
}

/** What the footer indicator renders. `null` means render nothing at all. */
export interface TelegramStatusInfo {
  label: string
  color: 'success' | 'warning' | 'error'
}

/**
 * Map health onto a label and theme colour. Pure, and separate from the
 * component, so the mapping is assertable without rendering a terminal — same
 * split as getBridgeStatus in bridge/bridgeStatusUtil.ts.
 */
export function getTelegramStatus(
  health: TelegramHealth,
): TelegramStatusInfo | null {
  switch (health.status) {
    case 'unconfigured':
      // Never linked, or cleanly stopped. Users who don't use Telegram must not
      // see a Telegram row in their footer at all.
      return null
    case 'connected':
      return { label: 'Telegram connected', color: 'success' }
    case 'reconnecting':
      return { label: 'Telegram reconnecting', color: 'warning' }
    case 'disconnected':
      return {
        // Distinguish "your link is gone, re-pair" from "we can't reach the
        // backend right now" — the remedies are completely different.
        label:
          health.lastFailureKind === 'unlinked'
            ? 'Telegram unlinked'
            : health.lastFailureKind === 'auth'
              ? 'Telegram signed out'
              : 'Telegram disconnected',
        color: 'error',
      }
  }
}

/**
 * Retry schedule for a failing poll: 1 → 2 → 4 → 8 → 16 → 30 → 60 s, then held
 * at 60 s. Reset on the first success.
 */
const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000]

/** ±25% so N sessions recovering from one outage don't retry in lockstep. */
const JITTER_RATIO = 0.25

export class PollBackoff {
  private failures = 0

  get consecutiveFailures(): number {
    return this.failures
  }

  /** Called after a successful poll. */
  reset(): void {
    this.failures = 0
  }

  /**
   * Delay before the next attempt, and advance the schedule.
   *
   * `hintMs` is a server-supplied floor (Telegram's `retry_after`, or a
   * `Retry-After` header from the backend's rate limiter). Honoured as a MINIMUM
   * rather than a replacement, so a tiny hint can't defeat the backoff.
   */
  nextDelayMs(hintMs?: number): number {
    const step =
      BACKOFF_STEPS_MS[Math.min(this.failures, BACKOFF_STEPS_MS.length - 1)] ??
      BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!
    this.failures++
    const base = Math.max(step, hintMs ?? 0)
    const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1)
    return Math.max(0, Math.round(base + jitter))
  }
}
