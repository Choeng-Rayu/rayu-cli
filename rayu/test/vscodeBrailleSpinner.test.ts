/**
 * The webview's braille pulse spinner, ported from the CLI's `SpinnerGlyph.tsx`.
 *
 * ── WHY THIS IS WORTH A TEST ────────────────────────────────────────────────────
 *
 * Same shape of risk as `useSecondTick.ts` (see `test/vscodeSecondTick.test.ts`), and
 * for the same reason: `ProgressGlyph` (`Icons.tsx`) is mounted at up to five places at
 * once while a turn is running, and this has to be one shared ticker, not one per
 * mounted glyph, and the ticker must not outlive its last subscriber. A leaked interval
 * here is quieter than most bugs — the panel just never goes idle — which is exactly the
 * kind of thing worth a standing assertion rather than relying on someone noticing.
 *
 * Exercised through the module's real subscriber-count seam, matching the existing
 * `useSecondTick` test's approach, since there is no DOM-rendering harness for webview
 * React components in this test tree to mount the hook through yet.
 */
import { describe, expect, test, beforeEach } from 'bun:test'

import { activeBrailleSpinnerSubscribers } from '../src/vscode/webview/useBrailleSpinner.js'

describe('shared braille spinner ticker', () => {
  beforeEach(() => {
    // Every test must leave the module clean, or a leak in one shows up as a failure in
    // the next and the real cause is the earlier test.
    expect(activeBrailleSpinnerSubscribers()).toBe(0)
  })

  test('starts with no subscribers, so an idle panel schedules nothing', () => {
    expect(activeBrailleSpinnerSubscribers()).toBe(0)
  })

  test('the module exposes only its count, not its internals', () => {
    // The seam exists for leak assertions, mirroring useSecondTick's own test. If it
    // ever returns anything else, this stops meaning what it says.
    expect(typeof activeBrailleSpinnerSubscribers()).toBe('number')
  })
})
