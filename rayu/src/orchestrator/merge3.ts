/**
 * Three-way merge of one file, for bringing a worktree packet's changes back into the
 * main tree.
 *
 * The base is the tree the worker started from (the run's baseline, or the last time
 * its worktree was synced), "ours" is the main tree now, and "theirs" is the worker's
 * worktree. `decideFile` says what to do from the three git entries alone; text that
 * both sides changed is merged by `mergeText` with `git merge-file`, after normalizing
 * line endings so a CRLF checkout and an LF blob do not conflict on every line.
 *
 * Anything that cannot be merged as text safely is a conflict for a person or the
 * worker to settle, never a guess: binary files, symlinks and submodules, Git LFS
 * files, a file deleted on one side and changed on the other, and a file both sides
 * added differently.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGitBinary } from '../utils/git/gitBinary.js'
import { isSpecialMode } from './gitSnapshot.js'

/** A file's git entry on one side; null when the file does not exist there. */
export type SideEntry = { readonly mode: string; readonly blob: string } | null

export type FileSides = {
  readonly path: string
  readonly base: SideEntry
  readonly ours: SideEntry
  readonly theirs: SideEntry
  /** The path's `filter` attribute is `lfs`. */
  readonly lfs: boolean
}

export type ConflictReason =
  | 'special-file'
  | 'lfs'
  | 'binary'
  | 'delete-modify'
  | 'add-add'
  | 'content'
  | 'unresolved-markers'

export type FileDecision =
  /** The main tree already has the worker's version. */
  | { readonly kind: 'skip' }
  /** Only the worker changed the file: take its version (or delete it). */
  | { readonly kind: 'take-theirs' }
  /** Both sides changed a regular file: merge the contents. */
  | { readonly kind: 'merge-text' }
  | { readonly kind: 'conflict'; readonly reason: ConflictReason }

export const CONFLICT_REASON_TEXT: Readonly<Record<ConflictReason, string>> = {
  'special-file': 'a symlink or submodule, which is not merged automatically',
  lfs: 'a Git LFS file changed on both sides',
  binary: 'a binary file changed on both sides',
  'delete-modify': 'deleted on one side and changed on the other',
  'add-add': 'added on both sides with different content',
  content: 'both sides changed the same lines',
  'unresolved-markers': 'the worker left conflict markers in it',
}

function sameEntry(a: SideEntry, b: SideEntry): boolean {
  if (a === null || b === null) return a === b
  return a.mode === b.mode && a.blob === b.blob
}

function special(entry: SideEntry): boolean {
  return entry !== null && isSpecialMode(entry.mode)
}

/** Pure: what to do with one file the worker changed. */
export function decideFile(sides: FileSides): FileDecision {
  const { base, ours, theirs } = sides
  if (sameEntry(ours, theirs)) return { kind: 'skip' }
  if (special(base) || special(theirs)) return { kind: 'conflict', reason: 'special-file' }
  if (sameEntry(ours, base)) return { kind: 'take-theirs' }
  if (special(ours)) return { kind: 'conflict', reason: 'special-file' }
  if (sides.lfs) return { kind: 'conflict', reason: 'lfs' }
  if (ours === null || theirs === null) return { kind: 'conflict', reason: 'delete-modify' }
  if (base === null) return { kind: 'conflict', reason: 'add-add' }
  return { kind: 'merge-text' }
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes, or bytes that are not UTF-8. */
export function isBinaryContent(content: Buffer): boolean {
  if (content.subarray(0, 8000).includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content)
    return false
  } catch {
    return true
  }
}

export type LineEnding = '\n' | '\r\n'

/** CRLF when most line breaks are CRLF; LF otherwise (including no line breaks). */
export function dominantLineEnding(text: string): LineEnding {
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1 - crlf
  return crlf > lf ? '\r\n' : '\n'
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** LF text with every line break as `eol`. */
export function withLineEnding(lfText: string, eol: LineEnding): string {
  return eol === '\n' ? lfText : lfText.replace(/\n/g, '\r\n')
}

/** Marker labels: the `(rayu merge)` suffix tells our markers from a project's own. */
export const MERGE_LABEL_SUFFIX = '(rayu merge)'

export function mergeLabels(packet: string): { ours: string; base: string; theirs: string } {
  return {
    ours: `main tree ${MERGE_LABEL_SUFFIX}`,
    base: `base ${MERGE_LABEL_SUFFIX}`,
    theirs: `packet ${packet} ${MERGE_LABEL_SUFFIX}`,
  }
}

const OUR_MARKER = /^(?:<{7}|\|{7}|>{7}) .*\(rayu merge\)\s*$/m

/** Whether `text` still has conflict markers this merge wrote into a worktree. */
export function hasMergeMarkers(text: string): boolean {
  return OUR_MARKER.test(text)
}

export type TextMergeInput = {
  base: string
  ours: string
  theirs: string
  packet: string
}

export type TextMergeResult = {
  /** True when no lines conflict. */
  clean: boolean
  /** The merged text, with conflict markers where it is not clean, in ours' line endings. */
  text: string
  conflicts: number
}

/**
 * Merge three texts with `git merge-file --diff3`. Line endings are normalized to LF
 * for the merge and the result uses the main tree's dominant line ending.
 */
export async function mergeText(input: TextMergeInput): Promise<TextMergeResult> {
  const eol = dominantLineEnding(input.ours)
  const scratch = await mkdtemp(join(tmpdir(), 'rayu-merge3-'))
  try {
    const files = { ours: join(scratch, 'ours'), base: join(scratch, 'base'), theirs: join(scratch, 'theirs') }
    await Promise.all([
      writeFile(files.ours, toLf(input.ours)),
      writeFile(files.base, toLf(input.base)),
      writeFile(files.theirs, toLf(input.theirs)),
    ])
    const labels = mergeLabels(input.packet)
    const result = await runGitBinary(
      ['merge-file', '-p', '--diff3', '-L', labels.ours, '-L', labels.base, '-L', labels.theirs, files.ours, files.base, files.theirs],
      { cwd: scratch },
    )
    // The exit code is the number of conflicts (at most 127); anything else is an error.
    if (result.code < 0 || result.code > 127) {
      throw new Error(`git merge-file failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`)
    }
    return { clean: result.code === 0, text: withLineEnding(result.stdout.toString('utf8'), eol), conflicts: result.code }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** The file mode a merged file gets: the worker's, if it changed the mode, else the main tree's. */
export function mergedMode(sides: Pick<FileSides, 'base' | 'ours' | 'theirs'>): string {
  const theirs = sides.theirs?.mode
  const base = sides.base?.mode
  if (theirs && theirs !== base) return theirs
  return sides.ours?.mode ?? theirs ?? '100644'
}
