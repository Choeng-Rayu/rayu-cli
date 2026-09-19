/**
 * Resolving a review card's path to the file it actually describes.
 *
 * The reported bug: clicking a path in the file-change review card opened nothing,
 * and VS Code said "The editor could not be opened because the file was not found."
 *
 * Root cause — `resolveReviewPath` understood only two of the THREE forms the
 * engine's `getDisplayPath` (`utils/file.ts`) produces, and it resolved the relative
 * form against the wrong base:
 *
 *   form 1  `relative(getCwd(), abs)`  — relative to the ENGINE's cwd, not the
 *           workspace folder, so joining it onto `workspaceFolders[0]` is wrong for
 *           any session whose cwd differs (a panel `cwd` option, a multi-root
 *           workspace, a worktree).
 *   form 2  `~/…`                      — NOT handled at all. Neither absolute nor
 *           workspace-relative, so it was joined onto the workspace as a literal
 *           directory named `~` and could never resolve.
 *   form 3  the absolute path          — handled.
 *
 * The fix resolves through the record's ABSOLUTE `filePath` (what `pendingFileChanges`
 * ran through `expandPath` — the exact file the engine wrote) and teaches the
 * display-path fallback the `~` form.
 *
 * `vscode` is mocked because these are pure resolution decisions; the real module
 * cannot load outside an extension host.
 */
import { describe, expect, mock, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Joins path segments onto a base, mirroring `vscode.Uri.joinPath`. */
function fakeJoinPath(base: { fsPath: string }, ...segments: string[]) {
  const joined = [base.fsPath.replace(/\/+$/, ''), ...segments].join('/')
  return { fsPath: joined, scheme: 'file', path: joined, toString: () => `file://${joined}` }
}

const WORKSPACE = '/mock/workspace'

mock.module('vscode', () => ({
  window: { showWarningMessage: () => Promise.resolve(undefined), showTextDocument: () => Promise.resolve(undefined) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  EventEmitter: class {
    event = () => ({ dispose() {} })
    fire() {}
    dispose() {}
  },
  Uri: {
    file: (f: string) => ({ fsPath: f, scheme: 'file', path: f, with: () => ({}), toString: () => `file://${f}` }),
    joinPath: fakeJoinPath,
    parse: (s: string) => ({ fsPath: s, scheme: 'file', path: s, toString: () => s }),
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: WORKSPACE } }] },
}))

const { resolveReviewPath, resolveReviewFileUri, ReviewStore } = (await import(
  '../src/vscode/host/review/fileChangeReview.js'
)) as typeof import('../src/vscode/host/review/fileChangeReview.js')

/** The resolved filesystem path, for a readable assertion. */
function fsPath(uri: { fsPath?: string } | null): string | undefined {
  return uri?.fsPath
}

describe('the ~/ form is expanded against the real home directory', () => {
  // THE BUG: `getDisplayPath` returns `~/…` for any file under home that is outside
  // the engine's cwd. It used to be joined onto the workspace, producing a literal
  // `~` segment and a guaranteed "file not found".
  test('a ~/ path resolves under the home directory, not the workspace', () => {
    const resolved = fsPath(resolveReviewPath('~/projects/rayu/src/a.ts'))
    expect(resolved).toBe(join(homedir(), 'projects/rayu/src/a.ts'))
    expect(resolved).not.toContain('~')
    expect(resolved?.startsWith(WORKSPACE)).toBe(false)
  })

  test('the Windows-separator form is handled too', () => {
    expect(fsPath(resolveReviewPath('~\\projects\\a.ts'))).toBe(
      join(homedir(), 'projects/a.ts'),
    )
  })

  test('a bare ~ is the home directory', () => {
    expect(fsPath(resolveReviewPath('~'))).toBe(homedir())
  })
})

describe('the absolute and relative forms still resolve', () => {
  test('an absolute path is used as-is', () => {
    expect(fsPath(resolveReviewPath('/abs/path/a.ts'))).toBe('/abs/path/a.ts')
  })

  test('a Windows drive path is treated as absolute', () => {
    expect(fsPath(resolveReviewPath('C:\\proj\\a.ts'))).toBe('C:\\proj\\a.ts')
  })

  test('a plain relative path joins the workspace (unchanged behaviour)', () => {
    expect(fsPath(resolveReviewPath('src/a.ts'))).toBe(`${WORKSPACE}/src/a.ts`)
  })
})

describe('the record\'s absolute filePath wins over the display path', () => {
  // This is the real fix for a session whose cwd is NOT the first workspace folder:
  // the display path is relative to the ENGINE's cwd, so only the absolute path is
  // trustworthy.
  test('an absolute filePath is preferred even when displayPath would resolve elsewhere', () => {
    const uri = resolveReviewFileUri({
      filePath: '/real/session/dir/src/a.ts',
      displayPath: 'src/a.ts',
    })
    // Without the fix this would be /mock/workspace/src/a.ts — the wrong file.
    expect(fsPath(uri)).toBe('/real/session/dir/src/a.ts')
  })

  test('a ~/ displayPath is used when filePath is missing', () => {
    const uri = resolveReviewFileUri({ filePath: '', displayPath: '~/proj/a.ts' })
    expect(fsPath(uri)).toBe(join(homedir(), 'proj/a.ts'))
  })

  test('a relative filePath falls back to display-path resolution', () => {
    const uri = resolveReviewFileUri({ filePath: 'src/a.ts', displayPath: 'src/a.ts' })
    expect(fsPath(uri)).toBe(`${WORKSPACE}/src/a.ts`)
  })
})

describe('the store hands the record to the resolver', () => {
  test('a record retrieved by displayPath carries its absolute filePath', () => {
    const store = new ReviewStore()
    store.replace([
      {
        filePath: '/real/session/dir/src/a.ts',
        displayPath: 'src/a.ts',
        changeIds: ['c1'],
        hunks: [],
        isCreated: false,
      },
    ])
    const record = store.get('src/a.ts')
    expect(record).toBeDefined()
    expect(fsPath(resolveReviewFileUri(record!))).toBe('/real/session/dir/src/a.ts')
  })

  test('an unknown displayPath has no record, so the fallback path is used', () => {
    const store = new ReviewStore()
    expect(store.get('nope.ts')).toBeUndefined()
  })
})
