/**
 * Audit history of Orchestrator runs, on disk.
 *
 *   {plansDir}/{planSlug}-orchestration/run-<n>/
 *     run.json            the run as last recorded (rewritten atomically)
 *     events.jsonl        one line per event: contract versions, archiving, and in
 *                         later tasks worker starts, ownership problems, merges and
 *                         verification attempts
 *     contract-v<N>.json  each published contract version
 *     contract-v<N>.md    the same, as workers read it
 *
 * Directories are created 0700 and files 0600: contracts and diffs can contain
 * project code. The plans directory is outside the project by default
 * (~/.rayu/plans), so this history does not show up in the user's working tree.
 * On Windows the modes are not applied; the user's profile directory protects it.
 */
import { appendFile, mkdir, readdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getPlanSlug, getPlansDirectory } from '../utils/plans.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { ContractVersion, OrchestrationRun } from './runState.js'
import { renderContractMarkdown } from './statusReport.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const RUN_DIR = /^run-(\d+)$/
const MAX_ALLOCATION_ATTEMPTS = 5

export type AuditEvent =
  | { type: 'run_started'; runId: string }
  | { type: 'snapshot_taken'; label: string; commit: string; ref: string }
  | { type: 'contract_published'; version: number; packets: readonly string[]; reason?: string }
  | {
      type: 'contract_problem'
      id: string
      kind: string
      path: string
      packet: string | null
      agentId: string | null
      owners: readonly string[]
      tool: string
      diffFile?: string
    }
  | { type: 'problem_closed'; id: string; status: 'resolved' | 'accepted'; resolution: string }
  | { type: 'checkpoint'; label: string; commit: string; changed: number; raised: readonly string[] }
  | {
      type: 'worktree_merge'
      packet: string
      agentId: string
      attempt: number
      outcome: 'merged' | 'conflict' | 'error'
      base: string
      workerTree?: string
      mainTree?: string
      files: readonly string[]
      conflicts: readonly { path: string; reason: string }[]
      syncedBase?: string
      error?: string
    }
  | {
      type: 'verification'
      id: string
      agentId: string
      verdict: string | null
      accepted: boolean
      tree: string | null
      checks: readonly { name: string; command: string; status: string }[]
      findings: readonly string[]
    }
  | { type: 'gate'; action: 'open' | 'nudge' | 'final' | 'report'; reasons: readonly string[] }
  | { type: 'run_archived'; runId: string }

/** This session's audit directory; one subdirectory per run. */
export function orchestrationAuditRoot(): string {
  return join(getPlansDirectory(), `${getPlanSlug()}-orchestration`)
}

/** Create the next `run-<n>` directory. Numbers continue across resumed sessions. */
export async function createRunDirectory(
  root: string = orchestrationAuditRoot(),
): Promise<{ runId: string; dir: string }> {
  await mkdir(root, { recursive: true, mode: DIR_MODE })
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const runId = `run-${(await highestRunNumber(root)) + 1}`
    const dir = join(root, runId)
    try {
      await mkdir(dir, { mode: DIR_MODE })
      return { runId, dir }
    } catch (error) {
      // Another process took this number between the scan and the mkdir.
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Could not create a run directory in ${root}`)
}

async function highestRunNumber(root: string): Promise<number> {
  const entries = await readdir(root).catch(() => [] as string[])
  return entries.reduce((max, entry) => {
    const match = RUN_DIR.exec(entry)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
}

/** Write a file in full, so a crash never leaves it half-written. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, { encoding: 'utf8', mode: FILE_MODE })
  await rename(temporary, path)
}

export async function writeRunSnapshot(dir: string, run: OrchestrationRun): Promise<void> {
  await writeAtomically(join(dir, 'run.json'), jsonStringify(run, null, 2))
}

export async function writeContractVersion(dir: string, version: ContractVersion): Promise<void> {
  const base = join(dir, `contract-v${version.version}`)
  await writeAtomically(`${base}.json`, jsonStringify(version, null, 2))
  await writeAtomically(`${base}.md`, renderContractMarkdown(version))
}

export async function appendAuditEvent(dir: string, event: AuditEvent): Promise<void> {
  const line = jsonStringify({ at: new Date().toISOString(), ...event })
  await appendFile(join(dir, 'events.jsonl'), `${line}\n`, { encoding: 'utf8', mode: FILE_MODE })
}

type PatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: readonly string[] }

function isPatchHunk(value: unknown): value is PatchHunk {
  const hunk = value as Partial<PatchHunk> | null
  return typeof hunk?.oldStart === 'number' && typeof hunk.newStart === 'number' && Array.isArray(hunk.lines)
}

/** A unified diff from the structured patch the file tools return. */
export function renderPatch(path: string, hunks: readonly PatchHunk[]): string {
  const lines = [`--- a/${path}`, `+++ b/${path}`]
  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Save the change behind a contract problem as `diffs/<id>-<packet>.patch`. Returns the
 * file name relative to the run directory, or null when the tool reported no patch.
 */
export async function writeProblemDiff(
  dir: string,
  problem: { id: string; packet: string | null; path: string },
  resultData: unknown,
): Promise<string | null> {
  const hunks = (resultData as { structuredPatch?: unknown } | null)?.structuredPatch
  if (!Array.isArray(hunks) || hunks.length === 0 || !hunks.every(isPatchHunk)) return null
  await mkdir(join(dir, 'diffs'), { recursive: true, mode: DIR_MODE })
  const name = `diffs/${problem.id}-${(problem.packet ?? 'unknown').replace(/[^a-z0-9-]/gi, '-')}.patch`
  await writeAtomically(join(dir, name), renderPatch(problem.path, hunks))
  return name
}

/**
 * Record a newly published contract version. Returns the problems instead of throwing:
 * the contract still applies when its history cannot be written, and the caller says so.
 */
export async function recordContractVersion(run: OrchestrationRun, isNewRun: boolean): Promise<string[]> {
  if (!run.auditDir) return ['The audit directory could not be created, so this run has no history on disk.']
  const dir = run.auditDir
  const baseline = run.workspace.baseline
  const steps: Array<() => Promise<void>> = [
    ...(isNewRun ? [() => appendAuditEvent(dir, { type: 'run_started', runId: run.runId })] : []),
    ...(isNewRun && baseline
      ? [() => appendAuditEvent(dir, { type: 'snapshot_taken', label: 'baseline', commit: baseline.commit, ref: baseline.ref })]
      : []),
    () => writeContractVersion(dir, run.current),
    () =>
      appendAuditEvent(dir, {
        type: 'contract_published',
        version: run.current.version,
        packets: run.current.contract.packets.map(packet => packet.name),
        ...(run.current.reason ? { reason: run.current.reason } : {}),
      }),
    () => writeRunSnapshot(dir, run),
  ]
  const problems: string[] = []
  for (const step of steps) {
    await step().catch(error => problems.push(`Audit history: ${error instanceof Error ? error.message : String(error)}`))
  }
  return problems
}

/** Record that a run ended. Failures are returned for logging; nothing is waiting on them. */
export async function recordRunArchived(run: OrchestrationRun): Promise<void> {
  if (!run.auditDir) return
  await appendAuditEvent(run.auditDir, { type: 'run_archived', runId: run.runId })
  await writeRunSnapshot(run.auditDir, run)
}
