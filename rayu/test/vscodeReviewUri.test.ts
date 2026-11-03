/**
 * The pre-edit virtual-document URI carries the SESSION KEY, not just the display path.
 *
 * The bug this prevents: two conversations editing the same file produced the same URI, so
 * the second session's recorded hunks overwrote the first's and a diff opened from one tab
 * could reconstruct "before" content from the other conversation's edit. Keying the document
 * by `(sessionKey, displayPath)` — and encoding that key into the URI — removes the collision.
 *
 * Pure string module: it must never import `vscode`, and this drives it directly under
 * `bun test`.
 */
import { describe, expect, test } from 'bun:test'

import {
  PRE_EDIT_SCHEME,
  buildPreEditUri,
  parsePreEditUri,
} from '../src/vscode/host/review/reviewUri.js'

describe('buildPreEditUri / parsePreEditUri round-trip', () => {
  test('a simple path comes back exactly', () => {
    const uri = buildPreEditUri('panel-1', 'src/a.ts')
    expect(uri.startsWith(`${PRE_EDIT_SCHEME}:`)).toBe(true)
    expect(parsePreEditUri(uri)).toEqual({ sessionKey: 'panel-1', displayPath: 'src/a.ts' })
  })

  test('the URI carries the encoded basename in the path and the raw display path in the query', () => {
    const uri = buildPreEditUri('panel-2', 'src/my file.ts')
    // Basename is URI-encoded in the path segment...
    expect(uri).toContain('/my%20file.ts?')
    // ...while the display path is stored RAW in the query so it survives verbatim.
    expect(uri.endsWith('?src/my file.ts')).toBe(true)
    expect(parsePreEditUri(uri)).toEqual({ sessionKey: 'panel-2', displayPath: 'src/my file.ts' })
  })

  test('a Windows-style display path round-trips', () => {
    const uri = buildPreEditUri('panel-3', 'src\\nested\\b.ts')
    expect(parsePreEditUri(uri)).toEqual({ sessionKey: 'panel-3', displayPath: 'src\\nested\\b.ts' })
  })

  test('a display path containing a question mark round-trips', () => {
    const uri = buildPreEditUri('panel-4', 'src/what?.ts')
    expect(parsePreEditUri(uri)).toEqual({ sessionKey: 'panel-4', displayPath: 'src/what?.ts' })
  })
})

describe('two sessions editing the SAME displayPath produce DISTINCT URIs', () => {
  test('each URI parses back to its own (sessionKey, displayPath)', () => {
    const displayPath = 'src/shared.ts'
    const panelOne = buildPreEditUri('panel-1', displayPath)
    const panelTwo = buildPreEditUri('panel-2', displayPath)

    expect(panelOne).not.toBe(panelTwo)

    expect(parsePreEditUri(panelOne)).toEqual({ sessionKey: 'panel-1', displayPath })
    expect(parsePreEditUri(panelTwo)).toEqual({ sessionKey: 'panel-2', displayPath })
  })
})

describe('parsePreEditUri returns null for malformed input and never throws', () => {
  const malformed = [
    '',
    'not-a-uri',
    `${PRE_EDIT_SCHEME}:`,
    `${PRE_EDIT_SCHEME}:noquery`,
    // A scheme that is not ours is not a pre-edit document at all.
    'file:///src/a.ts?src/a.ts',
    'https://example.com/a.ts?src/a.ts',
    // No '/' separating the session key from the basename.
    `${PRE_EDIT_SCHEME}:key?a=1`,
    // A leading '/' means an empty session key.
    `${PRE_EDIT_SCHEME}:/a.ts?src/a.ts`,
    // A present but empty display path is not a usable record.
    `${PRE_EDIT_SCHEME}:panel-1/a.ts?`,
  ]

  for (const input of malformed) {
    test(`null for ${JSON.stringify(input)}`, () => {
      expect(() => parsePreEditUri(input)).not.toThrow()
      expect(parsePreEditUri(input)).toBeNull()
    })
  }
})
