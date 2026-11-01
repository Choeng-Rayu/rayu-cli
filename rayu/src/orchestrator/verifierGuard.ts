/**
 * Launching the Orchestrator verifier inside a run, and watching what it does.
 *
 * - When: only once no packet is running or being merged, so it checks the integrated
 *   result rather than a moving target (decideVerifierSpawn).
 * - Briefing: the run's contract, packet states and open problems go at the top of its
 *   prompt, so it runs the exact required checks.
 * - Guard: the project tree is snapshotted before it starts and after it ends; any
 *   project file that changed in between, and that no worker's recorded changes
 *   explain, is raised as a `verifier-change` problem. Ignored files (build output) are
 *   not part of the tree and are not reported.
 * - Evidence: its shell commands are recorded with their outcome (toolExecution.ts), and
 *   its report is checked against them when it finishes (verification.ts).
 */
import type { Tool, ToolUseContext } from '../Tool.js'
import { VERIFIER_AGENT_TYPE } from '../tools/AgentTool/constants.js'
import type { AppState } from '../state/AppStateStore.js'
import { ShellError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'
import { join } from 'path'
import { ledgerExplains, raiseRunProblem } from './attribution.js'
import { appendAuditEvent } from './audit.js'
import { ownersOf } from './contract.js'
import { defaultCaseInsensitivePaths } from './ownership.js'
import { describeProblem } from './packetProgress.js'
import { getActiveRun, type OrchestrationRun, openProblems, workspaceRoot } from './runState.js'
import { captureTree, changedPaths } from './treeTracker.js'
import { renderContractMarkdown } from './statusReport.js'
import {
  getVerifierSession,
  noteVerifierCommand,
  openVerifierSession,
  settleVerifier,
  verificationNotice,
} from './verification.js'

type SetAppState = (update: (prev: AppState) => AppState) => void

export type VerifierSpawnDecision =
  | { kind: 'ungoverned' }
  | { kind: 'refused'; message: string }
  | { kind: 'verifier'; run: OrchestrationRun; briefing: string }

/** Whether AgentTool may launch this verifier now, and with which briefing. */
export function decideVerifierSpawn(
  agentType: string,
  context: Pick<ToolUseContext, 'agentId' | 'getAppState'>,
): VerifierSpawnDecision {
  if (agentType !== VERIFIER_AGENT_TYPE || context.agentId) return { kind: 'ungoverned' }
  const state = context.getAppState()
  if (state.toolPermissionContext.mode !== 'orchestrator') return { kind: 'ungoverned' }
  const run = getActiveRun(state)
  if (!run) return { kind: 'ungoverned' }
  const busy = run.packets.filter(packet => packet.status === 'running' || packet.status === 'merging').map(packet => packet.name)
  if (busy.length > 0) {
    return {
      kind: 'refused',
      message: `Packets ${busy.join(', ')} are still running or being merged. Launch the verifier once every worker has finished, so it checks the integrated result.`,
    }
  }
  return { kind: 'verifier', run, briefing: renderVerifierBriefing(run) }
}

/** What the verifier is told about the run, ahead of the Orchestrator's own prompt. */
export function renderVerifierBriefing(run: OrchestrationRun): string {
  const open = openProblems(run)
  const lines = [
    `# Verification brief: ${run.runId}, contract v${run.current.version}`,
    '',
    'You verify the integrated result of this Orchestrator run. Below is the contract the workers implemented. Run every required check exactly as written.',
    '',
    renderContractMarkdown(run.current).trimEnd(),
    '',
    '## Packet status',
    '',
    ...run.packets.map(packet => `- ${packet.name}: ${packet.status}`),
    '',
    ...(open.length ? ['## Open contract problems', '', ...open.map(problem => `- ${problem.id} ${describeProblem(problem)}`), ''] : []),
    "## The Orchestrator's notes",
    '',
  ]
  return `${lines.join('\n')}\n`
}

/** Snapshot the tree and open the verifier's session. Never throws. */
export async function beginVerification(agentId: string, run: OrchestrationRun): Promise<void> {
  const beforeTree = await captureTree(run.workspace)
  openVerifierSession({
    agentId,
    runId: run.runId,
    startedAt: Date.now(),
    workspace: run.workspace,
    beforeTree,
    commands: [],
    onSettled: (record, settledRun) => {
      if (!settledRun.auditDir) return
      void appendAuditEvent(settledRun.auditDir, {
        type: 'verification',
        id: record.id,
        agentId: record.agentId,
        verdict: record.verdict,
        accepted: record.accepted,
        tree: record.tree,
        checks: record.checks,
        findings: record.findings,
      }).catch(logError)
    },
  })
}

/**
 * When the verifier's run ends: compare the tree with the snapshot and raise every
 * changed file no worker explains. Idempotent; never throws.
 */
export async function sealVerification(agentId: string, host: { getAppState: () => AppState; setAppState: SetAppState }): Promise<void> {
  const session = getVerifierSession(agentId)
  if (!session || session.sealed) return
  session.sealed = { afterTree: null, changedFiles: [], workersChanged: [] }
  const run = getActiveRun(host.getAppState())
  const root = session.workspace ? workspaceRoot(session.workspace) : null
  if (!session.workspace || !root || !session.beforeTree || !run || run.runId !== session.runId) return
  try {
    const afterTree = await captureTree(session.workspace)
    const changed = afterTree ? await changedPaths(session.workspace, session.beforeTree, afterTree) : null
    if (!afterTree || !changed) return
    const byWorkers = changed.filter(path => ledgerExplains(run.runId, join(root, path), session.startedAt).length > 0)
    const byVerifier = changed.filter(path => !byWorkers.includes(path))
    session.sealed = { afterTree, changedFiles: byVerifier, workersChanged: byWorkers }
    for (const path of byVerifier) {
      raiseRunProblem(host, run, {
        kind: 'verifier-change',
        path,
        packet: null,
        agentId,
        owners: ownersOf(run.current.contract, path, defaultCaseInsensitivePaths()),
        tool: 'verifier',
        at: Date.now(),
      })
    }
  } catch (error) {
    logError(error)
  }
}

/** Record a verifier's finished shell command (toolExecution.ts). Never throws. */
export function recordVerifierShellCall(
  tool: Pick<Tool, 'name'>,
  input: unknown,
  outcome: { error?: unknown; interrupted?: boolean; backgrounded?: boolean },
  agentId: string | undefined,
): void {
  if (!agentId || !SHELL_TOOL_NAMES.includes(tool.name) || !getVerifierSession(agentId)) return
  const command = (input as { command?: unknown } | null)?.command
  if (typeof command !== 'string') return
  const failed = outcome.error !== undefined || outcome.interrupted === true || outcome.backgrounded === true
  const exitCode = outcome.error instanceof ShellError ? outcome.error.code : outcome.error === undefined && !failed ? 0 : null
  noteVerifierCommand(agentId, { command, ok: !failed, exitCode })
}

/**
 * Settle a foreground verifier when its Agent call ends, and add its verification
 * summary to the result the Orchestrator reads.
 */
export async function settleForegroundVerifier<T extends { data: unknown }>(
  run: Promise<T>,
  agentId: string,
  host: { getAppState: () => AppState; setAppState: SetAppState },
): Promise<T> {
  let result: T
  try {
    result = await run
  } catch (error) {
    settleVerifier(agentId, '', error instanceof Error && error.name === 'AbortError' ? 'killed' : 'failed', host.setAppState)
    throw error
  }
  const data = result.data as { status?: unknown; content?: unknown } | null
  if (data?.status === 'async_launched') return result
  const blocks = Array.isArray(data?.content) ? (data.content as Array<{ type?: string; text?: string }>) : []
  settleVerifier(agentId, blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'), 'completed', host.setAppState)
  const notice = verificationNotice(host.getAppState(), agentId)
  if (!notice || !data || !Array.isArray(data.content)) return result
  return { ...result, data: { ...data, content: [...data.content, { type: 'text', text: notice }] } }
}
