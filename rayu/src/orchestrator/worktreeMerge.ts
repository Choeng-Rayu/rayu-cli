/**
 * Merge a worktree packet's changes into the main tree, file by file (merge3.ts), all
 * or nothing.
 *
 * `planMerge` works out every file's outcome without writing anything. `applyMerge`
 * then writes the main tree synchronously, so no other tool call can interleave: it
 * first checks that every file it will touch still has the bytes the plan was made
 * from (a shared-tree worker may have written meanwhile), and restores every file it
 * already wrote if a later one fails. When the plan has conflicts nothing is written
 * to the main tree; `syncWorktree` instead brings the main tree's changes into the
 * worktree, with conflict markers where both sides changed the same lines, so the
 * worker can resolve them where its work is.
 */
import { randomBytes } from 'crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { lstat, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  commitTreeAndKeep,
  diffTrees,
  isSpecialMode,
  lfsFilteredPaths,
  readBlob,
  readBlobsForCheckout,
  type TreeChange,
  treeWithEntriesFrom,
  workingTreeTree,
} from './gitSnapshot.js'
import {
  type ConflictReason,
  decideFile,
  hasMergeMarkers,
  isBinaryContent,
  mergedMode,
  mergeText,
  type SideEntry,
} from './merge3.js'

export type MergeTarget = {
  /** The main tree. */
  readonly repoRoot: string
  readonly worktreePath: string
  /** The commit (or tree) the worktree's changes are measured from. */
  readonly base: string
  readonly packet: string
  /** Paths left out of the main tree's snapshot, such as a plans directory inside it. */
  readonly mainExcludes: readonly string[]
  /** Paths left out of the worktree's snapshot, such as directories symlinked into it. */
  readonly worktreeExcludes: readonly string[]
}

/** A file's bytes on disk: null when absent, NOT_A_FILE for a directory or symlink. */
export const NOT_A_FILE = Symbol('not-a-file')
export type DiskContent = Buffer | null | typeof NOT_A_FILE

export type PlannedWrite = {
  /** Repository-relative, forward slashes. */
  readonly path: string
  /** The new bytes; null deletes the file. */
  readonly content: Buffer | null
  /** The git mode of the new file. */
  readonly mode: string
  /** The bytes the plan was made from. The write is refused if the file no longer has them. */
  readonly expected: DiskContent
  /** Both sides changed the file and it merged cleanly. */
  readonly merged: boolean
}

export type PlannedConflict = {
  readonly path: string
  readonly reason: ConflictReason
  /** For `content`: the merged text with conflict markers. */
  readonly markedText?: string
  /** The worker's git mode for the file. */
  readonly mode?: string
}

export type MergePlan = {
  readonly workerTree: string
  readonly mainTree: string
  readonly workerPaths: readonly string[]
  readonly writes: readonly PlannedWrite[]
  readonly conflicts: readonly PlannedConflict[]
}

/** The main tree changed under a planned write. Plan again. */
export class StaleMainTreeError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while the merge was being planned`)
    this.name = 'StaleMainTreeError'
  }
}

function entryOf(mode: string, blob: string): SideEntry {
  return /^0+$/.test(mode) ? null : { mode, blob }
}

async function readDisk(path: string): Promise<DiskContent> {
  try {
    const stats = await lstat(path)
    return stats.isFile() ? await readFile(path) : NOT_A_FILE
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function readDiskSync(path: string): DiskContent {
  try {
    return lstatSync(path).isFile() ? readFileSync(path) : NOT_A_FILE
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** ENOENT, or ENOTDIR when a parent of the path is a file. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function sameContent(a: DiskContent, b: DiskContent): boolean {
  if (a === null || a === NOT_A_FILE || b === null || b === NOT_A_FILE) return a === b
  return a.equals(b)
}

type FilePlan = { write: PlannedWrite } | { conflict: PlannedConflict } | null

type FileInput = {
  target: MergeTarget
  change: TreeChange
  main: TreeChange | undefined
  lfs: boolean
  expected: DiskContent
}

async function planFile({ target, change, main, lfs, expected }: FileInput): Promise<FilePlan> {
  const path = change.path
  const base = entryOf(change.oldMode, change.oldBlob)
  const theirs = entryOf(change.newMode, change.newBlob)
  const ours = main ? entryOf(main.newMode, main.newBlob) : base
  const decision = decideFile({ path, base, ours, theirs, lfs })
  if (decision.kind === 'skip') return null
  if (decision.kind === 'conflict') return { conflict: { path, reason: decision.reason } }
  if (expected === NOT_A_FILE) return { conflict: { path, reason: 'special-file' } }
  if (theirs === null) return { write: { path, content: null, mode: '', expected, merged: false } }
  const theirsBytes = await readFile(join(target.worktreePath, path))
  const theirsBinary = isBinaryContent(theirsBytes)
  if (!theirsBinary && hasMergeMarkers(theirsBytes.toString('utf8'))) {
    return { conflict: { path, reason: 'unresolved-markers', mode: theirs.mode } }
  }
  if (decision.kind === 'take-theirs') return { write: { path, content: theirsBytes, mode: theirs.mode, expected, merged: false } }
  // Both changed a regular text file. The disk read comes first; a later change is caught on apply.
  if (expected === null) throw new StaleMainTreeError(path)
  const baseBytes = await readBlob(target.repoRoot, base!.blob)
  if (theirsBinary || isBinaryContent(expected) || isBinaryContent(baseBytes)) {
    return { conflict: { path, reason: 'binary', mode: theirs.mode } }
  }
  const result = await mergeText({
    base: baseBytes.toString('utf8'),
    ours: expected.toString('utf8'),
    theirs: theirsBytes.toString('utf8'),
    packet: target.packet,
  })
  const mode = mergedMode({ base, ours, theirs })
  if (!result.clean) return { conflict: { path, reason: 'content', markedText: result.text, mode } }
  return { write: { path, content: Buffer.from(result.text, 'utf8'), mode, expected, merged: true } }
}

/** Work out the merge without writing anything. */
export async function planMerge(target: MergeTarget): Promise<MergePlan> {
  const workerTree = await workingTreeTree(target.worktreePath, target.worktreeExcludes)
  const workerChanges = await diffTrees(target.repoRoot, target.base, workerTree)
  const workerPaths = workerChanges.map(change => change.path)
  // Read the main tree's files before snapshotting it: any write after this read is
  // caught by applyMerge's check, whichever side of the snapshot it lands on.
  const expected = new Map<string, DiskContent>()
  for (const path of workerPaths) expected.set(path, await readDisk(join(target.repoRoot, path)))
  const mainTree = await workingTreeTree(target.repoRoot, target.mainExcludes)
  if (workerChanges.length === 0) return { workerTree, mainTree, workerPaths, writes: [], conflicts: [] }
  const mainChanges = new Map((await diffTrees(target.repoRoot, target.base, mainTree)).map(change => [change.path, change]))
  const lfs = await lfsFilteredPaths(target.repoRoot, workerPaths)
  const writes: PlannedWrite[] = []
  const conflicts: PlannedConflict[] = []
  for (const change of workerChanges) {
    const planned = await planFile({
      target,
      change,
      main: mainChanges.get(change.path),
      lfs: lfs.has(change.path),
      expected: expected.get(change.path) ?? null,
    })
    if (planned && 'write' in planned) writes.push(planned.write)
    else if (planned) conflicts.push(planned.conflict)
  }
  return { workerTree, mainTree, workerPaths, writes, conflicts }
}

export type AppliedWrite = {
  readonly path: string
  readonly absolutePath: string
  readonly before: Buffer | null
  readonly after: Buffer | null
}

type Backup = AppliedWrite & { readonly previousMode: number | null }

/** Permission bits for a written file: the git mode's executable bit on the old permissions. */
export function permissionsFor(gitMode: string, previousMode: number | null): number {
  const executable = gitMode === '100755'
  if (previousMode === null) return executable ? 0o755 : 0o644
  const perms = previousMode & 0o777
  return executable ? perms | ((perms & 0o444) >> 2) : perms & ~0o111
}

function writeAtomically(absolutePath: string, content: Buffer, mode: number): void {
  mkdirSync(dirname(absolutePath), { recursive: true })
  const temporary = `${absolutePath}.rayu-merge-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temporary, content, { mode })
    chmodSync(temporary, mode)
    renameSync(temporary, absolutePath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function restore(backups: readonly Backup[]): void {
  for (const backup of [...backups].reverse()) {
    try {
      if (backup.before === null) rmSync(backup.absolutePath, { force: true })
      else writeAtomically(backup.absolutePath, backup.before, backup.previousMode ?? 0o644)
    } catch {
      // Best effort: keep restoring the others. The caller reports the failure.
    }
  }
}

/**
 * Write planned files under `root`, synchronously and all or nothing. Throws
 * StaleMainTreeError, before writing anything, if a file no longer has the bytes it was
 * planned from; restores everything already written if a write fails.
 */
export function applyWrites(root: string, writes: readonly PlannedWrite[]): AppliedWrite[] {
  const targets = writes.map(write => ({ write, absolutePath: join(root, write.path) }))
  const current = targets.map(({ absolutePath }) => readDiskSync(absolutePath))
  targets.forEach(({ write }, index) => {
    const now = current[index]!
    if (!sameContent(now, write.expected) || now === NOT_A_FILE) throw new StaleMainTreeError(write.path)
  })
  const backups: Backup[] = []
  try {
    targets.forEach(({ write, absolutePath }, index) => {
      const before = current[index] as Buffer | null
      const previousMode = before === null ? null : lstatSync(absolutePath).mode
      backups.push({ path: write.path, absolutePath, before, after: write.content, previousMode })
      if (write.content === null) rmSync(absolutePath, { force: true })
      else writeAtomically(absolutePath, write.content, permissionsFor(write.mode, previousMode))
    })
  } catch (error) {
    restore(backups)
    throw error
  }
  return backups.map(({ previousMode: _previousMode, ...applied }) => applied)
}

/** Apply a conflict-free plan to the main tree. */
export function applyMerge(target: MergeTarget, plan: MergePlan): AppliedWrite[] {
  if (plan.conflicts.length > 0) throw new Error('A merge with conflicts cannot be applied')
  return applyWrites(target.repoRoot, plan.writes)
}

type WorktreeFile = { path: string; content: Buffer | null; mode: string }

/** What the worktree should hold for one path the main tree changed, or null to hold it back. */
function syncedFile(
  change: TreeChange,
  plan: MergePlan,
  checkedOut: ReadonlyMap<string, Buffer>,
): WorktreeFile | 'held' | 'unchanged' {
  const conflict = plan.conflicts.find(item => item.path === change.path)
  if (conflict) {
    return conflict.markedText === undefined
      ? 'held'
      : { path: change.path, content: Buffer.from(conflict.markedText, 'utf8'), mode: conflict.mode ?? change.newMode }
  }
  const write = plan.writes.find(item => item.path === change.path)
  if (write?.merged) return { path: change.path, content: write.content, mode: write.mode }
  if (plan.workerPaths.includes(change.path)) return 'unchanged'
  if (isSpecialMode(change.oldMode) || isSpecialMode(change.newMode)) return 'held'
  if (/^0+$/.test(change.newMode)) return { path: change.path, content: null, mode: '' }
  const content = checkedOut.get(change.path)
  return content ? { path: change.path, content, mode: change.newMode } : 'held'
}

/**
 * After a conflict: bring the main tree's changes into the worktree, with conflict
 * markers where both sides changed the same lines, and record the new base its changes
 * are measured from. Paths the worktree could not take (binary, symlinks, LFS,
 * delete/modify) keep their old base entry, so the next merge still sees them as
 * conflicting rather than as the worker's change. Returns the new base commit.
 */
export async function syncWorktree(target: MergeTarget, plan: MergePlan, ref: string): Promise<string> {
  const mainChanges = await diffTrees(target.repoRoot, target.base, plan.mainTree)
  const checkedOut = await readBlobsForCheckout(
    target.repoRoot,
    mainChanges.filter(change => !/^0+$/.test(change.newMode)).map(change => ({ blob: change.newBlob, path: change.path })),
  )
  const files: WorktreeFile[] = []
  const held = new Set(plan.conflicts.filter(conflict => conflict.markedText === undefined).map(conflict => conflict.path))
  for (const change of mainChanges) {
    const synced = syncedFile(change, plan, checkedOut)
    if (synced === 'held') held.add(change.path)
    else if (synced !== 'unchanged') files.push(synced)
  }
  const writes: PlannedWrite[] = []
  for (const file of files) {
    const expected = readDiskSync(join(target.worktreePath, file.path))
    // A directory or symlink where the file should go: leave it, and keep the old base for it.
    if (expected === NOT_A_FILE) held.add(file.path)
    else writes.push({ path: file.path, content: file.content, mode: file.mode, expected, merged: false })
  }
  const tree = await treeWithEntriesFrom(target.repoRoot, plan.mainTree, target.base, [...held])
  const commit = await commitTreeAndKeep(target.repoRoot, tree, ref, `Rayu orchestration sync: packet ${target.packet}`)
  // The worker has finished, so nothing else writes its worktree; the checks above still hold.
  applyWrites(target.worktreePath, writes)
  return commit
}
