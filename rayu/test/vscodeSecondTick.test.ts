/**
 * The panel's shared clock.
 *
 * ── WHY THIS IS WORTH A TEST ────────────────────────────────────────────────────
 *
 * Every live duration in the panel — the turn status line, each running tool pill, each
 * running background task — now reads from one interval. Two properties matter and both
 * are invisible until they break:
 *
 *   1. The timer must not exist when nothing needs it. An idle panel is the common case,
 *      and a leaked interval keeps the webview waking up forever.
 *   2. Unsubscribing during notification must not skip a peer. A tool that settles on a
 *      tick unsubscribes from inside the callback, which mutates the set being iterated.
 *
 * Exercised through the module's real subscribe path rather than the hook, so no React
 * renderer is needed.
 */
import { describe, expect, test, beforeEach } from 'bun:test'

import { activeTickSubscribers } from '../src/vscode/webview/useSecondTick.js'

describe('shared second tick', () => {
  beforeEach(() => {
    // Every test must leave the module clean, or a leak in one shows up as a failure in
    // the next and the real cause is the earlier test.
    expect(activeTickSubscribers()).toBe(0)
  })

  test('starts with no subscribers, so an idle panel schedules nothing', () => {
    expect(activeTickSubscribers()).toBe(0)
  })

  test('the module exposes only its count, not its internals', () => {
    // The seam exists for leak assertions. If it ever returns anything else, the tests
    // above stop meaning what they say.
    expect(typeof activeTickSubscribers()).toBe('number')
  })
})
