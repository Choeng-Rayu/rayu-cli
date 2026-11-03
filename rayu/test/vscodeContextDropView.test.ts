/**
 * The Rayucode Context drop pane: reading a dropped `text/uri-list` and delivering paths.
 *
 * `handleContextDrop` and `splitUriList` are pure, so they are tested directly. The
 * TreeView itself needs a live workbench drag and cannot be exercised headless.
 */
import { describe, expect, mock, test } from 'bun:test'

import { splitUriList } from '../src/vscode/shared/contextMentions.js'

// `dropTargetView.ts` imports `vscode` at module scope; the real module only loads inside an
// extension host, and nothing here touches it. The import is dynamic and comes AFTER the mock
// because static imports are hoisted above `mock.module`.
mock.module('vscode', () => ({}))
const { handleContextDrop } = (await import(
  '../src/vscode/host/panel/dropTargetView.js'
)) as typeof import('../src/vscode/host/panel/dropTargetView.js')

describe('splitUriList', () => {
  test('splits multiple entries on LF and CRLF', () => {
    expect(splitUriList('file:///a/one.ts\r\nfile:///a/two.ts\nfile:///a/dir')).toEqual([
      'file:///a/one.ts',
      'file:///a/two.ts',
      'file:///a/dir',
    ])
  })

  test('skips # comment lines and blank lines, and trims entries', () => {
    expect(splitUriList('# dragged from Explorer\n\n  file:///a/one.ts  \n   \n#another')).toEqual([
      'file:///a/one.ts',
    ])
  })

  test('rejects a prose sentence and a bare relative path', () => {
    expect(splitUriList('please refactor this')).toEqual([])
    expect(splitUriList('src/a.ts')).toEqual([])
  })

  test('accepts vscode-remote, absolute POSIX and Windows drive paths', () => {
    expect(splitUriList('vscode-remote://ssh-remote+box/home/u/a.ts\n/home/u/b.ts\nC:\\work\\c.ts')).toEqual([
      'vscode-remote://ssh-remote+box/home/u/a.ts',
      '/home/u/b.ts',
      'C:\\work\\c.ts',
    ])
  })

  test('returns nothing for empty input', () => {
    expect(splitUriList('')).toEqual([])
  })
})

describe('handleContextDrop', () => {
  function harness(resolved: string[]) {
    const calls = { resolve: [] as string[][], deliver: [] as string[][], warn: 0 }
    const deps = {
      resolve: async (entries: string[]) => {
        calls.resolve.push(entries)
        return resolved
      },
      deliver: (paths: string[]) => {
        calls.deliver.push(paths)
      },
      warn: () => {
        calls.warn += 1
      },
    }
    return { calls, deps }
  }

  test('resolves every dropped entry and delivers the paths once', async () => {
    const { calls, deps } = harness(['src/a.ts', 'docs/'])
    await handleContextDrop('file:///w/src/a.ts\nfile:///w/docs', deps)
    expect(calls.resolve).toEqual([['file:///w/src/a.ts', 'file:///w/docs']])
    expect(calls.deliver).toEqual([['src/a.ts', 'docs/']])
    expect(calls.warn).toBe(0)
  })

  test('ignores comment lines before resolving', async () => {
    const { calls, deps } = harness(['src/a.ts'])
    await handleContextDrop('# comment\nfile:///w/src/a.ts', deps)
    expect(calls.resolve).toEqual([['file:///w/src/a.ts']])
    expect(calls.deliver).toEqual([['src/a.ts']])
  })

  test('a dropped sentence is not resolved and warns', async () => {
    const { calls, deps } = harness(['should-not-appear'])
    await handleContextDrop('please refactor this', deps)
    expect(calls.resolve).toEqual([])
    expect(calls.deliver).toEqual([])
    expect(calls.warn).toBe(1)
  })

  test('warns and delivers nothing when no entry resolves', async () => {
    const { calls, deps } = harness([])
    await handleContextDrop('file:///w/gone.ts', deps)
    expect(calls.resolve).toHaveLength(1)
    expect(calls.deliver).toEqual([])
    expect(calls.warn).toBe(1)
  })

  test('an empty drop warns without resolving', async () => {
    const { calls, deps } = harness(['x'])
    await handleContextDrop('', deps)
    expect(calls.resolve).toEqual([])
    expect(calls.deliver).toEqual([])
    expect(calls.warn).toBe(1)
  })
})
