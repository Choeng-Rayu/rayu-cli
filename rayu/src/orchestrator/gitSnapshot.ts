/**
 * Snapshots of the working tree as git commits, without touching the user's repository
 * state.
 *
 * An Orchestrator run needs to know what the tree looked like before its workers
 * started (the baseline) and at later checkpoints: to attribute each change to a
 * worker, to diff a worker's packet, and to 3-way merge worktree packets back. A
 * snapshot records the whole working tree, including untracked files, and excludes
 * ignored files.
 *
 * How it stays out of the user's way: it works on a COPY of the index (via
 * GIT_INDEX_FILE), so their staging area is untouched; it writes a commit with
 * `commit-tree`, so no branch, HEAD or stash moves; and it keeps the commit alive with
 * a private ref under refs/rayu/orchestration/, deleted when the run ends. Copying the
 * index (rather than starting from an empty one) lets git reuse its stat cache, so
 * unchanged files are not re-hashed.
 */
import { copyFile, mkdtemp, rm, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { runGitBinary, runGitLine, runGitOrThrow } from '../utils/git/gitBinary.js'

const SNAPSHOT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Rayu Orchestrator',
  GIT_AUTHOR_EMAIL: 'orchestrator@rayu.invalid',
  GIT_COMMITTER_NAME: 'Rayu Orchestrator',
  GIT_COMMITTER_EMAIL: 'orchestrator@rayu.invalid',
}

/** Directories never included in a snapshot, relative to the repository root. */
export const SNAPSHOT_ALWAYS_EXCLUDED: readonly string[] = ['.rayu/worktrees']

export type WorkingTreeSnapshot = {
  readonly commit: string
  readonly tree: string
  readonly ref: string
  readonly takenAt: number
}

export type TreeChangeStatus = 'added' | 'modified' | 'deleted' | 'type-changed' | 'other'

export type TreeChange = {
  readonly status: TreeChangeStatus
  /** Repository-relative, forward slashes, exactly as git reports it. */
  readonly path: string
  readonly oldMode: string
  readonly newMode: string
  readonly oldBlob: string
  readonly newBlob: string
}

/** A ref-name component that git accepts: letters, digits, `.`, `_` and `-`. */
export function refComponent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+/, '')
  const safe = cleaned.replace(/\.lock$/i, '-lock').replace(/[.]+$/, '')
  return safe || 'x'
}

export function snapshotRefPrefix(sessionKey: string, runId: string): string {
  return `refs/rayu/orchestration/${refComponent(sessionKey)}/${refComponent(runId)}`
}

/** `:(top,exclude)` pathspecs; paths outside the repository are dropped. */
function excludePathspecs(paths: readonly string[]): string[] {
  return [...SNAPSHOT_ALWAYS_EXCLUDED, ...paths]
    .map(path => path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter(path => path && !path.startsWith('../') && path !== '..' && !path.startsWith('/'))
    .map(path => `:(top,exclude)${path}`)
}

async function copyIndexTo(repoRoot: string, target: string): Promise<void> {
  const indexPath = resolve(repoRoot, await runGitLine(['rev-parse', '--git-path', 'index'], { cwd: repoRoot }))
  try {
    await copyFile(indexPath, target)
    // Keep the index's own mtime. Git re-reads any file whose cached mtime is not older
    // than the index ("racily clean"); a copy stamped "now" would make git trust stale
    // stat data, and miss a same-size edit made in the same second as the last `git add`.
    const { atime, mtime } = await stat(indexPath)
    await utimes(target, atime, mtime)
  } catch (error) {
    // A repository without an index yet (nothing ever staged) starts empty.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await rm(target, { force: true })
  }
}

async function headCommit(repoRoot: string): Promise<string | null> {
  const result = await runGitBinary(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: repoRoot })
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null
}

export type SnapshotOptions = {
  repoRoot: string
  refPrefix: string
  /** Names the snapshot within its run, such as "baseline" or "checkpoint-2". */
  label: string
  /** Extra repository-relative paths to leave out, such as an audit directory inside the project. */
  excludePaths?: readonly string[]
}

/**
 * The working tree as a git tree object, without a commit or ref. Cheap enough to take
 * before and after a single command: git reuses the copied index's stat cache.
 */
export async function workingTreeTree(repoRoot: string, excludePaths: readonly string[] = []): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'rayu-snapshot-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }
    await copyIndexTo(repoRoot, env.GIT_INDEX_FILE)
    await runGitOrThrow(['add', '-A', '--', '.', ...excludePathspecs(excludePaths)], { cwd: repoRoot, env })
    return await runGitLine(['write-tree'], { cwd: repoRoot, env })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Record the working tree as a commit and keep it under `refPrefix/label`. */
export async function snapshotWorkingTree(options: SnapshotOptions): Promise<WorkingTreeSnapshot> {
  const { repoRoot } = options
  const tree = await workingTreeTree(repoRoot, options.excludePaths ?? [])
  const parent = await headCommit(repoRoot)
  const ref = `${options.refPrefix}/${refComponent(options.label)}`
  const commit = await commitTreeAndKeep(repoRoot, tree, ref, `Rayu orchestration snapshot: ${options.label}`, parent)
  return { commit, tree, ref, takenAt: Date.now() }
}

/** Commit `tree` without moving any branch, and keep the commit alive under `ref`. */
export async function commitTreeAndKeep(
  repoRoot: string,
  tree: string,
  ref: string,
  message: string,
  parent: string | null = null,
): Promise<string> {
  const commit = await runGitLine(
    ['-c', 'commit.gpgSign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
    { cwd: repoRoot, env: SNAPSHOT_IDENTITY },
  )
  await runGitOrThrow(['update-ref', ref, commit], { cwd: repoRoot })
  return commit
}

/**
 * `tree` with some paths set back to their entries in `fromTree` (removed where
 * `fromTree` has none). Built in a scratch index; nothing in the repository moves.
 */
export async function treeWithEntriesFrom(
  repoRoot: string,
  tree: string,
  fromTree: string,
  paths: readonly string[],
): Promise<string> {
  if (paths.length === 0) return tree
  const scratch = await mkdtemp(join(tmpdir(), 'rayu-tree-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }
    await runGitOrThrow(['read-tree', tree], { cwd: repoRoot, env })
    const wanted = new Set(paths)
    const listed = await runGitOrThrow(['ls-tree', '-r', '-z', '--full-tree', fromTree], { cwd: repoRoot })
    const found = new Map<string, string>()
    for (const record of listed.toString('utf8').split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const path = record.slice(tab + 1)
      const [mode = '', , blob = ''] = record.slice(0, tab).split(' ')
      if (wanted.has(path)) found.set(path, `${mode} ${blob}`)
    }
    const zero = '0'.repeat(tree.length)
    const info = paths.map(path => `${found.get(path) ?? `0 ${zero}`}\t${path}\0`).join('')
    await runGitOrThrow(['update-index', '-z', '--index-info'], { cwd: repoRoot, env, input: info })
    return await runGitLine(['write-tree'], { cwd: repoRoot, env })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Blob contents as they are checked out at `path` (smudge filters and line-ending
 * conversion applied). One `git cat-file --filters` per blob: in `--batch` mode git
 * reports the unfiltered size in its header, so the output cannot be split reliably.
 */
export async function readBlobsForCheckout(
  repoRoot: string,
  entries: readonly { blob: string; path: string }[],
): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>()
  const queue = [...entries]
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      contents.set(entry.path, await runGitOrThrow(['cat-file', '--filters', `--path=${entry.path}`, entry.blob], { cwd: repoRoot }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHECKOUT_READ_CONCURRENCY, queue.length) }, worker))
  return contents
}

const CHECKOUT_READ_CONCURRENCY = 8

const STATUS_BY_LETTER: Readonly<Record<string, TreeChangeStatus>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type-changed',
}

/** Parse `git diff-tree -r -z --raw` output: a `:meta` record then a path, repeated. */
export function parseRawDiff(output: Buffer): TreeChange[] {
  const fields = output.toString('utf8').split('\0')
  const changes: TreeChange[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!
    if (!meta.startsWith(':')) continue
    const [oldMode = '', newMode = '', oldBlob = '', newBlob = '', letter = ''] = meta.slice(1).split(' ')
    changes.push({
      status: STATUS_BY_LETTER[letter.charAt(0)] ?? 'other',
      path: fields[i + 1]!,
      oldMode,
      newMode,
      oldBlob,
      newBlob,
    })
  }
  return changes
}

/** Files that differ between two snapshots (or any commits), optionally limited to paths. */
export async function diffTrees(
  repoRoot: string,
  from: string,
  to: string,
  paths: readonly string[] = [],
): Promise<TreeChange[]> {
  const args = ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to, ...(paths.length ? ['--', ...paths] : [])]
  return parseRawDiff(await runGitOrThrow(args, { cwd: repoRoot }))
}

/** A blob's exact bytes. */
export function readBlob(repoRoot: string, blob: string): Promise<Buffer> {
  return runGitOrThrow(['cat-file', 'blob', blob], { cwd: repoRoot })
}

/** Git modes that are not plain files: symlinks and submodules. */
export function isSpecialMode(mode: string): boolean {
  return mode === '120000' || mode === '160000'
}

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1'

export function isLfsPointer(content: Buffer): boolean {
  return content.length < 1024 && content.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX
}

/** The paths whose `filter` attribute is `lfs`: their content is stored outside git. */
export async function lfsFilteredPaths(repoRoot: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const output = await runGitOrThrow(['check-attr', '-z', '--stdin', 'filter'], {
    cwd: repoRoot,
    input: `${paths.join('\0')}\0`,
  })
  const fields = output.toString('utf8').split('\0')
  const lfs = new Set<string>()
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === 'lfs') lfs.add(fields[i]!)
  }
  return lfs
}

/** Delete every snapshot ref under `refPrefix`. The commits become unreachable. */
export async function deleteSnapshotRefs(repoRoot: string, refPrefix: string): Promise<void> {
  const listed = await runGitOrThrow(['for-each-ref', '--format=%(refname)', refPrefix], { cwd: repoRoot })
  const refs = listed.toString('utf8').split('\n').map(line => line.trim()).filter(Boolean)
  if (refs.length === 0) return
  await runGitOrThrow(['update-ref', '--stdin'], {
    cwd: repoRoot,
    input: refs.map(ref => `delete ${ref}\n`).join(''),
  })
}
