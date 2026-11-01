/**
 * "What does the project look like now, and what changed since?", for either way a run
 * can answer it: git snapshots (gitSnapshot.ts) or, outside git, file manifests
 * (fileManifest.ts). Checkpoints, the verifier's before/after comparison and the gate
 * ask this module, so none of them cares whether the project is in a repository.
 *
 * A tree id is opaque: a git tree hash, or `files:<hash>`. Two ids are equal when the
 * project was in the same state. Every function returns null when the question cannot be
 * answered (no tracking, a scan that was too large, a failed git call), never throws, and
 * the callers treat null as "unknown", not as "unchanged".
 */
import { logError } from '../utils/log.js'
import { diffManifests, recallManifest, rememberManifest, scanManifest } from './fileManifest.js'
import { diffTrees, snapshotWorkingTree, type WorkingTreeSnapshot, workingTreeTree } from './gitSnapshot.js'
import { type RunWorkspace, workspaceRoot, workspaceTracking } from './runState.js'
import { insidePlansExclusion, scanExclusions } from './runWorkspace.js'

/** The state of the project right now, or null when it cannot be taken. */
export async function captureTree(workspace: RunWorkspace): Promise<string | null> {
  const root = workspaceRoot(workspace)
  const tracking = workspaceTracking(workspace)
  if (!root || tracking === 'none') return null
  try {
    if (tracking === 'git') return await workingTreeTree(workspace.repoRoot ?? root, insidePlansExclusion(workspace.repoRoot ?? root))
    const manifest = await scanManifest(root, { excludePaths: scanExclusions(root) })
    return manifest ? rememberManifest(manifest) : null
  } catch (error) {
    logError(error)
    return null
  }
}

/**
 * Take a named snapshot of the project. Git snapshots are commits kept under a private
 * ref; file manifests are held in memory and the id stands in for the commit.
 */
export async function snapshotTree(workspace: RunWorkspace, label: string, pin = false): Promise<WorkingTreeSnapshot | null> {
  const root = workspaceRoot(workspace)
  const tracking = workspaceTracking(workspace)
  if (!root || tracking === 'none') return null
  try {
    if (tracking === 'git') {
      if (!workspace.repoRoot || !workspace.snapshotRefPrefix) return null
      return await snapshotWorkingTree({
        repoRoot: workspace.repoRoot,
        refPrefix: workspace.snapshotRefPrefix,
        label,
        excludePaths: insidePlansExclusion(workspace.repoRoot),
      })
    }
    const manifest = await scanManifest(root, { excludePaths: scanExclusions(root) })
    if (!manifest) return null
    const id = rememberManifest(manifest, pin)
    return { commit: id, tree: id, ref: '', takenAt: Date.now() }
  } catch (error) {
    logError(error)
    return null
  }
}

/** Project-relative paths that differ between two tree ids (or snapshot commits), or null. */
export async function changedPaths(workspace: RunWorkspace, from: string, to: string): Promise<string[] | null> {
  const tracking = workspaceTracking(workspace)
  try {
    if (tracking === 'git') {
      const repoRoot = workspace.repoRoot ?? workspaceRoot(workspace)
      return repoRoot ? (await diffTrees(repoRoot, from, to)).map(change => change.path) : null
    }
    if (tracking === 'files') {
      const before = recallManifest(from)
      const after = recallManifest(to)
      return before && after ? diffManifests(before, after) : null
    }
    return null
  } catch (error) {
    logError(error)
    return null
  }
}

