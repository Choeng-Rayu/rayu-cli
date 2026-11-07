/**
 * What the Orchestrator reminder needs to know about the session, and the end of a run
 * when the session leaves Orchestrator mode. Used by the per-turn attachment
 * (utils/attachments.ts) and by the re-attachment after compaction
 * (services/compact/compact.ts), so both describe the session the same way.
 */
import { toolMatchesName, type ToolUseContext } from '../Tool.js'
import { ORCHESTRATION_CONTRACT_TOOL_NAME } from '../tools/OrchestrationContractTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { logError } from '../utils/log.js'
import { recordRunArchived } from './audit.js'
import { forgetRunLedger } from './attribution.js'
import { forgetRunCommands } from './shellChanges.js'
import type { OrchestratorReminderKind } from './reminder.js'
import { archiveRun, getActiveRun, workspaceRoot, workspaceTracking } from './runState.js'
import { canUseWorktrees, releaseRunWorkspace, resolveProjectRoot } from './runWorkspace.js'

type SessionContext = Pick<ToolUseContext, 'getAppState'> & {
  options: Pick<ToolUseContext['options'], 'tools' | 'agentDefinitions'>
}

/** The `orchestrator_mode` attachment's fields; also a valid OrchestratorReminderInfo. */
export type OrchestratorSessionInfo = {
  reminderType: OrchestratorReminderKind
  availableAgents: string[]
  canMessageWorkers: boolean
  hasContractTool: boolean
  projectRoot: string
  /** False outside git: worktree packets and reliable change tracking are unavailable. */
  projectIsGit: boolean
  contract?: { runId: string; version: number }
}

export function describeOrchestratorSession(
  context: SessionContext,
  reminderType: OrchestratorReminderKind,
): OrchestratorSessionInfo {
  const has = (name: string) => context.options.tools.some(tool => toolMatchesName(tool, name))
  const run = getActiveRun(context.getAppState())
  return {
    reminderType,
    availableAgents: context.options.agentDefinitions.activeAgents.map(agent => agent.agentType),
    canMessageWorkers: has(SEND_MESSAGE_TOOL_NAME),
    hasContractTool: has(ORCHESTRATION_CONTRACT_TOOL_NAME),
    projectRoot: (run && workspaceRoot(run.workspace)) || resolveProjectRoot(),
    projectIsGit: run ? workspaceTracking(run.workspace) === 'git' : canUseWorktrees(),
    ...(run ? { contract: { runId: run.runId, version: run.current.version } } : {}),
  }
}

/**
 * End the active run, if there is one. Called when the exit notice is attached: the
 * contract no longer binds anyone, and the next contract starts a new run. Its audit
 * history stays on disk.
 */
export function archiveActiveRun(
  context: Pick<ToolUseContext, 'getAppState' | 'setAppState'>,
  now: number = Date.now(),
): void {
  const active = getActiveRun(context.getAppState())
  if (!active) return
  const archived = archiveRun(active, now)
  context.setAppState(prev =>
    prev.orchestration.run?.runId === active.runId && prev.orchestration.run.status === 'active'
      ? { ...prev, orchestration: { ...prev.orchestration, run: archiveRun(prev.orchestration.run, now) } }
      : prev,
  )
  void recordRunArchived(archived)
    .then(() => releaseRunWorkspace(archived.workspace, archived.lastCheckpoint?.commit))
    .catch(logError)
  forgetRunLedger(archived.runId)
  forgetRunCommands(archived.runId)
}
