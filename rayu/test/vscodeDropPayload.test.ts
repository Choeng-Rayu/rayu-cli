/**
 * Reading a drop in a VS Code webview.
 *
 * ── THE FIXTURES ARE THE WORKBENCH'S OWN OUTPUT ────────────────────────────────
 *
 * Every payload below is the shape `fillEditorsDragData` in `vs/workbench/browser/dnd.ts`
 * actually writes, not an invented one. Two of its decisions are the whole reason this module
 * exists and are asserted directly:
 *
 *   1. `text/uri-list` carries ONLY THE FIRST uri, because of Chromium bug 239745. The full
 *      list goes to `application/vnd.code.uri-list`. A reader that prefers the standard format
 *      silently loses every file but one in a multi-select — which looks like a partly-working
 *      feature rather than a bug.
 *   2. `CodeEditors` holds MARSHALLED `URI` objects, not strings. Reading it naively yields
 *      `[object Object]`.
 *
 * Format names are lower-cased because `DataTransfer.setData` lower-cases them per spec, so a
 * fixture keyed `CodeEditors` would not be retrievable at all — which is itself a mistake worth
 * encoding in the fixture builder.
 */
import { describe, expect, test } from 'bun:test'

import {
  extractPlainText,
  extractUriList,
  hasDroppableTypes,
  type DropDataLike,
} from '../src/vscode/webview/components/dropPayload.js'

/** A `DataTransfer` stand-in with the spec's lower-casing behaviour. */
function transfer(entries: Record<string, string>): DropDataLike {
  const normalised = new Map(
    Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    types: [...normalised.keys()],
    getData: type => normalised.get(type.toLowerCase()) ?? '',
  }
}

describe('internal VS Code drags', () => {
  test('the FULL list is taken from the internal format, not the truncated standard one', () => {
    // Exactly what a two-file Explorer multi-select produces.
    const data = transfer({
      'text/uri-list': 'file:///w/a.ts',
      'application/vnd.code.uri-list': 'file:///w/a.ts\nfile:///w/b.ts',
      'text/plain': '/w/a.ts\n/w/b.ts',
    })
    expect(extractUriList(data)).toBe('file:///w/a.ts\nfile:///w/b.ts')
  })

  test('a marshalled CodeEditors payload is reconstructed into uris', () => {
    // `stringify()` marshals a URI as an object with a `$mid` tag. `fsPath` is present but is
    // the LOCAL rendering, which is wrong for a remote workspace — so scheme/authority/path win.
    const data = transfer({
      CodeEditors: JSON.stringify([
        {
          resource: {
            $mid: 1,
            fsPath: '/w/a.ts',
            path: '/w/a.ts',
            scheme: 'vscode-remote',
            authority: 'wsl+ubuntu',
          },
          options: { pinned: true },
        },
      ]),
    })
    expect(extractUriList(data)).toBe('vscode-remote://wsl+ubuntu/w/a.ts')
  })

  test('a remote-workspace uri is accepted, not filtered out as an unknown scheme', () => {
    // The reported Remote-WSL/SSH failure: a reader that only accepts `file:` silently does
    // nothing in every remote window.
    const data = transfer({
      'application/vnd.code.uri-list': 'vscode-remote://wsl+ubuntu/w/a.ts',
    })
    expect(extractUriList(data)).toBe('vscode-remote://wsl+ubuntu/w/a.ts')
  })

  test('CodeFiles plain paths are read', () => {
    const data = transfer({ CodeFiles: JSON.stringify(['/w/a.ts', 'C:\\w\\b.ts']) })
    expect(extractUriList(data)).toBe('/w/a.ts\nC:\\w\\b.ts')
  })

  test('duplicates across formats are collapsed, order preserved', () => {
    const data = transfer({
      'application/vnd.code.uri-list': 'file:///w/a.ts\nfile:///w/b.ts',
      CodeFiles: JSON.stringify(['file:///w/b.ts', 'file:///w/c.ts']),
    })
    expect(extractUriList(data)).toBe('file:///w/a.ts\nfile:///w/b.ts')
  })

  test('ONE dropped file yields ONE reference, not one per format', () => {
    // The reported bug: dropping a single file produced three attachments. Every format names
    // the same resource in a different notation, so accumulating across them and de-duplicating
    // by string cannot collapse them. The first format that yields anything wins.
    const data = transfer({
      'text/uri-list': 'file:///w/a.ts',
      'application/vnd.code.uri-list': 'file:///w/a.ts',
      CodeFiles: JSON.stringify(['/w/a.ts']),
      CodeEditors: JSON.stringify([
        { resource: { $mid: 1, scheme: 'vscode-remote', authority: 'wsl+ubuntu', path: '/w/a.ts' } },
      ]),
      'text/plain': '/w/a.ts',
    })
    expect(extractUriList(data)).toBe('file:///w/a.ts')
  })

  test('uri-list comments and blank lines are skipped, per the format', () => {
    const data = transfer({
      'text/uri-list': '# a comment\n\nfile:///w/a.ts\n',
    })
    expect(extractUriList(data)).toBe('file:///w/a.ts')
  })
})

describe('editor-tab and OS drags', () => {
  test('an editor-tab drag that leaves only text/plain still yields the path', () => {
    expect(extractUriList(transfer({ 'text/plain': '/w/a.ts' }))).toBe('/w/a.ts')
  })

  test('an OS file drop provides the standard format', () => {
    expect(
      extractUriList(transfer({ 'text/uri-list': 'file:///home/u/shot.png' })),
    ).toBe('file:///home/u/shot.png')
  })
})

describe('dragged text is never mistaken for a path', () => {
  test('a sentence is returned as text, not as a file reference', () => {
    const data = transfer({ 'text/plain': 'refactor this function please' })
    expect(extractUriList(data)).toBe('')
    expect(extractPlainText(data)).toBe('refactor this function please')
  })

  test('a payload that IS paths yields no plain text, so a drop cannot do both', () => {
    const data = transfer({
      'text/uri-list': 'file:///w/a.ts',
      'text/plain': '/w/a.ts',
    })
    expect(extractPlainText(data)).toBe('')
  })

  test('a relative-looking word is not treated as a path', () => {
    // `src/a.ts` cannot be resolved without a base, and accepting it would turn a dragged
    // code fragment into a broken mention.
    expect(extractUriList(transfer({ 'text/plain': 'src/a.ts' }))).toBe('')
  })
})

describe('deciding whether to show the drop target', () => {
  test('formats that can carry something droppable light the panel up', () => {
    for (const type of [
      'text/uri-list',
      'application/vnd.code.uri-list',
      'codefiles',
      'codeeditors',
      'Files',
      'text/plain',
    ]) {
      expect(hasDroppableTypes({ types: [type], getData: () => '' })).toBe(true)
    }
  })

  test('a drag carrying nothing usable does not', () => {
    // `getData` is unavailable on dragenter by design, so `types` is the ONLY signal — which
    // is why this has to be a type check rather than a data check.
    expect(hasDroppableTypes({ types: [], getData: () => '' })).toBe(false)
    expect(
      hasDroppableTypes({ types: ['application/vnd.code.tree.someview'], getData: () => '' }),
    ).toBe(false)
    expect(hasDroppableTypes(null)).toBe(false)
  })
})

describe('degrading rather than throwing', () => {
  test('a getData that throws for one format does not lose the others', () => {
    const data: DropDataLike = {
      types: ['application/vnd.code.uri-list', 'text/uri-list'],
      getData: type => {
        if (type === 'application/vnd.code.uri-list') throw new Error('nope')
        return 'file:///w/a.ts'
      },
    }
    expect(extractUriList(data)).toBe('file:///w/a.ts')
  })

  test('malformed JSON falls back to line parsing rather than discarding the payload', () => {
    expect(extractUriList(transfer({ CodeFiles: '[not json' }))).toBe('')
    expect(
      extractUriList(transfer({ CodeFiles: '[', 'text/plain': '/w/a.ts' })),
    ).toBe('/w/a.ts')
  })

  test('a missing types list is tried rather than assumed empty', () => {
    // Some hosts omit `types`. Refusing to read then would be a confident wrong answer.
    expect(
      extractUriList({ getData: type => (type === 'text/uri-list' ? 'file:///w/a.ts' : '') }),
    ).toBe('file:///w/a.ts')
  })
})
