/**
 * `ExternalAgent` tool — how the MODEL delegates work to a foreign agent CLI.
 * `/agent` is the same capabilities for the USER.
 *
 * Both go through `AgentManager`, so admission control, capability gating and
 * persistence behave identically no matter who asked. Nothing in this file
 * decides whether a send can proceed; it turns tool input into a manager call
 * and reports what actually happened.
 *
 * Deliberately small surface
 * --------------------------
 * `delegate`, `send`, `list` — and nothing else. Progress, results and
 * cancellation are NOT reimplemented here because RAYU already has tools for
 * them: the T3 event sinks write the agent's output through
 * `appendTaskOutput`, and `TaskOutputTool` falls through to
 * `getTaskOutput(task.id)` for task types it does not special-case, so
 * TaskOutput / TaskGet / TaskList / TaskStop work on external agent tasks
 * unchanged. Adding `status` / `output` / `stop` actions here would duplicate
 * four working tools and give the model two ways to ask the same question.
 *
 * Always asynchronous
 * -------------------
 * `delegate` and `send` return a task id immediately rather than blocking until
 * the agent finishes. A foreign agent turn can run for many minutes and may
 * stop to ask a human for approval; holding the model's tool call open for that
 * would burn the turn and make the approval undeliverable.
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { registerAdapters } from '../../externalAgents/adapters/registry.js'
import {
  allocateAgentId,
  assign,
  findLiveAgent,
  listLiveAgents,
  startAgent,
} from '../../externalAgents/core/AgentManager.js'
import { listAvailableAdapters } from '../../externalAgents/core/adapterRegistry.js'
import {
  asProviderId,
  asTaskRef,
  type AgentInstanceId,
} from '../../externalAgents/core/types.js'
import { isExternalAgentsEnabled } from '../../externalAgents/featureGate.js'
import {
  prepareWorkspace,
  releaseWorkspace,
} from '../../externalAgents/workspace/workspaceManager.js'
import { registerExternalAgentTask } from '../../tasks/ExternalAgentTask/ExternalAgentTask.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  DESCRIPTION,
  EXTERNAL_AGENT_TOOL_NAME,
  getExternalAgentPrompt,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['delegate', 'send', 'list', 'orchestrate'])
      .describe(
        'delegate = assign work (starts or reuses an agent); send = continue with a connected agent; list = what is installed and connected; orchestrate = run several steps under a policy',
      ),
    provider: z
      .string()
      .optional()
      .describe(
        'Provider to start, e.g. "codex", "claude-code", "opencode". Use with action=delegate to launch a fresh instance.',
      ),
    agent_id: z
      .string()
      .optional()
      .describe(
        'Existing agent instance id, e.g. "codex:agent_01". Required for action=send; use with delegate to reuse a connected agent.',
      ),
    prompt: z
      .string()
      .optional()
      .describe('The work to do. Required for delegate and send.'),
    cwd: z
      .string()
      .optional()
      .describe('Working directory for a newly started agent. Defaults to the session cwd.'),
    model: z
      .string()
      .optional()
      .describe("Provider-native model id, when the agent should not use its own default."),
    isolate: z
      .boolean()
      .optional()
      .describe(
        'Give a newly started agent its own git worktree so its edits cannot collide with yours or another agent\u2019s. Default false.',
      ),
    /**
     * Only for action=orchestrate. Kept as a flat sibling rather than nested
     * inside a `plan` object so the schema stays one level deep — models
     * populate flat shapes far more reliably.
     */
    mode: z
      .enum(['parallel', 'sequential', 'race'])
      .optional()
      .describe(
        'orchestrate only. parallel = all at once, a failure does not stop the rest. sequential = in order, stops on first failure. race = same work to several targets, first success wins and the losers are cancelled.',
      ),
    steps: z
      .array(
        z.object({
          id: z.string().describe('Unique label for this step, echoed in the result.'),
          prompt: z.string().describe('The work for this step.'),
          provider: z
            .string()
            .optional()
            .describe('Start a fresh agent of this provider for the step.'),
          agent_id: z
            .string()
            .optional()
            .describe('Or use this already-connected agent.'),
          isolate: z
            .boolean()
            .optional()
            .describe('Own git worktree for a newly started agent.'),
          retry_attempts: z
            .number()
            .int()
            .optional()
            .describe(
              'Total attempts against the target. Only transient failures (rate limit, disconnect, timeout) are retried.',
            ),
          fallback_provider: z
            .string()
            .optional()
            .describe('Try this provider if the primary target is exhausted.'),
        }),
      )
      .optional()
      .describe('orchestrate only. The steps to run.'),
    review_provider: z
      .string()
      .optional()
      .describe(
        'orchestrate only. Send a summary of the completed work to a fresh agent of this provider for review.',
      ),
    review_prompt: z
      .string()
      .optional()
      .describe('orchestrate only. Instruction for the reviewer.'),
    allow_shared_workspace_race: z
      .boolean()
      .optional()
      .describe(
        'orchestrate only. Required to race agents in one working tree: a cancelled loser can leave half-applied edits behind.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string(),
    summary: z.string(),
    agent_id: z.string().optional(),
    task_id: z.string().optional(),
    /** What admission control actually did: dispatch, steer, queue, resume, relaunch. */
    outcome: z.string().optional(),
    agents: z
      .array(
        z.object({
          agent_id: z.string(),
          provider: z.string(),
          agent_state: z.string(),
          can_send: z.boolean(),
        }),
      )
      .optional(),
    providers: z.array(z.string()).optional(),
    /** orchestrate only: the rendered plan report. */
    plan_report: z.string().optional(),
    plan_status: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const ExternalAgentTool = buildTool({
  name: EXTERNAL_AGENT_TOOL_NAME,
  searchHint: 'delegate work to codex claude-code opencode agent cli',
  maxResultSizeChars: 32_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled: isExternalAgentsEnabled,
  isReadOnly(input) {
    // Only `list` is read-only. delegate/send hand work to a process that will
    // edit files, so they must never be treated as safe-to-run-concurrently.
    return input.action === 'list'
  },
  isConcurrencySafe(input) {
    return input.action === 'list'
  },
  toAutoClassifierInput(input) {
    return `ExternalAgent ${input.action}: ${input.prompt ?? input.provider ?? input.agent_id ?? ''}`
  },
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'External Agent'
  },
  getActivityDescription(input) {
    if (!input) return 'Working with an external agent'
    switch (input.action) {
      case 'list':
        return 'Checking external agents'
      case 'send':
        return `Sending to ${input.agent_id ?? 'an external agent'}`
      case 'orchestrate':
        return `Orchestrating ${input.steps?.length ?? 0} agent steps (${input.mode ?? 'parallel'})`
      default:
        return `Delegating to ${input.agent_id ?? input.provider ?? 'an external agent'}`
    }
  },
  async prompt() {
    return getExternalAgentPrompt()
  },
  /**
   * Reject impossible combinations here rather than in `call`, so the model gets
   * a schema-level correction naming the missing field instead of a runtime
   * failure it has to interpret.
   */
  async validateInput(input) {
    if (input.action === 'list') return { result: true }
    if (input.action === 'orchestrate') {
      if (!input.steps || input.steps.length === 0) {
        return {
          result: false,
          message: 'action="orchestrate" needs a non-empty steps array.',
          errorCode: 4,
        }
      }
      const missingTarget = input.steps.find(
        step => !step.provider && !step.agent_id,
      )
      if (missingTarget) {
        return {
          result: false,
          message: `Step "${missingTarget.id}" needs either provider or agent_id.`,
          errorCode: 5,
        }
      }
      if (input.review_provider && !input.review_prompt) {
        return {
          result: false,
          message: 'review_provider was given without review_prompt.',
          errorCode: 6,
        }
      }
      return { result: true }
    }
    if (!input.prompt || input.prompt.trim() === '') {
      return {
        result: false,
        message: `prompt is required for action="${input.action}".`,
        errorCode: 1,
      }
    }
    if (input.action === 'send' && !input.agent_id) {
      return {
        result: false,
        message:
          'agent_id is required for action="send". Use action="list" to see connected agents, or action="delegate" with a provider to start one.',
        errorCode: 2,
      }
    }
    if (input.action === 'delegate' && !input.provider && !input.agent_id) {
      return {
        result: false,
        message:
          'action="delegate" needs either provider (to start a new agent) or agent_id (to reuse a connected one).',
        errorCode: 3,
      }
    }
    return { result: true }
  },
  async call(input, context: ToolUseContext) {
    registerAdapters()

    if (input.action === 'list') {
      return { data: await listAction() }
    }

    if (input.action === 'orchestrate') {
      return { data: await orchestrateAction(input, context) }
    }

    const target =
      input.action === 'send' || input.agent_id
        ? resolveExisting(input.agent_id!)
        : await launchForDelegate(input)

    if ('error' in target) {
      return { data: { action: input.action, summary: target.error } }
    }

    const taskId = registerExternalAgentTask(context.setAppState, {
      agentInstanceId: target.agentId,
      provider: target.provider,
      prompt: input.prompt!,
      agentSessionId: target.sessionId,
      // 'queued' until admission tells us otherwise, so a task never claims to
      // be running before it is.
      externalState: 'queued',
      worktreePath: target.worktreePath,
      toolUseId: context.toolUseId,
      agentId: context.agentId,
    })

    // taskRef is the task id: the T3 event sinks route the agent's output to
    // this task's output file and update its state from it.
    const outcome = await assign(
      target.agentId,
      { text: input.prompt! },
      { taskRef: asTaskRef(taskId) },
    )

    return {
      data: {
        action: input.action,
        agent_id: target.agentId,
        task_id: taskId,
        outcome: outcome.action,
        summary: summarizeOutcome(target.agentId, taskId, outcome),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [{ type: 'text', text: renderOutputText(output) }],
    }
  },
  // Plain strings rather than JSX: `React.ReactNode` accepts them, and this tool
  // has nothing to render that a line of text does not cover. Keeping the file
  // `.ts` avoids pulling the renderer into the tool registry's module graph.
  renderToolUseMessage(input) {
    switch (input.action) {
      case 'list':
        return 'list'
      case 'send':
        return `send \u2192 ${input.agent_id ?? '?'}`
      case 'orchestrate':
        return `orchestrate ${input.mode ?? 'parallel'} \u00d7${input.steps?.length ?? 0}`
      default:
        return `delegate \u2192 ${input.agent_id ?? input.provider ?? '?'}${
          input.isolate ? ' (isolated)' : ''
        }`
    }
  },
  renderToolResultMessage(output) {
    return output.summary
  },
} satisfies ToolDef<InputSchema, Output>)

type ResolvedTarget = {
  readonly agentId: AgentInstanceId
  readonly provider: ReturnType<typeof asProviderId>
  readonly sessionId?: ReturnType<
    NonNullable<ReturnType<typeof findLiveAgent>>['activeSessionId']
  >
  readonly worktreePath?: string
}

function resolveExisting(
  agentIdToken: string,
): ResolvedTarget | { error: string } {
  const handle = findLiveAgent(agentIdToken as AgentInstanceId)
  if (!handle) {
    const connected = listLiveAgents().map(h => h.agentId)
    return {
      error:
        connected.length === 0
          ? `No external agent "${agentIdToken}" is connected. Use action="delegate" with a provider to start one.`
          : `No external agent "${agentIdToken}". Connected: ${connected.join(', ')}.`,
    }
  }
  return {
    agentId: handle.agentId,
    provider: handle.provider,
    sessionId: handle.activeSessionId(),
  }
}

async function launchForDelegate(
  input: Input,
): Promise<ResolvedTarget | { error: string }> {
  const provider = asProviderId(input.provider!)
  const agentId = await allocateAgentId(provider)

  const workspace = await prepareWorkspace({
    agentId,
    cwd: input.cwd ?? getCwd(),
    isolation: input.isolate ? 'worktree' : 'shared',
  })
  if (!workspace.ok) return { error: workspace.message }

  try {
    const handle = await startAgent({
      agentId,
      provider,
      cwd: workspace.workspace.cwd,
      model: input.model,
    })
    return {
      agentId: handle.agentId,
      provider: handle.provider,
      sessionId: handle.activeSessionId(),
      worktreePath: workspace.workspace.worktree?.path,
    }
  } catch (error) {
    // Do not leave the workspace reserved for an agent that never started.
    await releaseWorkspace(agentId)
    return {
      error: `Could not start ${provider}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/**
 * Run a multi-step plan.
 *
 * Unlike `delegate`, this one WAITS: the whole point of a policy is that the
 * caller wants the coordinated outcome, and `sequential`, `race`, retry and
 * fallback are all meaningless if the tool returns before the steps resolve.
 * Every individual step is still a real task, so its output remains readable
 * with TaskOutput while the plan runs.
 */
async function orchestrateAction(
  input: Input,
  context: ToolUseContext,
): Promise<Output> {
  const { createOrchestrationDeps } = await import(
    '../../externalAgents/orchestration/deps.js'
  )
  const { formatPlanResult, runPlan } = await import(
    '../../externalAgents/orchestration/runner.js'
  )

  const plan = {
    mode: input.mode ?? 'parallel',
    allowSharedWorkspaceRace: input.allow_shared_workspace_race,
    steps: (input.steps ?? []).map(step => ({
      id: step.id,
      prompt: step.prompt,
      target: toStepTarget(step),
      retry: step.retry_attempts
        ? { attempts: step.retry_attempts }
        : undefined,
      fallback: step.fallback_provider
        ? [
            {
              kind: 'provider' as const,
              provider: asProviderId(step.fallback_provider),
              isolate: step.isolate,
            },
          ]
        : undefined,
    })),
    reviewAfter:
      input.review_provider && input.review_prompt
        ? {
            target: {
              kind: 'provider' as const,
              provider: asProviderId(input.review_provider),
            },
            prompt: input.review_prompt,
          }
        : undefined,
  }

  const result = await runPlan(plan, createOrchestrationDeps(context.setAppState), {
    signal: context.abortController?.signal,
  })

  return {
    action: 'orchestrate',
    plan_status: result.status,
    plan_report: formatPlanResult(result),
    summary:
      result.status === 'invalid'
        ? `The plan was refused and nothing was launched: ${result.errors.join(' ')}`
        : `Plan ${result.status}. ${
            result.steps.filter(step => step.status === 'completed').length
          }/${result.steps.length} steps completed.`,
  }
}

function toStepTarget(step: {
  provider?: string
  agent_id?: string
  isolate?: boolean
}) {
  return step.agent_id
    ? { kind: 'agent' as const, agentId: step.agent_id as AgentInstanceId }
    : {
        kind: 'provider' as const,
        provider: asProviderId(step.provider!),
        isolate: step.isolate,
      }
}

async function listAction(): Promise<Output> {  const [available, live] = await Promise.all([
    listAvailableAdapters(),
    Promise.resolve(listLiveAgents()),
  ])
  const agents = live.map(handle => ({
    agent_id: handle.agentId,
    provider: String(handle.provider),
    agent_state: handle.status().agentState,
    // Reported per instance rather than per provider: an adopted or
    // observe-class instance can be connected yet unable to accept input.
    can_send: handle.capabilities.messages !== 'none',
  }))
  const providers = available.map(adapter => String(adapter.provider))
  return {
    action: 'list',
    providers,
    agents,
    summary:
      providers.length === 0
        ? 'No external agent CLIs are installed and available on this machine.'
        : `Installed: ${providers.join(', ')}. Connected: ${
            agents.length === 0
              ? 'none'
              : agents.map(a => `${a.agent_id} (${a.agent_state})`).join(', ')
          }.`,
  }
}

function summarizeOutcome(
  agentId: AgentInstanceId,
  taskId: string,
  outcome: Awaited<ReturnType<typeof assign>>,
): string {
  const read = `Read progress with TaskOutput on task ${taskId}.`
  switch (outcome.action) {
    case 'dispatch':
      return `${agentId} started work as task ${taskId}. ${read}`
    case 'steer':
      return `Injected into ${agentId}'s running turn as task ${taskId}. ${read}`
    case 'queue':
      return `${agentId} is busy; queued at position ${outcome.queuePosition ?? 1} as task ${taskId}. It will start automatically — do not resend. ${read}`
    case 'resume':
      return `Reconnecting to ${agentId}, then it will run task ${taskId}. ${read}`
    case 'relaunch':
      return `${agentId} needs relaunching; task ${taskId} is held and will run once it is back. ${read}`
    default:
      return `${agentId}: ${outcome.reason} (task ${taskId})`
  }
}

function renderOutputText(output: Output): string {
  const lines = [output.summary]
  if (output.agents && output.agents.length > 0) {
    for (const agent of output.agents) {
      lines.push(
        `  ${agent.agent_id}  ${agent.provider}  ${agent.agent_state}${
          agent.can_send ? '' : '  (cannot accept input)'
        }`,
      )
    }
  }
  return lines.join('\n')
}
