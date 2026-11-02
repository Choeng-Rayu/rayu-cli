/**
 * Check what each Orchestrator worker writes against its packet.
 *
 * Called after every successful Edit, Write and NotebookEdit (toolExecution.ts). A change by a
 * worker of the active run is:
 *   - owned: inside its packet's files. Fine, unless a packet that can run at the same
 *     time also changed the file: then it is an `overlap`.
 *   - `outside-packet`: in a file another packet owns.
 *   - `unowned`: in a file no packet owns, or outside the repository.
 * Problems are recorded on the run (and in its audit history with the diff), the worker
 * is told in its tool result what to do, and the Orchestrator sees them in the worker's
 * completion notice and /orchestrator-status. They stay open until the worker undoes
 * the change, a new contract version gives the file to the packet, or the user accepts
 * them; nothing is silently allowed. Changes are reported, not blocked: the write has
 * already happened, and the worker is the one best placed to undo it.
 *
 * Changes inside the session's plans directory, agent worktrees seen from the main tree,
 * and the system temp directory are not project work and are not checked.
 */
import { tmpdir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'
import type { ToolUseContext } from '../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { type AgentChangeLedger, createAgentChangeLedger } from '../utils/agentChangeLedger.js'
import { getCwd } from '../utils/cwd.js'
import { findGitRoot } from '../utils/git.js'
import { logError } from '../utils/log.js'
import { expandPath } from '../utils/path.js'
import { getPlansDirectory } from '../utils/plans.js'
import { appendAuditEvent, writeProblemDiff } from './audit.js'
import { canRunTogether, type OrchestrationContract, ownersOf } from './contract.js'
import { defaultCaseInsensitivePaths, normalizeRelativePath, ownsPath } from './ownership.js'
import { packetOfWorker } from './packetProgress.js'
import { type OrchestrationProblem, type OrchestrationRun, updateActiveRun, withProblem, workspaceRoot } from './runState.js'

const ATTRIBUTED_TOOLS: ReadonlySet<string> = new Set([FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME])

/** One ledger per run: which packet changed which file, for overlap detection. */
const ledgers = new Map<string, AgentChangeLedger>()

function ledgerFor(runId: string): AgentChangeLedger {
  let ledger = ledgers.get(runId)
  if (!ledger) {
    ledger = createAgentChangeLedger({ caseInsensitivePaths: defaultCaseInsensitivePaths() })
    ledgers.set(runId, ledger)
  }
  return ledger
}

/** Forget a run's ledger, when the run ends. */
export function forgetRunLedger(runId: string): void {
  ledgers.delete(runId)
}

/** The file a tool call changed, as an absolute path, or null for other tools. */
export function changedFileOf(toolName: string, input: Record<string, unknown>): string | null {
  if (!ATTRIBUTED_TOOLS.has(toolName)) return null
  const raw = toolName === NOTEBOOK_EDIT_TOOL_NAME ? input.notebook_path : input.file_path
  return typeof raw === 'string' && raw ? expandPath(raw) : null
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Paths that are not project work: plans and audit files, agent worktrees seen from the
 * main tree, and scratch files in the system temp directory outside the repository (a
 * project can itself live under the temp directory).
 */
function isExempt(path: string, root: string): boolean {
  if (isInside(getPlansDirectory(), path)) return true
  if (isInside(join(root, '.rayu', 'worktrees'), path)) return true
  return !isInside(root, path) && isInside(resolve(tmpdir()), path)
}

export type ChangeVerdict =
  | { kind: 'owned' }
  | { kind: 'problem'; problem: Omit<OrchestrationProblem, 'id' | 'status' | 'diffFile'> }

type ClassifyInput = {
  contract: OrchestrationContract
  packet: string
  agentId: string
  /** Repository-relative, or null when the file is outside the repository. */
  relativePath: string | null
  absolutePath: string
  /** Other packets that changed the same file in this run. */
  otherWriters: readonly string[]
  tool: string
  now: number
  caseInsensitive: boolean
}

/** Pure: how a single change fits the contract. */
export function classifyChange(input: ClassifyInput): ChangeVerdict {
  const base = { packet: input.packet, agentId: input.agentId, tool: input.tool, at: input.now }
  if (input.relativePath === null) {
    return { kind: 'problem', problem: { ...base, kind: 'unowned', path: input.absolutePath, owners: [] } }
  }
  const owners = ownersOf(input.contract, input.relativePath, input.caseInsensitive)
  const concurrent = input.otherWriters.filter(other => canRunTogether(input.contract, input.packet, other))
  const withOthers = concurrent.length ? { with: concurrent } : {}
  if (owners.includes(input.packet)) {
    if (concurrent.length === 0) return { kind: 'owned' }
    return { kind: 'problem', problem: { ...base, kind: 'overlap', path: input.relativePath, owners, with: concurrent } }
  }
  const kind = owners.length > 0 ? 'outside-packet' : 'unowned'
  return { kind: 'problem', problem: { ...base, kind, path: input.relativePath, owners, ...withOthers } }
}

/** What the worker is told in its tool result. */
export function workerWarning(problem: Omit<OrchestrationProblem, 'id' | 'status'>, packetOwns: readonly string[]): string {
  const yours = packetOwns.map(pattern => `\`${pattern}\``).join(', ')
  const undo = 'Undo this change (restore the file as it was) and describe the change you need under "Open issues" in your final report, unless the Orchestrator has told you the contract gives you this file.'
  switch (problem.kind) {
    case 'outside-packet':
      return `Contract check: ${problem.path} belongs to packet ${problem.owners.join(', ')}, not to your packet "${problem.packet}" (${yours}). ${undo}`
    case 'unowned':
      return `Contract check: ${problem.path} is not part of any packet in the contract; your packet "${problem.packet}" owns ${yours}. ${undo}`
    case 'overlap':
      return `Contract check: packet ${problem.with?.join(', ')} also changed ${problem.path}, which your packet owns, while it could run at the same time as yours. Read the file again before editing it further, and mention this under "Open issues" in your final report.`
    case 'untraced':
    case 'interrupted':
    case 'merge-conflict':
    case 'verifier-change':
      return `Contract check: ${problem.path} changed outside what the contract expects. Mention it under "Open issues" in your final report.`
  }
}

export type AttributionContext = Pick<ToolUseContext, 'agentId' | 'getAppState' | 'setAppState' | 'setAppStateForTasks'>

/**
 * The directory a worker's paths are relative to: its own worktree for a worktree
 * packet, else the run's project root. Taken from the run and the packet, not from
 * the worker's shell directory: a worker that ran `cd other-repo` must not make
 * `other-repo/` the root and every path it writes "outside" its packet.
 */
export function workerProjectRoot(run: OrchestrationRun, packetName?: string): string {
  const worktree = packetName ? run.packets.find(item => item.name === packetName)?.worktree : undefined
  if (worktree?.state === 'open') return worktree.path
  return workspaceRoot(run.workspace) ?? findGitRoot(getCwd()) ?? getCwd()
}

/**
 * Check a completed file change. Returns the warning for the worker's tool result, or
 * null when the change is fine or is not a worker's.
 */
export function attributeFileChange(
  toolName: string,
  input: Record<string, unknown>,
  resultData: unknown,
  context: AttributionContext,
): string | null {
  if (!context.agentId) return null
  const absolutePath = changedFileOf(toolName, input)
  if (!absolutePath) return null
  const found = packetOfWorker(context.getAppState(), context.agentId)
  if (!found) return null
  const warning = attributePath({ ...found, context, absolutePath, toolName, resultData, otherWritersOverride: null })
  return warning
}

type PathAttribution = {
  run: OrchestrationRun
  packet: { name: string }
  context: AttributionContext
  absolutePath: string
  toolName: string
  resultData: unknown
  /** Packets that may also have changed the file (shell commands at the same time); null to use the ledger. */
  otherWritersOverride: readonly string[] | null
}

/** Classify and record one changed path of a worker. Returns its warning, or null. */
export function attributePath(input: PathAttribution): string | null {
  const { run, packet, context, absolutePath, toolName } = input
  const root = workerProjectRoot(run, packet.name)
  if (isExempt(absolutePath, root)) return null
  const caseInsensitive = defaultCaseInsensitivePaths()
  const relativePath = isInside(root, absolutePath) ? normalizeRelativePath(relative(root, absolutePath)) : null
  const otherWriters = recordAndFindOtherWriters(run.runId, packet.name, absolutePath, root, caseInsensitive)
  const verdict = classifyChange({
    contract: run.current.contract,
    packet: packet.name,
    agentId: context.agentId ?? '',
    relativePath,
    absolutePath,
    otherWriters: input.otherWritersOverride ?? otherWriters,
    tool: toolName,
    now: Date.now(),
    caseInsensitive,
  })
  if (verdict.kind === 'owned') return null
  const added = recordProblem(context, run.runId, verdict.problem)
  if (added) void auditProblem(context, run, added, input.resultData)
  const owns = run.current.contract.packets.find(item => item.name === packet.name)?.owns ?? []
  return workerWarning(verdict.problem, owns)
}

/** Whether a packet's worker changed `absolutePath` in this run (by file tools or commands). */
export function ledgerExplains(runId: string, absolutePath: string, since = 0): string[] {
  const ledger = ledgers.get(runId)
  if (!ledger) return []
  const caseInsensitive = defaultCaseInsensitivePaths()
  const same = (path: string) => (caseInsensitive ? path.toLowerCase() === absolutePath.toLowerCase() : path === absolutePath)
  return ledger
    .listSummaries()
    .filter(summary => summary.files.some(file => same(file.path) && file.lastSeenMs >= since))
    .map(summary => summary.agentId)
}

/** Packets with recorded changes, and how many files each changed. */
export function ledgerFileCounts(runId: string): Map<string, number> {
  const ledger = ledgers.get(runId)
  return new Map((ledger?.listSummaries() ?? []).map(summary => [summary.agentId, summary.files.length]))
}

/**
 * Record files a worktree packet's merge changed in the main tree, so checkpoints count
 * them as that packet's work. Its worker's own edits were checked in its worktree.
 */
export function recordMergedFiles(runId: string, packet: string, absolutePaths: readonly string[], repoRoot: string): void {
  const ledger = ledgerFor(runId)
  const at = Date.now()
  for (const path of absolutePaths) ledger.record({ agentId: packet, path, change: 'modified', at }, repoRoot)
}

/** Record a problem that no single tool call raised (checkpoints). Returns it if new. */
export function raiseRunProblem(
  context: AttributionContext,
  run: OrchestrationRun,
  problem: Omit<OrchestrationProblem, 'id' | 'status'>,
): OrchestrationProblem | null {
  const added = recordProblem(context, run.runId, problem)
  if (added) void auditProblem(context, run, added, null)
  return added
}

/** Record the change in the run's ledger; return the other packets that changed the file. */
function recordAndFindOtherWriters(
  runId: string,
  packet: string,
  absolutePath: string,
  root: string,
  caseInsensitive: boolean,
): string[] {
  const ledger = ledgerFor(runId)
  ledger.record({ agentId: packet, path: absolutePath, change: 'modified', at: Date.now() }, root)
  const same = (path: string) => (caseInsensitive ? path.toLowerCase() === absolutePath.toLowerCase() : path === absolutePath)
  return ledger
    .findConflictsForAgent(packet)
    .filter(conflict => same(conflict.path))
    .flatMap(conflict => conflict.agents.map(agent => agent.agentId))
    .filter(name => name !== packet)
}

function updateRun(
  context: AttributionContext,
  runId: string,
  update: (run: OrchestrationRun) => OrchestrationRun,
): void {
  updateActiveRun(context.setAppStateForTasks ?? context.setAppState, runId, update)
}

function recordProblem(
  context: AttributionContext,
  runId: string,
  problem: Omit<OrchestrationProblem, 'id' | 'status'>,
): OrchestrationProblem | null {
  const recorded: { problem: OrchestrationProblem | null } = { problem: null }
  updateRun(context, runId, run => {
    const next = withProblem(run, problem)
    recorded.problem = next.added
    return next.run
  })
  return recorded.problem
}

async function auditProblem(
  context: AttributionContext,
  run: OrchestrationRun,
  problem: OrchestrationProblem,
  resultData: unknown,
): Promise<void> {
  if (!run.auditDir) return
  try {
    const diffFile = await writeProblemDiff(run.auditDir, problem, resultData)
    await appendAuditEvent(run.auditDir, {
      type: 'contract_problem',
      id: problem.id,
      kind: problem.kind,
      path: problem.path,
      packet: problem.packet,
      agentId: problem.agentId,
      owners: problem.owners,
      tool: problem.tool,
      ...(diffFile ? { diffFile } : {}),
    })
    if (diffFile) {
      updateRun(context, run.runId, current => ({
        ...current,
        problems: current.problems.map(item => (item.id === problem.id ? { ...item, diffFile } : item)),
      }))
    }
  } catch (error) {
    logError(error)
  }
}

type ToolResultBlockLike = { content?: unknown }

/** The tool result with `text` added after its content; unchanged when `text` is null. */
export function appendToToolResult<T extends ToolResultBlockLike>(block: T, text: string | null): T {
  if (!text) return block
  const content = block.content
  if (typeof content === 'string') return { ...block, content: `${content}\n\n${text}` }
  if (Array.isArray(content)) return { ...block, content: [...content, { type: 'text', text }] }
  return { ...block, content: text }
}

/** Open problems that the run's current contract has settled: the packet now owns the file. */
export function settleProblemsByContract(run: OrchestrationRun): { run: OrchestrationRun; closed: OrchestrationProblem[] } {
  const caseInsensitive = defaultCaseInsensitivePaths()
  const closed: OrchestrationProblem[] = []
  const problems = (run.problems ?? []).map(problem => {
    // Ownership cannot settle an overlap or a failed merge: the files still disagree.
    if (problem.status !== 'open' || problem.kind === 'overlap' || problem.kind === 'merge-conflict' || !problem.packet) return problem
    const packet = run.current.contract.packets.find(item => item.name === problem.packet)
    if (!packet || !ownsPath(packet.owns, problem.path, caseInsensitive)) return problem
    const settled: OrchestrationProblem = {
      ...problem,
      status: 'resolved',
      resolution: `Contract v${run.current.version} gives ${problem.path} to packet ${problem.packet}.`,
    }
    closed.push(settled)
    return settled
  })
  return closed.length ? { run: { ...run, problems }, closed } : { run, closed }
}

/** The run with problem `id` accepted by the user, or an explanation why it cannot be. */
export function acceptProblem(run: OrchestrationRun, id: string, note: string): { run: OrchestrationRun; problem: OrchestrationProblem } | string {
  const problem = (run.problems ?? []).find(item => item.id === id)
  if (!problem) return `${run.runId} has no problem ${id}.`
  if (problem.status !== 'open') return `Problem ${id} is already ${problem.status}.`
  const accepted: OrchestrationProblem = { ...problem, status: 'accepted', resolution: `Accepted by the user${note ? `: ${note}` : ''}.` }
  return { run: { ...run, problems: run.problems.map(item => (item.id === id ? accepted : item)) }, problem: accepted }
}

/** Record closed problems in the audit history. */
export async function auditClosedProblems(run: OrchestrationRun, closed: readonly OrchestrationProblem[]): Promise<void> {
  if (!run.auditDir) return
  for (const problem of closed) {
    if (problem.status === 'open') continue
    await appendAuditEvent(run.auditDir, {
      type: 'problem_closed',
      id: problem.id,
      status: problem.status,
      resolution: problem.resolution ?? '',
    })
  }
}
