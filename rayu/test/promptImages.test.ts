/**
 * Images on a queued prompt, on both the batching path and the direct path.
 *
 * Two regressions are pinned here:
 *  - batching merged only the prompt TEXT, so every image after the head command was
 *    dropped while its `[Image #N]` marker stayed in the joined text;
 *  - the headless engine sent a queued command straight to ask() and never resolved
 *    `pastedContents`, so a Telegram photo had no bytes.
 */
import { describe, expect, test } from 'bun:test'

import { joinPromptValues, mergePastedContents } from '../src/cli/print.js'
import { promptValueWithImageBlocks } from '../src/utils/attachments.js'
import type { PastedContent } from '../src/utils/config.js'

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const image = (id: number, data = PNG_1PX): PastedContent => ({
  id,
  type: 'image',
  content: data,
  mediaType: 'image/png',
})

describe('mergePastedContents', () => {
  test('keeps images from every command in the batch', () => {
    // The bug: two photos sent as separate messages batch into one turn, and only
    // the head command's bytes survived.
    const merged = mergePastedContents([
      { pastedContents: { 1: image(1) } },
      { pastedContents: { 2: image(2) } },
      {},
    ])
    expect(Object.keys(merged ?? {}).sort()).toEqual(['1', '2'])
    expect(merged?.[2]?.id).toBe(2)
  })

  test('an image only on a later command is still merged', () => {
    expect(mergePastedContents([{}, { pastedContents: { 7: image(7) } }])?.[7]?.id).toBe(7)
  })

  test('returns undefined when no command carries images', () => {
    expect(mergePastedContents([{}, { pastedContents: undefined }])).toBeUndefined()
    expect(mergePastedContents([])).toBeUndefined()
  })

  test('a duplicate id keeps the first entry rather than dropping an existing image', () => {
    const merged = mergePastedContents([
      { pastedContents: { 3: image(3, 'HEAD') } },
      { pastedContents: { 3: image(3, 'TAIL') } },
    ])
    expect(merged?.[3]?.content).toBe('HEAD')
  })

  test('text and image markers survive the same join', () => {
    const joined = joinPromptValues(['first\n[Image #1]', 'second\n[Image #2]'])
    expect(joined).toBe('first\n[Image #1]\nsecond\n[Image #2]')
  })
})

describe('promptValueWithImageBlocks', () => {
  test('returns the value untouched when there are no images', async () => {
    const value = 'hello'
    // Identity, not just equality: several callers rely on the plain-string form.
    expect(await promptValueWithImageBlocks(value, undefined)).toBe(value)
  })

  test('puts the text first and appends the image blocks', async () => {
    const result = await promptValueWithImageBlocks('analyze\n[Image #1]', { 1: image(1) })
    expect(Array.isArray(result)).toBe(true)
    const blocks = result as Array<{ type: string; text?: string; source?: { data?: string } }>
    expect(blocks[0]).toEqual({ type: 'text', text: 'analyze\n[Image #1]' })
    expect(blocks).toHaveLength(2)
    expect(blocks[1]?.type).toBe('image')
    expect(blocks[1]?.source?.data).toBe(PNG_1PX)
  })

  test('extracts the text from an existing block array', async () => {
    const result = await promptValueWithImageBlocks(
      [{ type: 'text', text: 'already blocks' }],
      { 1: image(1) },
    )
    const blocks = result as Array<{ type: string; text?: string }>
    expect(blocks[0]).toEqual({ type: 'text', text: 'already blocks' })
    expect(blocks).toHaveLength(2)
  })
})
