/**
 * OrchestrationContract: the Orchestrator publishes, amends and re-reads the contract
 * its workers follow (src/orchestrator/contract.ts).
 *
 * Offered to the main thread in Orchestrator mode only (getTools in src/tools.ts) and
 * never to subagents (ALL_AGENT_DISALLOWED_TOOLS). It changes session state and writes
 * the run's audit history outside the project; it never touches project files.
 */
import { z } from 'zod/v4'
import {
  createRunDirectory,
  recordContractVersion,
} from '../../orchestrator/audit.js'
import {
  type ContractValidation,
  contractSchema,
  unneededDependencies,
  validateContract,
} from '../../orchestrator/contract.js'
import { defaultCaseInsensitivePaths } from '../../orchestrator/ownership.js'
import {
  amendmentProblem,
  amendRun,
  getActiveRun,
  openProblems,
  type OrchestrationProblem,
  type OrchestrationRun,
  type PublishedContract,
  type RunWorkspace,
  startRun,
  workspaceRoot,
  workspaceTracking,
} from '../../orchestrator/runState.js'
import { canUseWorktrees, prepareRunWorkspace, resolveProjectRoot } from '../../orchestrator/runWorkspace.js'
import { getOrchestratorSettings } from '../../orchestrator/settings.js'
import { renderContractMarkdown } from '../../orchestrator/statusReport.js'
import { auditClosedProblems, settleProblemsByContract } from '../../orchestrator/attribution.js'
import { describeProblem, recordWorkerBriefed } from '../../orchestrator/packetProgress.js'
import { staleRunningWorkers } from '../../orchestrator/workerBriefing.js'
import { queuePendingMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from '../../state/AppStateStore.js'
import { buildTool, type Tool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { ORCHESTRATION_CONTRACT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getOrchestrationContractPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['publish', 'show'])
      .describe('"publish" a new contract version, or "show" the current one'),
    contract: contractSchema()
      .optional()
      .describe('The whole contract. Required to publish.'),
    reason: z
      .string()
      .optional()
      .describe('When publishing a new version: what changed and why'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export type OrchestrationContractOutput =
  | {
      action: 'publish'
      runId: string
      version: number
      newRun: boolean
      waves: string[][]
      requiredChecks: Array<{ name: string; command: string }>
      auditDir: string | null
      /** Packets whose running worker was sent this version. */
      updatedWorkers: string[]
      /** Problems this version settled. */
      resolvedProblems: string[]
      /** Problems still open after it. */
      openProblems: string[]
      warnings: string[]
      /** What contract paths are relative to. */
      projectRoot: string | null
      /** What was changed from the contract as written (absolute paths made relative). */
      adjustments: string[]
      /** Ways the contract could let more packets run at once. */
      advice: string[]
    }
  | { action: 'show'; text: string }

type CallerContext = Pick<ToolUseContext, 'agentId' | 'getAppState'>

function callerProblem(context: CallerContext): string | null {
  if (context.agentId) return 'Only the Orchestrator main agent can use the contract tool.'
  if (context.getAppState().toolPermissionContext.mode !== 'orchestrator') {
    return 'The contract applies only in Orchestrator mode.'
  }
  return null
}

/**
 * The directory this contract's paths are relative to. An existing run keeps its root;
 * a new one uses the same root its workspace will, so validation and the run agree.
 */
function contractRoot(active: OrchestrationRun | null): string {
  return (active && workspaceRoot(active.workspace)) || resolveProjectRoot()
}

/** The same checks validateInput and call run, so a race cannot slip a contract past them. */
function validatePublish(input: Input, context: CallerContext): ContractValidation {
  if (!input.contract) {
    return { ok: false, errors: ['To publish, pass the whole contract in `contract`.'] }
  }
  const active = getActiveRun(context.getAppState())
  const result = validateContract(input.contract, {
    caseInsensitivePaths: defaultCaseInsensitivePaths(),
    settingsCheckCommands: getOrchestratorSettings().checkCommands,
    projectRoot: contractRoot(active),
    worktreesAvailable: active ? workspaceTracking(active.workspace) === 'git' || active.workspace.repoRoot !== null : canUseWorktrees(),
  })
  if (!result.ok) return result
  const problem = active ? amendmentProblem(active, result.contract) : null
  return problem ? { ok: false, errors: [problem] } : result
}

/**
 * Say what the paths were relative to before the list: a refused contract is the moment
 * the root matters, and the model cannot see it anywhere else first.
 */
function formatErrors(errors: readonly string[], root: string): string {
  const list = errors.map((error, index) => `${index + 1}. ${error}`).join('\n')
  return `The contract was not published. Paths are relative to ${root}. Fix these, then call ${ORCHESTRATION_CONTRACT_TOOL_NAME} again with the corrected contract now; do not launch workers or ask the user first:\n${list}`
}

async function allocateRun(now: number): Promise<{ ids: NewRunIds; warnings: string[] }> {
  let runId = `run-unsaved-${now.toString(36)}`
  let auditDir: string | null = null
  try {
    const created = await createRunDirectory()
    runId = created.runId
    auditDir = created.dir
  } catch (error) {
    logError(error)
  }
  const { workspace, warning } = await prepareRunWorkspace(runId)
  return { ids: { runId, auditDir, workspace }, warnings: warning ? [warning] : [] }
}

type NewRunIds = { runId: string; auditDir: string | null; workspace: RunWorkspace }

/** Apply the new version inside the updater, so concurrent packet updates are kept. */
function applyPublished(
  context: Pick<ToolUseContext, 'setAppState'>,
  published: PublishedContract,
  ids: NewRunIds | null,
): { run: OrchestrationRun; closed: OrchestrationProblem[] } {
  const applied: { run?: OrchestrationRun; closed: OrchestrationProblem[] } = { closed: [] }
  context.setAppState((prev: AppState) => {
    const current = getActiveRun(prev)
    // A new version can settle open problems: the packet may now own the file.
    const settled = current
      ? settleProblemsByContract(amendRun(current, published))
      : { run: startRun(published, ids ?? { runId: 'run-unsaved', auditDir: null }), closed: [] }
    applied.run = settled.run
    applied.closed = settled.closed
    return { ...prev, orchestration: { ...prev.orchestration, run: settled.run } }
  })
  if (!applied.run) throw new Error('The contract could not be applied to the session state.')
  return { run: applied.run, closed: applied.closed }
}

async function publish(input: Input, context: ToolUseContext): Promise<OrchestrationContractOutput> {
  const validation = validatePublish(input, context)
  if (!validation.ok) {
    throw new Error(formatErrors(validation.errors, contractRoot(getActiveRun(context.getAppState()))))
  }
  const now = Date.now()
  const published: PublishedContract = { contract: validation.contract, waves: validation.waves, reason: input.reason, now }
  const isNewRun = getActiveRun(context.getAppState()) === null
  const allocated = isNewRun ? await allocateRun(now) : null
  const { run, closed } = applyPublished(context, published, allocated?.ids ?? null)
  const warnings = [...(allocated?.warnings ?? []), ...(await recordContractVersion(run, isNewRun))]
  await auditClosedProblems(run, closed).catch(logError)
  const updatedWorkers = isNewRun ? [] : sendContractUpdates(run, context)
  return {
    action: 'publish',
    runId: run.runId,
    version: run.current.version,
    newRun: isNewRun,
    waves: run.current.waves.map(names => [...names]),
    requiredChecks: run.current.contract.checks
      .filter(check => check.required)
      .map(check => ({ name: check.name, command: check.command })),
    auditDir: run.auditDir,
    updatedWorkers,
    resolvedProblems: closed.map(problem => problem.id),
    openProblems: openProblems(run).map(problem => `${problem.id} ${describeProblem(problem)}`),
    warnings,
    projectRoot: workspaceRoot(run.workspace),
    adjustments: [...validation.adjustments],
    advice: unneededDependencies(run.current.contract),
  }
}

/** Queue the new version for every running worker briefed with an older one. */
function sendContractUpdates(run: OrchestrationRun, context: ToolUseContext): string[] {
  const setAppState = context.setAppStateForTasks ?? context.setAppState
  return staleRunningWorkers(run).map(({ packet, agentId, update }) => {
    queuePendingMessage(agentId, update, setAppState)
    recordWorkerBriefed(agentId, setAppState)
    return packet
  })
}

function show(context: CallerContext): OrchestrationContractOutput {
  const run = context.getAppState().orchestration.run
  if (!run) {
    return {
      action: 'show',
      text: `No contract has been published in this session. Paths will be relative to ${resolveProjectRoot()} (the git root of the working directory).`,
    }
  }
  const archived =
    run.status === 'archived'
      ? `Run ${run.runId} has ended. Publish a contract to start a new run.\n\n`
      : ''
  return { action: 'show', text: `${archived}${renderContractMarkdown(run.current)}\nPaths are relative to ${contractRoot(run)}.\n` }
}

function publishedText(data: Extract<OrchestrationContractOutput, { action: 'publish' }>): string {
  const lines = [
    `Contract v${data.version} published for ${data.runId}${data.newRun ? ' (new run)' : ''}.`,
    'Order (packets in a line can run at the same time; launch each line in one message):',
    ...data.waves.map((names, index) => `  ${index + 1}. ${names.join(', ')}`),
    'Required checks:',
    ...data.requiredChecks.map(check => `  - ${check.name}: ${check.command}`),
    ...(data.projectRoot ? ['', `Paths are relative to ${data.projectRoot}; checks run there.`] : []),
    ...(data.adjustments.length ? ['Converted from absolute paths:', ...data.adjustments.map(note => `  - ${note}`)] : []),
    '',
    'Launch each packet as a general-purpose worker with the Agent tool, `name` set to the packet name and run_in_background true. RAYU gives each worker the contract and its packet, so your prompt only needs the packet-specific instructions. Start a packet only after the packets it depends on have finished. To change which packet owns a file, or an interface, publish a new version first.',
  ]
  if (data.updatedWorkers.length) {
    lines.push('', `Running workers were sent this version: ${data.updatedWorkers.join(', ')}. They apply it at their next tool round.`)
  }
  if (data.advice.length) lines.push('', 'To run more at once:', ...data.advice.map(note => `  - ${note}`))
  if (data.resolvedProblems.length) lines.push('', `This version settles problems ${data.resolvedProblems.join(', ')}.`)
  if (data.openProblems.length) lines.push('', 'Still open:', ...data.openProblems.map(problem => `  - ${problem}`))
  if (data.warnings.length) lines.push('', 'Warnings:', ...data.warnings.map(warning => `  - ${warning}`))
  return lines.join('\n')
}

export const OrchestrationContractTool: Tool<InputSchema, OrchestrationContractOutput> = buildTool({
  name: ORCHESTRATION_CONTRACT_TOOL_NAME,
  searchHint: 'publish the contract Orchestrator workers follow',
  maxResultSizeChars: 100_000,
  shouldDefer: false,

  userFacingName() {
    return ORCHESTRATION_CONTRACT_TOOL_NAME
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return getOrchestrationContractPrompt()
  },

  isReadOnly(input) {
    return input.action === 'show'
  },

  async validateInput(input, context) {
    const problem = callerProblem(context)
    if (problem) return { result: false, message: problem, errorCode: 1 }
    if (input.action === 'show') return { result: true }
    const validation = validatePublish(input, context)
    if (!validation.ok) {
      return { result: false, message: formatErrors(validation.errors, contractRoot(getActiveRun(context.getAppState()))), errorCode: 2 }
    }
    return { result: true }
  },

  async call(input, context) {
    const problem = callerProblem(context)
    if (problem) throw new Error(problem)
    return { data: input.action === 'show' ? show(context) : await publish(input, context) }
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: data.action === 'show' ? data.text : publishedText(data),
    }
  },

  renderToolUseMessage(input) {
    if (input.action === 'show') return 'show'
    const count = input.contract?.packets?.length
    return count ? `publish · ${count} packet${count === 1 ? '' : 's'}` : 'publish'
  },
} satisfies ToolDef<InputSchema, OrchestrationContractOutput>)
