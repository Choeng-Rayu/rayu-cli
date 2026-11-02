/**
 * The project a run works in, and its baseline.
 *
 * The baseline is taken when contract v1 is published, before any worker of the run
 * starts: every later change is measured against it. In a git repository it is a
 * snapshot commit (gitSnapshot.ts); outside git it is a scan of file sizes and
 * modification times (fileManifest.ts). Either way the run records its project root,
 * which contract paths are relative to. A project that can be tracked neither way still
 * runs: files are checked against their packets, and the result says that changes cannot
 * be compared with a baseline, rather than pretending they were.
 */
import { isAbsolute, relative } from 'path'
import { getCwd } from '../utils/cwd.js'
import { findGitRoot } from '../utils/git.js'
import { logError } from '../utils/log.js'
import { getPlanSlug, getPlansDirectory } from '../utils/plans.js'
import {
  deleteSnapshotRefs,
  snapshotRefPrefix,
  snapshotWorkingTree,
} from './gitSnapshot.js'
import { rememberManifest, scanManifest, unpinManifest } from './fileManifest.js'
import { NO_RUN_WORKSPACE, type RunWorkspace } from './runState.js'

export { NO_RUN_WORKSPACE, type RunWorkspace }

/** `path` relative to `root` when it lies inside it, else null. */
function insideRepository(root: string, path: string): string | null {
  const rel = relative(root, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
}

/** The plans directory as a snapshot exclusion, when it lies inside the repository. */
export function insidePlansExclusion(repoRoot: string): string[] {
  const inside = insideRepository(repoRoot, getPlansDirectory())
  return inside ? [inside] : []
}

/** Paths a file scan leaves out: this run's own files, and worktrees workers work in. */
export function scanExclusions(root: string): string[] {
  return [...insidePlansExclusion(root), '.rayu/worktrees']
}

/**
 * The directory contract paths are relative to: the git root, or the directory the
 * session works in when the project is not in git. Never null, so a file always has a
 * project-relative name.
 */
export function resolveProjectRoot(): string {
  return findGitRoot(getCwd()) ?? getCwd()
}

/** Whether worktree packets can be used here: they are git worktrees. */
export function canUseWorktrees(): boolean {
  return findGitRoot(getCwd()) !== null
}

/**
 * Establish the run's project root and its baseline. Returns a warning instead of
 * throwing: a run without a baseline still works, and says what it cannot do.
 */
export async function prepareRunWorkspace(runId: string): Promise<{ workspace: RunWorkspace; warning?: string }> {
  const repoRoot = findGitRoot(getCwd())
  return repoRoot ? prepareGitWorkspace(runId, repoRoot) : prepareFileWorkspace(getCwd())
}

async function prepareGitWorkspace(runId: string, repoRoot: string): Promise<{ workspace: RunWorkspace; warning?: string }> {
  const refPrefix = snapshotRefPrefix(getPlanSlug(), runId)
  // A plans directory inside the project holds this run's own files; they are not work.
  try {
    const baseline = await snapshotWorkingTree({
      repoRoot,
      refPrefix,
      label: 'baseline',
      excludePaths: insidePlansExclusion(repoRoot),
    })
    return { workspace: { repoRoot, root: repoRoot, tracking: 'git', snapshotRefPrefix: refPrefix, baseline } }
  } catch (error) {
    logError(error)
    const reason = error instanceof Error ? error.message : String(error)
    return {
      workspace: { repoRoot, root: repoRoot, tracking: 'none', snapshotRefPrefix: refPrefix, baseline: null },
      warning: `The baseline snapshot of the working tree failed (${reason}), so changes cannot be compared with a baseline. Ownership of files is still checked.`,
    }
  }
}

async function prepareFileWorkspace(root: string): Promise<{ workspace: RunWorkspace; warning?: string }> {
  const manifest = await scanManifest(root, { excludePaths: scanExclusions(root) })
  if (!manifest) {
    return {
      workspace: { ...NO_RUN_WORKSPACE, root },
      warning: `${root} is not a git repository and is too large to scan, so changes cannot be compared with a baseline. Ownership of files is still checked.`,
    }
  }
  const id = rememberManifest(manifest, true)
  return {
    workspace: { repoRoot: null, root, tracking: 'files', snapshotRefPrefix: null, baseline: { commit: id, tree: id, ref: '', takenAt: Date.now() } },
    warning: `${root} is not a git repository, so changes are tracked by file size and modification time, and worktree packets are not available.`,
  }
}

/** Delete the run's snapshot refs, or let go of its in-memory baseline. The audit history keeps the rest. */
export async function releaseRunWorkspace(workspace: RunWorkspace, lastCheckpoint?: string): Promise<void> {
  if (workspace.tracking === 'files') {
    for (const id of [workspace.baseline?.commit, lastCheckpoint]) if (id) unpinManifest(id)
    return
  }
  if (!workspace.repoRoot || !workspace.snapshotRefPrefix) return
  await deleteSnapshotRefs(workspace.repoRoot, workspace.snapshotRefPrefix)
}
