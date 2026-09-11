/**
 * Composer attachments: dropped paths, pasted images, caret insertion.
 *
 * The regression these guard against is specific. The previous implementation read
 * `File.path` on dropped files — a property VS Code webviews do not expose — so it inserted
 * bare filenames like `@app.ts` that the engine could not resolve, and it appeared to work
 * whenever the file happened to be unique in the workspace root.
 */
import { describe, expect, test } from 'bun:test'

import {
  formatPathMentions,
  insertAtCursor,
  isSupportedImageType,
  partitionDroppedFiles,
  stripDataUrlPrefix,
} from '../src/vscode/webview/components/composerAttachments.js'
import { API_IMAGE_MAX_BASE64_SIZE, API_MAX_MEDIA_PER_REQUEST } from '../src/constants/apiLimits.js'

/** Minimal stand-in: only `type` and `name` are read by the code under test. */
function fileLike(name: string, type: string): File {
  return { name, type } as unknown as File
}

describe('image type gating', () => {
  test('accepts exactly the four media types the API takes', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isSupportedImageType(type)).toBe(true)
    }
    // Rejected here rather than deferred to the host: an unsupported type would be refused
    // after the user had already staged it.
    for (const type of ['image/svg+xml', 'image/bmp', 'application/pdf', 'text/plain', '']) {
      expect(isSupportedImageType(type)).toBe(false)
    }
  })
})

describe('base64 normalisation', () => {
  test('the data-URL wrapper is stripped, leaving what the API wants', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,AAAA')).toBe('AAAA')
    // Already-raw base64 passes through unchanged.
    expect(stripDataUrlPrefix('AAAA')).toBe('AAAA')
    expect(stripDataUrlPrefix('')).toBe('')
  })

  test('stripped payloads satisfy the host validator that gates them', () => {
    // The host rejects anything that is not strict base64 with a length divisible by four,
    // so the stripping must not leave a prefix or a stray comma behind.
    const data = stripDataUrlPrefix('data:image/png;base64,iVBORw0KGgo=')
    expect(/^[A-Za-z0-9+/]*={0,2}$/.test(data)).toBe(true)
    expect(data.length % 4).toBe(0)
    expect(data.length).toBeLessThan(API_IMAGE_MAX_BASE64_SIZE)
    expect(API_MAX_MEDIA_PER_REQUEST).toBeGreaterThan(0)
  })
})

describe('partitioning a drop', () => {
  test('images are embedded and everything else is referenced by path', () => {
    const { images, others } = partitionDroppedFiles([
      fileLike('shot.png', 'image/png'),
      fileLike('app.ts', 'text/typescript'),
      fileLike('diagram.webp', 'image/webp'),
      fileLike('notes.md', ''),
    ])
    expect(images.map(f => f.name)).toEqual(['shot.png', 'diagram.webp'])
    // Source files must NOT be read into the prompt: the engine's own @-mention expansion
    // does that, with truncation and permission rules this code has no access to.
    expect(others.map(f => f.name)).toEqual(['app.ts', 'notes.md'])
  })

  test('an empty drop partitions to nothing', () => {
    expect(partitionDroppedFiles([])).toEqual({ images: [], others: [] })
  })
})

describe('path mentions', () => {
  test('resolved paths become plain @-mentions for the shared parser', () => {
    // Plain text on purpose: the engine's processAtMentionedFiles is the single
    // implementation of what a mention means, including walking a directory.
    expect(formatPathMentions(['src/app.ts'])).toBe('@src/app.ts')
    expect(formatPathMentions(['src/app.ts', 'src/lib/'])).toBe('@src/app.ts @src/lib/')
  })

  test('empty and whitespace-only paths are dropped, not turned into a bare @', () => {
    expect(formatPathMentions([])).toBe('')
    expect(formatPathMentions(['', '   '])).toBe('')
    expect(formatPathMentions(['  src/a.ts  '])).toBe('@src/a.ts')
  })
})

describe('caret insertion', () => {
  test('inserting into an empty input adds no padding', () => {
    expect(insertAtCursor('', 0, '@src/a.ts')).toEqual({
      value: '@src/a.ts',
      cursor: 9,
    })
  })

  test('a space is added before when the caret follows a word', () => {
    const result = insertAtCursor('look at', 7, '@src/a.ts')
    expect(result.value).toBe('look at @src/a.ts')
    // Caret sits at the end of the inserted text.
    expect(result.value.slice(0, result.cursor)).toBe('look at @src/a.ts')
  })

  test('a space is added after when the caret precedes a word', () => {
    const result = insertAtCursor('please', 0, '@a.ts')
    expect(result.value).toBe('@a.ts please')
    // Caret lands before the padding space, so continuing to type extends the mention.
    expect(result.value.slice(0, result.cursor)).toBe('@a.ts')
  })

  test('existing whitespace is not doubled', () => {
    expect(insertAtCursor('a ', 2, '@b.ts').value).toBe('a @b.ts')
    expect(insertAtCursor(' x', 0, '@b.ts').value).toBe('@b.ts x')
  })

  test('a caret beyond the value is clamped rather than producing holes', () => {
    expect(insertAtCursor('ab', 99, '@c.ts').value).toBe('ab @c.ts')
    expect(insertAtCursor('ab', -5, '@c.ts').value).toBe('@c.ts ab')
  })
})
