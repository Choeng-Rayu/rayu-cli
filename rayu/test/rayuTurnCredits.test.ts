/**
 * Summing what the Rayu gateway charged between two points (a turn's start and
 * end). Marks rather than a reset, so overlapping readers cannot clear each
 * other.
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  markRayuCharges,
  rayuCreditsSince,
  recordRayuCharge,
  resetRayuChargesForTests,
} from '../src/services/rayuAuth/rayuTurnCredits.js'

beforeEach(() => resetRayuChargesForTests())

describe('rayuCreditsSince', () => {
  test('a turn with no Rayu-billed request has no total at all', () => {
    const mark = markRayuCharges()
    // A BYOK request reports no charge; it must not turn into "Credits: 0.00".
    recordRayuCharge(undefined)
    expect(rayuCreditsSince(mark)).toBeUndefined()
  })

  test('the total is every charge recorded since the mark', () => {
    recordRayuCharge(5) // before the turn
    const mark = markRayuCharges()
    recordRayuCharge(443.76) // the main loop
    recordRayuCharge(0.12) // a side query
    recordRayuCharge(1.5) // a hosted image
    expect(rayuCreditsSince(mark)).toBe(445.38)
  })

  test('sums are exact, not float-drifted', () => {
    const mark = markRayuCharges()
    recordRayuCharge(0.1)
    recordRayuCharge(0.2)
    expect(rayuCreditsSince(mark)).toBe(0.3)
  })

  test('a zero charge still means the turn was billed', () => {
    const mark = markRayuCharges()
    recordRayuCharge(0)
    expect(rayuCreditsSince(mark)).toBe(0)
  })

  test('overlapping marks each see their own window', () => {
    const swarmStart = markRayuCharges()
    recordRayuCharge(10)
    const turnStart = markRayuCharges()
    recordRayuCharge(2.5)
    expect(rayuCreditsSince(turnStart)).toBe(2.5)
    // The deferred swarm line covers both turns; reading the turn did not reset it.
    expect(rayuCreditsSince(swarmStart)).toBe(12.5)
  })

  test('values that are not a charge are ignored', () => {
    const mark = markRayuCharges()
    recordRayuCharge(-1)
    recordRayuCharge(Number.NaN)
    recordRayuCharge(Number.POSITIVE_INFINITY)
    expect(rayuCreditsSince(mark)).toBeUndefined()
  })

  test('a request that started before the mark is not counted even when it settles later', () => {
    const a = markRayuCharges()
    recordRayuCharge(5) // a request that started at A and already settled
    const b = markRayuCharges()
    // A request that started at A, but only settles now -- after B was taken.
    recordRayuCharge(1.9, a)
    expect(rayuCreditsSince(b)).toBeUndefined()
    expect(rayuCreditsSince(a)).toBe(6.9)
  })

  test('a request that started inside the window counts even if it settles after the turn ended', () => {
    // The session-title regression: the request is launched for this turn (its
    // start mark is `start`) but its charge is reported after the turn line
    // already read the total.
    const start = markRayuCharges()
    // The turn line renders now, before the title request settles.
    expect(rayuCreditsSince(start)).toBeUndefined()
    // The title request settles afterwards, attributed to its start mark; the
    // earlier read did not lock the total in.
    recordRayuCharge(1.9, start)
    expect(rayuCreditsSince(start)).toBe(1.9)
  })

  test('a charge recorded with no start mark is attributed to now', () => {
    const mark = markRayuCharges()
    recordRayuCharge(2) // media/token-estimation call sites: start == finish
    expect(rayuCreditsSince(mark)).toBe(2)
  })
})
