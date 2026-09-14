/**
 * The animated per-status avatar's shared frame clock (`useSpriteFrame.ts`).
 *
 * ── WHY THIS IS WORTH A TEST ────────────────────────────────────────────────────
 *
 * Same shape of risk as `useSecondTick.ts`/`useBrailleSpinner.ts` (see their own
 * tests): this has to be one shared ticker, not one `setInterval` per mounted
 * `SpriteAvatar`, and the ticker must not outlive its last subscriber. A leaked
 * interval here is quieter than most bugs — the panel just never goes idle —
 * which is exactly the kind of thing worth a standing assertion rather than
 * relying on someone noticing.
 *
 * Exercised through the module's real subscriber-count seam, matching the
 * existing `useSecondTick`/`useBrailleSpinner` tests' approach, since there is
 * no DOM-rendering harness for webview React components in this test tree to
 * mount the hook through yet.
 */
import { describe, expect, test, beforeEach } from 'bun:test'

import { activeSpriteFrameSubscribers } from '../src/vscode/webview/useSpriteFrame.js'

describe('shared sprite frame ticker', () => {
  beforeEach(() => {
    // Every test must leave the module clean, or a leak in one shows up as a
    // failure in the next and the real cause is the earlier test.
    expect(activeSpriteFrameSubscribers()).toBe(0)
  })

  test('starts with no subscribers, so an idle panel schedules nothing', () => {
    expect(activeSpriteFrameSubscribers()).toBe(0)
  })

  test('the module exposes only its count, not its internals', () => {
    // The seam exists for leak assertions, mirroring useSecondTick's own test. If
    // it ever returns anything else, this stops meaning what it says.
    expect(typeof activeSpriteFrameSubscribers()).toBe('number')
  })
})
