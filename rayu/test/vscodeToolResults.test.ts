/**
 * Typed tool results, as the host projects them.
 *
 * ── WHAT THIS IS REALLY ASSERTING ──────────────────────────────────────────────
 *
 * That the panel can render a diff WITHOUT an engine change. The tool's own `Output`
 * object already travels as `tool_use_result` on the settled user message — set by
 * `toolExecution.ts` and forwarded by `queryHelpers.ts` — and the formatter was simply
 * flattening the result to a string and discarding it. These tests pin that projection,
 * including that every failure mode degrades to the generic renderer instead of throwing.
 */
import { describe, expect, test } from 'bun:test'

import {
  formatMessageForVSCode,
  projectToolResult,
  MAX_WEBVIEW_TEXT_CHARS,
} from '../src/vscode/host/panel/formatActivityForVSCode.js'
import type { WrappedMessage } from '../src/telegram/formatActivity.js'

/** A settled `user` message carrying one tool result plus its typed output. */
function resultMessage(options: {
  text?: string
  isError?: boolean
  typed?: unknown
}): WrappedMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: options.text ?? 'ok',
          ...(options.isError ? { is_error: true } : {}),
        },
      ],
    },
    ...(options.typed !== undefined ? { tool_use_result: options.typed } : {}),
  } as unknown as WrappedMessage
}

const editOutput = {
  filePath: 'src/app.ts',
  originalFile: 'const a = 1\n',
  oldString: 'const a = 1',
  newString: 'const a = 2',
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-const a = 1', '+const a = 2'],
    },
  ],
}

describe('projectToolResult — edits', () => {
  test('an Edit output becomes an edit sidecar', () => {
    const result = projectToolResult(editOutput)
    expect(result?.kind).toBe('edit')
    if (result?.kind !== 'edit') throw new Error('unreachable')
    expect(result.filePath).toBe('src/app.ts')
    expect(result.hunks).toHaveLength(1)
    expect(result.isCreated).toBe(false)
    expect(result.truncated).toBeUndefined()
  })

  test('a Write that created the file reports isCreated', () => {
    const result = projectToolResult({
      type: 'create',
      filePath: 'src/new.ts',
      content: 'export {}\n',
      structuredPatch: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+export {}'] },
      ],
    })
    if (result?.kind !== 'edit') throw new Error('unreachable')
    expect(result.isCreated).toBe(true)
  })

  test('a Write that updated an existing file does not', () => {
    const result = projectToolResult({
      type: 'update',
      filePath: 'src/app.ts',
      content: 'x',
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+x'] },
      ],
    })
    if (result?.kind !== 'edit') throw new Error('unreachable')
    expect(result.isCreated).toBe(false)
  })

  test('extra fields do not break the projection', () => {
    // Both tools carry more than the diff needs. An exact shape would break every time an
    // unrelated field was added to either.
    const result = projectToolResult({
      ...editOutput,
      userModified: true,
      replaceAll: false,
      somethingAddedNextYear: 42,
    })
    expect(result?.kind).toBe('edit')
  })

  test('too many hunks are capped and flagged', () => {
    const hunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-a', '+b'],
    }
    const result = projectToolResult({
      filePath: 'x.ts',
      structuredPatch: Array.from({ length: 40 }, () => hunk),
    })
    if (result?.kind !== 'edit') throw new Error('unreachable')
    expect(result.hunks).toHaveLength(12)
    // Flagged, never silent: a diff missing its tail reads as a smaller change than it is.
    expect(result.truncated).toBe(true)
  })

  test('an over-long hunk is capped in lines and flagged', () => {
    const result = projectToolResult({
      filePath: 'x.ts',
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1000,
          newStart: 1,
          newLines: 1000,
          lines: Array.from({ length: 900 }, (_, i) => `+line ${i}`),
        },
      ],
    })
    if (result?.kind !== 'edit') throw new Error('unreachable')
    expect(result.hunks[0]!.lines).toHaveLength(400)
    expect(result.truncated).toBe(true)
  })

  test('an empty patch produces no sidecar', () => {
    // Nothing to draw. Falling through leaves the generic result, which at least says
    // something happened.
    expect(projectToolResult({ filePath: 'x.ts', structuredPatch: [] })).toBeUndefined()
  })
})

describe('projectToolResult — search', () => {
  test('a Grep/Glob output becomes a search sidecar', () => {
    const result = projectToolResult({
      filenames: ['a.ts', 'b.ts'],
      numFiles: 2,
      durationMs: 5,
    })
    expect(result?.kind).toBe('search')
    if (result?.kind !== 'search') throw new Error('unreachable')
    expect(result.filenames).toEqual(['a.ts', 'b.ts'])
    expect(result.totalCount).toBe(2)
  })

  test('totalCount falls back to the list length when the tool omits it', () => {
    const result = projectToolResult({ filenames: ['only.ts'] })
    if (result?.kind !== 'search') throw new Error('unreachable')
    expect(result.totalCount).toBe(1)
  })

  test('a long file list is capped but the true total is preserved', () => {
    const result = projectToolResult({
      filenames: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
      numFiles: 500,
    })
    if (result?.kind !== 'search') throw new Error('unreachable')
    expect(result.filenames).toHaveLength(200)
    // The count must stay honest, or "Found 200 files" would be a lie.
    expect(result.totalCount).toBe(500)
  })

  test('an empty result set still projects, so the UI can say so', () => {
    const result = projectToolResult({ filenames: [], numFiles: 0 })
    if (result?.kind !== 'search') throw new Error('unreachable')
    expect(result.totalCount).toBe(0)
  })
})

describe('projectToolResult — degradation', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'Applied 1 edit to src/app.ts'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['an unrelated object', { stdout: 'hi', stderr: '', interrupted: false }],
    ['a malformed patch', { filePath: 'x.ts', structuredPatch: 'not an array' }],
    ['a patch of wrong shape', { filePath: 'x.ts', structuredPatch: [{ nope: true }] }],
    ['filenames of wrong type', { filenames: 'a.ts' }],
  ])('%s yields no sidecar and does not throw', (_label, input) => {
    expect(() => projectToolResult(input)).not.toThrow()
    expect(projectToolResult(input)).toBeUndefined()
  })
})

describe('formatMessageForVSCode — sidecar plumbing', () => {
  test('a successful result carries the sidecar', () => {
    const blocks = formatMessageForVSCode(resultMessage({ typed: editOutput }))
    const result = blocks.find(b => b.kind === 'tool_result')
    if (result?.kind !== 'tool_result') throw new Error('unreachable')
    expect(result.toolResult?.kind).toBe('edit')
  })

  test('a FAILED result does not', () => {
    // The typed output describes a change that did not happen; drawing its diff would show
    // edits the file never received.
    const blocks = formatMessageForVSCode(
      resultMessage({ typed: editOutput, isError: true, text: 'permission denied' }),
    )
    const result = blocks.find(b => b.kind === 'tool_result')
    if (result?.kind !== 'tool_result') throw new Error('unreachable')
    expect(result.isError).toBe(true)
    expect(result.toolResult).toBeUndefined()
  })

  test('a result with no typed output still emits, so the pill can settle', () => {
    // A tool that finishes with nothing to show is the common case, not an edge case; the
    // block must exist or the row spins forever.
    const blocks = formatMessageForVSCode(resultMessage({ text: '' }))
    const result = blocks.find(b => b.kind === 'tool_result')
    expect(result).toBeDefined()
    if (result?.kind !== 'tool_result') throw new Error('unreachable')
    expect(result.toolResult).toBeUndefined()
    expect(result.truncatedChars).toBe(0)
  })
})

describe('output clamping', () => {
  test('under the limit is untouched and reports nothing withheld', () => {
    const blocks = formatMessageForVSCode(resultMessage({ text: 'short' }))
    const result = blocks.find(b => b.kind === 'tool_result')
    if (result?.kind !== 'tool_result') throw new Error('unreachable')
    expect(result.text).toBe('short')
    expect(result.truncatedChars).toBe(0)
    expect(result.fullText).toBeUndefined()
  })

  test('over the limit is clamped, counted, and the full text retained for the host', () => {
    const long = 'x'.repeat(MAX_WEBVIEW_TEXT_CHARS + 500)
    const blocks = formatMessageForVSCode(resultMessage({ text: long }))
    const result = blocks.find(b => b.kind === 'tool_result')
    if (result?.kind !== 'tool_result') throw new Error('unreachable')

    expect(result.truncatedChars).toBe(500)
    expect(result.text.length).toBeLessThan(long.length)
    expect(result.text).toContain('truncated 500 more characters')
    // The remainder stops at the host, which serves it on request.
    expect(result.fullText).toBe(long)
  })

  test('exactly at the limit is not treated as truncated', () => {
    const exact = 'y'.repeat(MAX_WEBVIEW_TEXT_CHARS)
    const blocks = formatMessageForVSCode(resultMessage({ text: exact }))
    const result = blocks.find(b => b.kind === 'tool_result')
    if (result?.kind !== 'tool_result') throw new Error('unreachable')
    expect(result.truncatedChars).toBe(0)
    expect(result.fullText).toBeUndefined()
  })
})
