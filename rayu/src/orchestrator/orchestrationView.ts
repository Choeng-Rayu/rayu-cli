/**
 * The Orchestrator run as task panels show it: for each worker or verifier, the packet
 * it serves (or its verdict), the problems raised for it, its worktree, and a summary
 * of the whole run. Rayucode receives it with each task and as a `task_orchestration`
 * frame whenever it changes; the CLI's background-task dialog reads the same view.
 *
 * Pure, with type-only imports, so the AppState change hook can publish it.
 */
import type { RuntimeTaskOrchestration } from '../protocol/index.js'
import { describeProblem } from './packetProgress.js'
import { type OrchestrationRun, openProblems } from './runState.js'

type RunSummary = RuntimeTaskOrchestration['run']

export function runSummary(run: OrchestrationRun): RunSummary {
  const latest = run.verifications?.at(-1)
  return {
    status: run.status,
    goal: run.current.contract.goal,
    packets: run.packets.map(packet => ({
      name: packet.name,
      status: packet.status,
      ...(packet.workerAgentIds.at(-1) ? { worker: packet.workerAgentIds.at(-1) } : {}),
    })),
    openProblems: openProblems(run).length,
    gate: run.gate ? 'closed' : latest?.accepted ? 'open' : 'pending',
    ...(latest ? { verification: { id: latest.id, verdict: latest.verdict, accepted: latest.accepted } } : {}),
  }
}

function workerView(run: OrchestrationRun, agentId: string): RuntimeTaskOrchestration | null {
  const packet = run.packets.find(item => item.workerAgentIds.includes(agentId))
  if (!packet) return null
  const current = packet.workerAgentIds.at(-1) === agentId
  const worktree = current ? packet.worktree : undefined
  return {
    runId: run.runId,
    contractVersion: run.current.version,
    role: 'worker',
    packet: packet.name,
    packetStatus: packet.status,
    current,
    problems: (run.problems ?? [])
      .filter(problem => problem.status === 'open' && problem.packet === packet.name)
      .map(problem => ({ id: problem.id, kind: problem.kind, path: problem.path, summary: describeProblem(problem) })),
    ...(worktree
      ? {
          worktree: {
            path: worktree.path,
            state: worktree.state,
            failedAttempts: worktree.failedAttempts,
            conflicts: worktree.conflicts.map(conflict => ({ path: conflict.path, reason: conflict.reason })),
            ...(worktree.mergedFiles !== undefined ? { mergedFiles: worktree.mergedFiles } : {}),
          },
        }
      : {}),
    run: runSummary(run),
  }
}

function verifierView(run: OrchestrationRun, agentId: string): RuntimeTaskOrchestration | null {
  const record = run.verifications?.findLast(item => item.agentId === agentId)
  if (!record) return null
  return {
    runId: run.runId,
    contractVersion: record.contractVersion,
    role: 'verifier',
    current: run.verifications?.at(-1)?.agentId === agentId,
    problems: (run.problems ?? [])
      .filter(problem => problem.status === 'open' && problem.kind === 'verifier-change' && problem.agentId === agentId)
      .map(problem => ({ id: problem.id, kind: problem.kind, path: problem.path, summary: describeProblem(problem) })),
    verification: { id: record.id, verdict: record.verdict, accepted: record.accepted, findings: [...record.findings] },
    run: runSummary(run),
  }
}

/** The view for one agent of `run`, or null when it is neither a worker nor a verifier of it. */
export function agentOrchestrationView(run: OrchestrationRun | null, agentId: string): RuntimeTaskOrchestration | null {
  if (!run) return null
  return workerView(run, agentId) ?? verifierView(run, agentId)
}

/** Every agent `run` has a view for. */
export function orchestrationAgentIds(run: OrchestrationRun | null): string[] {
  if (!run) return []
  const ids = [...run.packets.flatMap(packet => packet.workerAgentIds), ...(run.verifications ?? []).map(record => record.agentId)]
  return [...new Set(ids)]
}

/**
 * The views that differ between two states of the run, to publish. A replaced run
 * (a new run id) republishes everything for the new one.
 */
export function changedOrchestrationViews(
  previous: OrchestrationRun | null,
  next: OrchestrationRun | null,
): Array<{ agentId: string; view: RuntimeTaskOrchestration }> {
  if (previous === next || !next) return []
  const comparable = previous?.runId === next.runId ? previous : null
  return orchestrationAgentIds(next).flatMap(agentId => {
    const view = agentOrchestrationView(next, agentId)
    if (!view) return []
    const before = agentOrchestrationView(comparable, agentId)
    return before && JSON.stringify(before) === JSON.stringify(view) ? [] : [{ agentId, view }]
  })
}
