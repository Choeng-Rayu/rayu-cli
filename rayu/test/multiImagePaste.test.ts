// Regression: pasting 2+ images into the prompt kept only ONE.
//
// Root cause (MULTI_IMAGE_PASTE_ROOT_CAUSE.md, Layer 1): usePasteHandler fires
// onImagePaste in a synchronous loop (one call per image, same event-loop turn).
// PromptInput.insertTextAtCursor used to read `input`/`cursorOffset` from the
// render closure, which React cannot refresh mid-loop, so every [Image #N] pill
// overwrote the previous one. The orphan-prune effect then deleted every image
// whose pill was missing — leaving exactly one.
//
// The fix reads the freshest input/cursor from synchronous refs
// (lastInternalInputRef + cursorOffsetRef) so N inserts append N pills.
//
// PromptInput is integration-heavy (appState/MCP/commands hooks), so this pins
// the insertion + prune CONTRACT with a faithful model of the component's
// onImagePaste loop, using the REAL formatImageRef/parseReferences helpers.
import { describe, expect, test } from 'bun:test'
import { formatImageRef, parseReferences } from '../src/history.ts'
import type { PastedContent } from '../src/utils/config.ts'

const img = (id: number): PastedContent => ({
  id,
  type: 'image',
  content: 'base64',
  mediaType: 'image/png',
})

// Faithful model of PromptInput's state + the FIXED insertTextAtCursor.
function makePrompt(initialInput = '') {
  // Committed state (what React renders after the event).
  let input = initialInput
  let cursorOffset = initialInput.length
  let pastedContents: Record<number, PastedContent> = {}

  // Synchronous refs — the fix. Updated eagerly, re-synced from state on render.
  const lastInternalInputRef = { current: input }
  const cursorOffsetRef = { current: cursorOffset }
  const pendingSpaceAfterPillRef = { current: false }

  const trackAndSetInput = (value: string) => {
    lastInternalInputRef.current = value
    input = value // onInputChange -> REPL setState (committed after the loop)
  }
  const setPastedContents = (fn: (p: Record<number, PastedContent>) => Record<number, PastedContent>) => {
    pastedContents = fn(pastedContents)
  }

  // Mirrors PromptInput.insertTextAtCursor after the fix.
  function insertTextAtCursor(text: string) {
    const baseInput = lastInternalInputRef.current
    const baseCursor = Math.min(cursorOffsetRef.current, baseInput.length)
    const newInput = baseInput.slice(0, baseCursor) + text + baseInput.slice(baseCursor)
    const newCursor = baseCursor + text.length
    cursorOffsetRef.current = newCursor
    trackAndSetInput(newInput)
    cursorOffset = newCursor
  }

  // Mirrors PromptInput.onImagePaste.
  function onImagePaste(pasteId: number) {
    setPastedContents(prev => ({ ...prev, [pasteId]: img(pasteId) }))
    const prefix = pendingSpaceAfterPillRef.current ? ' ' : ''
    insertTextAtCursor(prefix + formatImageRef(pasteId))
    pendingSpaceAfterPillRef.current = true
  }

  // Mirrors the orphan-prune effect (runs on committed input after the loop).
  function prune() {
    const referencedIds = new Set(parseReferences(input).map(r => r.id))
    setPastedContents(prev => {
      const next = { ...prev }
      for (const c of Object.values(prev)) {
        if (c.type === 'image' && !referencedIds.has(c.id)) delete next[c.id]
      }
      return next
    })
  }

  // usePasteHandler's synchronous loop: no re-render between iterations.
  function pasteImages(ids: number[]) {
    for (const id of ids) onImagePaste(id)
    prune()
  }

  return {
    pasteImages,
    insertTextAtCursor,
    get input() { return input },
    get cursorOffset() { return cursorOffset },
    get pastedContents() { return pastedContents },
    pillCount: () => parseReferences(input).length,
    imageIds: () => Object.keys(pastedContents).map(Number).sort((a, b) => a - b),
  }
}

// The ORIGINAL buggy insertion: closure input/cursor frozen for the whole loop.
function makeBuggyPrompt(initialInput = '') {
  const closureInput = initialInput
  const closureCursor = initialInput.length
  let input = initialInput
  let pastedContents: Record<number, PastedContent> = {}
  const pendingSpace = { current: false }
  function insertTextAtCursor(text: string) {
    input = closureInput.slice(0, closureCursor) + text + closureInput.slice(closureCursor)
  }
  function onImagePaste(id: number) {
    pastedContents = { ...pastedContents, [id]: img(id) }
    const prefix = pendingSpace.current ? ' ' : ''
    insertTextAtCursor(prefix + formatImageRef(id))
    pendingSpace.current = true
  }
  function pasteImages(ids: number[]) {
    for (const id of ids) onImagePaste(id)
    const referenced = new Set(parseReferences(input).map(r => r.id))
    for (const c of Object.values(pastedContents)) {
      if (!referenced.has(c.id)) delete pastedContents[c.id]
    }
  }
  return { pasteImages, get input() { return input }, pillCount: () => parseReferences(input).length, imageIds: () => Object.keys(pastedContents).map(Number) }
}

describe('multi-image paste keeps every image (fixed insertion)', () => {
  for (const n of [1, 2, 3, 5]) {
    test(`pasting ${n} image(s) yields ${n} pill(s) and ${n} surviving image(s)`, () => {
      const p = makePrompt()
      const ids = Array.from({ length: n }, (_, i) => i + 1)
      p.pasteImages(ids)
      expect(p.pillCount()).toBe(n)
      expect(p.imageIds()).toEqual(ids)
      // every pill is present in the committed input
      for (const id of ids) expect(p.input).toContain(formatImageRef(id))
    })
  }

  test('pills are space-separated in paste order', () => {
    const p = makePrompt()
    p.pasteImages([1, 2, 3])
    expect(p.input).toBe('[Image #1] [Image #2] [Image #3]')
  })

  test('cursor lands at the end after the loop', () => {
    const p = makePrompt()
    p.pasteImages([1, 2])
    expect(p.cursorOffset).toBe(p.input.length)
  })

  test('inserts into existing text at the cursor, preserving surrounding text', () => {
    const p = makePrompt('look: ')
    p.pasteImages([1, 2])
    expect(p.input).toBe('look: [Image #1] [Image #2]')
    expect(p.imageIds()).toEqual([1, 2])
  })

  test('a single insert still behaves exactly as before', () => {
    const p = makePrompt('abc')
    p.insertTextAtCursor('X')
    expect(p.input).toBe('abcX')
    expect(p.cursorOffset).toBe(4)
  })
})

describe('the original stale-closure bug (contrast)', () => {
  test('pasting 2 images kept only the last pill and pruned the first image', () => {
    const p = makeBuggyPrompt()
    p.pasteImages([1, 2])
    expect(p.pillCount()).toBe(1)
    expect(p.input).toContain(formatImageRef(2))
    expect(p.input).not.toContain(formatImageRef(1))
    expect(p.imageIds()).toEqual([2])
  })

  test('pasting 3 images still kept only one', () => {
    const p = makeBuggyPrompt()
    p.pasteImages([1, 2, 3])
    expect(p.pillCount()).toBe(1)
    expect(p.imageIds()).toEqual([3])
  })
})
