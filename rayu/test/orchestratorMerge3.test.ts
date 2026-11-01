/**
 * Task 12: the per-file 3-way merge used to bring worktree packets back. What can be
 * merged as text is merged; anything else is a conflict, never a guess.
 */
import { describe, expect, test } from 'bun:test'
import {
  decideFile,
  dominantLineEnding,
  hasMergeMarkers,
  isBinaryContent,
  mergedMode,
  mergeLabels,
  mergeText,
  type SideEntry,
  toLf,
  withLineEnding,
} from '../src/orchestrator/merge3.ts'
import { permissionsFor } from '../src/orchestrator/worktreeMerge.ts'

const file = (blob: string, mode = '100644'): SideEntry => ({ mode, blob })
const sides = (base: SideEntry, ours: SideEntry, theirs: SideEntry, lfs = false) => ({ path: 'a.ts', base, ours, theirs, lfs })

describe('what to do with one file the worker changed', () => {
  test('nothing when the main tree already has the same version', () => {
    expect(decideFile(sides(file('b'), file('t'), file('t')))).toEqual({ kind: 'skip' })
    expect(decideFile(sides(file('b'), null, null))).toEqual({ kind: 'skip' })
  })

  test("take the worker's version when only the worker changed it, including deletes and adds", () => {
    expect(decideFile(sides(file('b'), file('b'), file('t')))).toEqual({ kind: 'take-theirs' })
    expect(decideFile(sides(file('b'), file('b'), null))).toEqual({ kind: 'take-theirs' })
    expect(decideFile(sides(null, null, file('t')))).toEqual({ kind: 'take-theirs' })
    expect(decideFile(sides(file('b'), file('b'), file('b', '100755')))).toEqual({ kind: 'take-theirs' })
  })

  test('merge text when both sides changed a regular file', () => {
    expect(decideFile(sides(file('b'), file('o'), file('t')))).toEqual({ kind: 'merge-text' })
  })

  test('symlinks, submodules and LFS files are conflicts', () => {
    expect(decideFile(sides(file('b'), file('b'), file('t', '120000')))).toEqual({ kind: 'conflict', reason: 'special-file' })
    expect(decideFile(sides(file('b', '160000'), file('b', '160000'), file('t', '160000')))).toEqual({ kind: 'conflict', reason: 'special-file' })
    expect(decideFile(sides(file('b'), file('o', '120000'), file('t')))).toEqual({ kind: 'conflict', reason: 'special-file' })
    expect(decideFile(sides(file('b'), file('o'), file('t'), true))).toEqual({ kind: 'conflict', reason: 'lfs' })
  })

  test('a delete on one side and a change on the other, or two different adds, are conflicts', () => {
    expect(decideFile(sides(file('b'), null, file('t')))).toEqual({ kind: 'conflict', reason: 'delete-modify' })
    expect(decideFile(sides(file('b'), file('o'), null))).toEqual({ kind: 'conflict', reason: 'delete-modify' })
    expect(decideFile(sides(null, file('o'), file('t')))).toEqual({ kind: 'conflict', reason: 'add-add' })
  })
})

describe('content checks', () => {
  test('binary content: a NUL byte, or bytes that are not UTF-8', () => {
    expect(isBinaryContent(Buffer.from('plain text\n'))).toBe(false)
    expect(isBinaryContent(Buffer.from('caf\u00e9 \u2713\n'))).toBe(false)
    expect(isBinaryContent(Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true)
    expect(isBinaryContent(Buffer.from([0xff, 0xfe, 0x41]))).toBe(true)
  })

  test('line endings are detected and restored', () => {
    expect(dominantLineEnding('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(dominantLineEnding('a\nb\r\n')).toBe('\n')
    expect(dominantLineEnding('no breaks')).toBe('\n')
    expect(withLineEnding(toLf('a\r\nb\r\n'), '\r\n')).toBe('a\r\nb\r\n')
  })

  test("only this merge's own conflict markers count as unresolved", () => {
    const labels = mergeLabels('api')
    expect(hasMergeMarkers(`x\n<<<<<<< ${labels.ours}\na\n=======\nb\n>>>>>>> ${labels.theirs}\n`)).toBe(true)
    expect(hasMergeMarkers('x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n')).toBe(false)
    expect(hasMergeMarkers('const arrow = "<<<<<<< (rayu merge)"\n')).toBe(false)
  })

  test("a merged file keeps the main tree's mode unless the worker changed it", () => {
    expect(mergedMode({ base: file('b'), ours: file('o', '100755'), theirs: file('t') })).toBe('100755')
    expect(mergedMode({ base: file('b'), ours: file('o'), theirs: file('t', '100755') })).toBe('100755')
    expect(permissionsFor('100755', 0o100640)).toBe(0o750)
    expect(permissionsFor('100644', 0o100755)).toBe(0o644)
    expect(permissionsFor('100644', null)).toBe(0o644)
  })
})

describe('merging text', () => {
  const base = 'line 1\nline 2\nline 3\nline 4\n'

  test('changes to different lines merge cleanly', async () => {
    const result = await mergeText({ base, ours: 'line 1 main\nline 2\nline 3\nline 4\n', theirs: 'line 1\nline 2\nline 3\nline 4 worker\n', packet: 'api' })
    expect(result).toEqual({ clean: true, text: 'line 1 main\nline 2\nline 3\nline 4 worker\n', conflicts: 0 })
  })

  test('the same change on both sides is not a conflict', async () => {
    const same = 'line 1\nline 2 both\nline 3\nline 4\n'
    expect(await mergeText({ base, ours: same, theirs: same, packet: 'api' })).toEqual({ clean: true, text: same, conflicts: 0 })
  })

  test('changes to the same line conflict, with labelled markers that show the base', async () => {
    const result = await mergeText({ base, ours: 'line 1\nmain\nline 3\nline 4\n', theirs: 'line 1\nworker\nline 3\nline 4\n', packet: 'api' })
    expect(result.clean).toBe(false)
    expect(result.conflicts).toBe(1)
    expect(result.text).toContain('<<<<<<< main tree (rayu merge)\nmain\n||||||| base (rayu merge)\nline 2\n=======\nworker\n>>>>>>> packet api (rayu merge)\n')
    expect(hasMergeMarkers(result.text)).toBe(true)
  })

  test("a CRLF main tree and an LF worker merge line by line, and the result keeps CRLF", async () => {
    const crlf = (text: string) => text.replace(/\n/g, '\r\n')
    const result = await mergeText({ base, ours: crlf('line 1 main\nline 2\nline 3\nline 4\n'), theirs: 'line 1\nline 2\nline 3\nline 4 worker\n', packet: 'api' })
    expect(result).toEqual({ clean: true, text: crlf('line 1 main\nline 2\nline 3\nline 4 worker\n'), conflicts: 0 })
  })

  test('a file without a final newline merges without gaining one', async () => {
    const result = await mergeText({ base: 'a\nb', ours: 'a main\nb', theirs: 'a\nb worker', packet: 'api' })
    expect(result.clean).toBe(false)
    const apart = await mergeText({ base: 'a\nb\nc\nd', ours: 'a main\nb\nc\nd', theirs: 'a\nb\nc\nd worker', packet: 'api' })
    expect(apart).toEqual({ clean: true, text: 'a main\nb\nc\nd worker', conflicts: 0 })
  })
})
