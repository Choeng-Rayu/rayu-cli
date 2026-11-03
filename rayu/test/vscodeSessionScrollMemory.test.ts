/**
 * Per-conversation reading positions.
 *
 * ── WHY THIS IS WORTH A TEST ────────────────────────────────────────────────────
 *
 * The panel swaps the transcript wholesale when the user switches conversations, so the
 * scroll position has to be remembered per conversation and put back on return. Two
 * properties matter and both are invisible until they break:
 *
 *   1. Two conversations must never share a position. That was the bug: the position and
 *      the follow-pin were panel-global, so reading back through one conversation and then
 *      returning to another dropped the reader at the top of it.
 *   2. The memory must stay bounded by the conversations that are actually open. A closed
 *      conversation's key is never reused, so its entry can never be read again — keeping
 *      it would be a leak the user creates by pressing +.
 *
 * Exercised through the module directly, so no React renderer is needed — the scroll
 * element and the effects that drive this are the only DOM-bound part.
 */
import { describe, expect, test } from 'bun:test'

import { createSessionScrollMemory, createScrollSwitchTracker } from '../src/vscode/webview/sessionScrollMemory.js'

describe('session scroll memory', () => {
  test('a hidden transcript restores the selected chat only after it becomes visible', () => {
    const tracker = createScrollSwitchTracker('panel-1')
    const memory = createSessionScrollMemory()
    memory.remember('panel-1', { top: 4200, pinned: false })
    expect(tracker.shouldRestore('panel-1', false)).toBe(false)
    expect(tracker.shouldRestore('panel-2', false)).toBe(false)
    expect(tracker.key).toBe('panel-1')
    expect(tracker.shouldRestore('panel-2', true)).toBe(true)
    expect(tracker.key).toBe('panel-2')
    memory.remember('panel-2', { top: 100, pinned: false })
    expect(tracker.shouldRestore('panel-1', true)).toBe(true)
    expect(memory.recall(tracker.key)).toEqual({ top: 4200, pinned: false })
  })

  test('an unseen conversation has no position, so it opens at the newest output', () => {
    const memory = createSessionScrollMemory()
    expect(memory.recall('panel-1')).toBeUndefined()
  })

  test('conversations do not share a position', () => {
    // The reported bug in miniature: leaving panel-1 mid-transcript must not move where
    // panel-2 opens, and coming back to panel-1 must not land at panel-2's position.
    const memory = createSessionScrollMemory()
    memory.remember('panel-1', { top: 4200, pinned: false })
    memory.remember('panel-2', { top: 0, pinned: true })

    expect(memory.recall('panel-1')).toEqual({ top: 4200, pinned: false })
    expect(memory.recall('panel-2')).toEqual({ top: 0, pinned: true })
  })

  test('the latest position for a conversation wins', () => {
    const memory = createSessionScrollMemory()
    memory.remember('panel-1', { top: 100, pinned: false })
    memory.remember('panel-1', { top: 900, pinned: false })
    expect(memory.recall('panel-1')).toEqual({ top: 900, pinned: false })
  })

  test('a conversation that is no longer open is forgotten', () => {
    const memory = createSessionScrollMemory()
    memory.remember('panel-1', { top: 10, pinned: false })
    memory.remember('panel-2', { top: 20, pinned: false })
    memory.remember('panel-3', { top: 30, pinned: false })

    memory.retainOnly(['panel-1', 'panel-3'])

    expect(memory.recall('panel-1')).toBeDefined()
    expect(memory.recall('panel-2')).toBeUndefined()
    expect(memory.recall('panel-3')).toBeDefined()
    expect(memory.size).toBe(2)
  })

  test('an empty open list does not wipe the memory', () => {
    // A resync that has not landed yet reports no sessions. Treating that as "everything
    // closed" would lose every position the instant it happened, which would show up as
    // the original bug reappearing at random.
    const memory = createSessionScrollMemory()
    memory.remember('panel-1', { top: 10, pinned: false })

    memory.retainOnly([])

    expect(memory.recall('panel-1')).toBeDefined()
    expect(memory.size).toBe(1)
  })

  test('the memory is bounded by the open conversations, not by how many were opened', () => {
    const memory = createSessionScrollMemory()

    // Simulate a long day: every conversation is visited and leaves a position, while only
    // the four most recent stay open — exactly as the registry retires the oldest idle one.
    for (let index = 0; index < 500; index += 1) {
      memory.remember(`panel-${index}`, { top: index, pinned: false })
      const open = [index - 3, index - 2, index - 1, index]
        .filter(sequence => sequence >= 0)
        .map(sequence => `panel-${sequence}`)
      memory.retainOnly(open)
    }

    expect(memory.size).toBeLessThanOrEqual(4)
    // The conversations still open are the ones that survive.
    expect(memory.recall('panel-499')).toBeDefined()
    expect(memory.recall('panel-0')).toBeUndefined()
  })
})
