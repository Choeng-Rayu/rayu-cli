/**
 * Totalling what the Rayu gateway charged for one piece of work. A request counts
 * toward the windows that were open when it STARTED, however late its charge is
 * reported, and a window counts every such request, however many there are.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  closeRayuCreditWindow,
  isRayuCreditWindowOpen,
  openRayuCreditWindow,
  rayuWindowCredits,
  recordRayuCharge,
  resetRayuChargesForTests,
  startRayuCharge,
} from '../src/services/rayuAuth/rayuTurnCredits.js'

afterEach(() => resetRayuChargesForTests())

describe('a credit window', () => {
  test('work with no Rayu-billed request has no total at all', () => {
    const work = openRayuCreditWindow()
    // A BYOK request reports no charge; it must not turn into "Credits: 0.00".
    recordRayuCharge(undefined)
    expect(rayuWindowCredits(work)).toBeUndefined()
  })

  test('counts every request that starts while it is open', () => {
    recordRayuCharge(5) // no window open yet: counted nowhere
    const work = openRayuCreditWindow()
    recordRayuCharge(443.76) // the main loop
    recordRayuCharge(0.12) // a side query
    recordRayuCharge(1.5) // a hosted image
    expect(rayuWindowCredits(work)).toBe(445.38)
  })

  test('sums exactly, without float drift', () => {
    const work = openRayuCreditWindow()
    recordRayuCharge(0.1)
    recordRayuCharge(0.2)
    expect(rayuWindowCredits(work)).toBe(0.3)
  })

  test('a zero charge still means the work was billed', () => {
    const work = openRayuCreditWindow()
    recordRayuCharge(0)
    expect(rayuWindowCredits(work)).toBe(0)
  })

  test('values that are not a charge are ignored', () => {
    const work = openRayuCreditWindow()
    recordRayuCharge(-1)
    recordRayuCharge(Number.NaN)
    recordRayuCharge(Number.POSITIVE_INFINITY)
    expect(rayuWindowCredits(work)).toBeUndefined()
  })

  // The bug behind "an hour of work showed far too few credits": the previous
  // implementation kept one bucket per request start and pruned all but the newest
  // 1,024, so the first part of any long run vanished from its total.
  test('counts thousands of requests exactly, the first ones included', () => {
    const work = openRayuCreditWindow()
    for (let i = 0; i < 5000; i++) {
      const ticket = startRayuCharge()
      recordRayuCharge(i === 0 ? 1000 : 0.5, ticket)
    }
    expect(rayuWindowCredits(work)).toBe(1000 + 4999 * 0.5)
  })
})

describe('attribution by request start', () => {
  test('a request that started before the window opened is not counted, however late it settles', () => {
    const before = startRayuCharge()
    const work = openRayuCreditWindow()
    recordRayuCharge(1.9, before)
    expect(rayuWindowCredits(work)).toBeUndefined()
  })

  test('a request that started inside the window counts even after the window closed', () => {
    // The session-title regression: launched for this turn, settled after its line.
    const work = openRayuCreditWindow()
    const title = startRayuCharge()
    closeRayuCreditWindow(work)
    expect(isRayuCreditWindowOpen(work)).toBe(false)
    recordRayuCharge(1.9, title)
    expect(rayuWindowCredits(work)).toBe(1.9)
  })

  test('a request that starts after the window closed goes to the next window only', () => {
    const first = openRayuCreditWindow()
    recordRayuCharge(10)
    closeRayuCreditWindow(first)
    const second = openRayuCreditWindow()
    recordRayuCharge(2.5)
    expect(rayuWindowCredits(first)).toBe(10)
    expect(rayuWindowCredits(second)).toBe(2.5)
  })

  test('overlapping windows each count what started while they were open', () => {
    const outer = openRayuCreditWindow()
    recordRayuCharge(10)
    const inner = openRayuCreditWindow()
    recordRayuCharge(2.5)
    closeRayuCreditWindow(inner)
    recordRayuCharge(1)
    expect(rayuWindowCredits(inner)).toBe(2.5)
    expect(rayuWindowCredits(outer)).toBe(13.5)
  })

  test('a charge recorded without a ticket counts toward the windows open now', () => {
    const work = openRayuCreditWindow()
    recordRayuCharge(2)
    expect(rayuWindowCredits(work)).toBe(2)
  })

  test('a request with no window open at its start is counted nowhere', () => {
    const ticket = startRayuCharge()
    const work = openRayuCreditWindow()
    recordRayuCharge(3, ticket)
    expect(ticket.windows).toHaveLength(0)
    expect(rayuWindowCredits(work)).toBeUndefined()
  })
})
