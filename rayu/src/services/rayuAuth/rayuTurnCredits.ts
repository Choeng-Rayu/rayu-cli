/**
 * The Rayu credits charged for one piece of work the user asked for, as the
 * gateway reported them, so a front end can say what it cost ("Credits: 2.4k").
 *
 * A front end opens a window when the user's message starts work, keeps it open
 * across every turn that work takes (background agents, the turns their
 * notifications start), and reads the total when the work is done:
 *
 *   const window = openRayuCreditWindow()   // the user's message starts work
 *   ...                                      // requests report their charges
 *   rayuWindowCredits(window)                // done: 2412.5, or undefined
 *   closeRayuCreditWindow(window)
 *
 * Every Rayu-billed request takes a ticket when it STARTS and reports its charge
 * on that ticket once the response says what it cost (`utils/rayuRequestCharge.ts`):
 *
 *   const ticket = startRayuCharge()
 *   ...send the request, read the response...
 *   recordRayuCharge(credits, ticket, 'repl_main_thread')
 *
 * The ticket holds the windows that were open when the request started, so a
 * charge counts toward the work that launched the request however late the
 * gateway reports it: a session-title request that settles after its turn's
 * line, or a request still in flight when its window closed, lands in its own
 * window and never in the next one.
 *
 * Each window keeps its own running total, and a ticket references only the
 * windows open at its start (one, in practice), so the total is exact for work
 * that makes thousands of model calls, and memory does not grow with the
 * session. The previous implementation kept one bucket per request start and
 * pruned all but the newest 1,024, which silently dropped the beginning of any
 * long run from its total.
 *
 * The figures are the gateway's own: nothing here prices tokens. Work that made
 * no Rayu-billed request (bring-your-own key, or a gateway too old to report
 * charges) has no total at all, which the front ends show as no figure.
 */
import { logForDebugging } from '../../utils/debug.js'

/** Credits are summed in millionths, so a total has no float drift. */
const MICRO = 1_000_000

type WindowTotal = {
  /** Millionths of a credit charged to this window so far. */
  microCredits: number
  /** How many charges were reported; 0 means "nothing was charged". */
  charges: number
}

/** One piece of work whose Rayu charges are being totalled. Read-only to callers. */
export type RayuCreditWindow = Readonly<WindowTotal>

/** The windows one request counts toward, captured when the request starts. */
export type RayuChargeTicket = Readonly<{ windows: readonly RayuCreditWindow[] }>

/** Windows that a request starting now counts toward. */
const openWindows = new Set<WindowTotal>()

/** Starts totalling the charges of requests that start from now on. */
export function openRayuCreditWindow(): RayuCreditWindow {
  const window: WindowTotal = { microCredits: 0, charges: 0 }
  openWindows.add(window)
  return window
}

/**
 * Stops the window from counting requests that start after this call. A request
 * that started while it was open still adds its charge when it settles.
 */
export function closeRayuCreditWindow(window: RayuCreditWindow): void {
  openWindows.delete(window as WindowTotal)
}

/** Whether `window` still counts requests that start now. */
export function isRayuCreditWindowOpen(window: RayuCreditWindow): boolean {
  return openWindows.has(window as WindowTotal)
}

/**
 * The credits charged to `window` so far, or `undefined` when no request in it
 * reported a charge. A real zero-value charge reads as `0`.
 */
export function rayuWindowCredits(window: RayuCreditWindow): number | undefined {
  return window.charges === 0 ? undefined : window.microCredits / MICRO
}

/** Takes a request's ticket. Call it just before the request is sent. */
export function startRayuCharge(): RayuChargeTicket {
  return { windows: [...openWindows] }
}

/**
 * Records what one Rayu-billed request was charged, against the windows that were
 * open when it started (`ticket`). Without a ticket the request is treated as
 * starting now. `undefined` (the response reported no charge) and anything that is
 * not a non-negative number are ignored.
 *
 * `source` names the feature that sent the request, the same value the gateway
 * logs as `source=`; it is only used for the `--debug` trace.
 */
export function recordRayuCharge(
  credits: number | undefined,
  ticket: RayuChargeTicket = startRayuCharge(),
  source?: string,
): void {
  if (credits === undefined || !Number.isFinite(credits) || credits < 0) return
  const micro = Math.round(credits * MICRO)
  for (const window of ticket.windows) {
    const total = window as WindowTotal
    total.microCredits += micro
    total.charges += 1
  }
  logForDebugging(
    `[rayu-credits] ${source ?? 'request'} charged ${credits} credits; ` +
      (ticket.windows.length === 0
        ? 'no work window was open when it started, so no turn line counts it'
        : `work total now ${ticket.windows
            .map(window => window.microCredits / MICRO)
            .join(', ')}`),
  )
}

/** Test-only: forget every open window. */
export function resetRayuChargesForTests(): void {
  openWindows.clear()
}
