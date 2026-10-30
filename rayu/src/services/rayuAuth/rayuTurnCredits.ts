/**
 * The Rayu credits this process has been charged, as the gateway reported
 * them, so a front end can say what one turn cost ("Credits: 443.76").
 *
 * Every Rayu-billed request path records the charge its response carried
 * (see `utils/rayuRequestCharge.ts`): the chat stream, its non-streaming
 * fallback, side queries, and the hosted image and video tools. A turn's
 * total is then the difference between two marks:
 *
 *   const mark = markRayuCharges()      // turn starts
 *   ...                                  // requests record their charges
 *   rayuCreditsSince(mark)               // turn ends: 443.76, or undefined
 *
 * A charge is attributed to the turn in which its request STARTED, not the one
 * in which it finished. The gateway reports a charge only when a request
 * completes, so a request launched during a turn but settling after the turn
 * line rendered would otherwise be dropped (or, worse, counted later). Callers
 * therefore pass the mark they took before sending the request; a request that
 * started before a mark no longer lands in that mark's window, however late it
 * settles. That is what makes the session-title request -- launched for a turn,
 * often completing after its line -- count against the turn it belongs to.
 *
 * Marks rather than a per-turn reset, so readers that overlap -- the REPL's
 * turn line, a swarm's deferred turn line, the headless engine's result frame
 * -- cannot clear each other's count.
 *
 * The figures are the gateway's own: nothing here prices tokens. A turn that
 * made no Rayu-billed request (bring-your-own key, or a gateway too old to
 * report charges) has no total at all, which the front ends show as no line.
 */

/** Credits are summed in millionths, so a turn's total has no float drift. */
const MICRO = 1_000_000

/**
 * How many start-sequence buckets to retain. A mark taken within this many
 * recorded charges still sums correctly; older buckets are pruned so a long
 * session cannot grow the map without bound.
 */
const MAX_BUCKETS = 1024

let chargedMicroCredits = 0
let chargeCount = 0

/** Millionths charged, keyed by the sequence at which each request started. */
const chargedByStart = new Map<number, number>()

/** A point in this process's charge history. */
export type RayuChargeMark = Readonly<{
  microCredits: number
  charges: number
}>

/**
 * Records what one Rayu-billed request was charged. `undefined` (the response
 * reported no charge) and anything that is not a non-negative number are
 * ignored.
 *
 * `startedAt` is the mark taken before the request was sent, so the charge is
 * attributed to the turn in which the request started. Omit it for a request
 * that both starts and finishes inside the current turn: it is then attributed
 * to "now", which is the same window.
 */
export function recordRayuCharge(
  credits: number | undefined,
  startedAt?: RayuChargeMark,
): void {
  if (credits === undefined || !Number.isFinite(credits) || credits < 0) return
  const micro = Math.round(credits * MICRO)
  const startSeq = startedAt?.charges ?? chargeCount
  chargedByStart.set(startSeq, (chargedByStart.get(startSeq) ?? 0) + micro)
  chargedMicroCredits += micro
  chargeCount += 1
  pruneOldBuckets()
}

/** Drops the oldest start-sequence buckets once the map is over the limit. */
function pruneOldBuckets(): void {
  if (chargedByStart.size <= MAX_BUCKETS) return
  const keys = [...chargedByStart.keys()].sort((a, b) => a - b)
  const excess = keys.length - MAX_BUCKETS
  for (let i = 0; i < excess; i++) chargedByStart.delete(keys[i]!)
}

/** Marks "now", for a later {@link rayuCreditsSince}. */
export function markRayuCharges(): RayuChargeMark {
  return { microCredits: chargedMicroCredits, charges: chargeCount }
}

/**
 * The credits charged by requests that STARTED at or after `mark`, or
 * `undefined` when no such request has reported a charge. A real zero-value
 * charge in the window reads as `0`.
 */
export function rayuCreditsSince(mark: RayuChargeMark): number | undefined {
  let micro: number | undefined
  for (const [startSeq, charged] of chargedByStart) {
    if (startSeq < mark.charges) continue
    micro = (micro ?? 0) + charged
  }
  return micro === undefined ? undefined : micro / MICRO
}

/** Test-only: forget every recorded charge. */
export function resetRayuChargesForTests(): void {
  chargedMicroCredits = 0
  chargeCount = 0
  chargedByStart.clear()
}
