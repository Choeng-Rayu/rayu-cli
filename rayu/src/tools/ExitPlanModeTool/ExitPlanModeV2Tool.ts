import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import {
  buildTool,
  type Tool,
  type ToolDef,
  toolMatchesName,
} from '../../Tool.js'
import { formatAgentId, generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from '../../utils/inProcessTeammateHelpers.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from '../../utils/plans.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = RAYU_FEATURES.TRANSCRIPT_CLASSIFIER
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null
const permissionSetupModule = RAYU_FEATURES.TRANSCRIPT_CLASSIFIER
  ? (require('../../utils/permissions/permissionSetup.js') as typeof import('../../utils/permissions/permissionSetup.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Schema for prompt-based permission requests.
 * Used by Claude to request semantic permissions when exiting plan mode.
 */
const allowedPromptSchema = lazySchema(() =>
  z.object({
    tool: z.enum(['Bash']).describe('The tool this prompt applies to'),
    prompt: z
      .string()
      .describe(
        'Semantic description of the action, e.g. "run tests", "install dependencies"',
      ),
  }),
)

export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // Prompt-based permissions requested by the plan
      allowedPrompts: z
        .array(allowedPromptSchema())
        .optional()
        .describe(
          'Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * SDK-facing input schema - includes fields injected by normalizeToolInput.
 * The internal inputSchema doesn't have these fields because plan is read from disk,
 * but the SDK/hooks see the normalized version with plan and file path included.
 */
export const _sdkInputSchema = lazySchema(() =>
  inputSchema().extend({
    plan: z
      .string()
      .optional()
      .describe('The plan content (injected by normalizeToolInput from disk)'),
    planFilePath: z
      .string()
      .optional()
      .describe('The plan file path (injected by normalizeToolInput)'),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    plan: z
      .string()
      .nullable()
      .describe('The plan that was presented to the user'),
    isAgent: z.boolean(),
    filePath: z
      .string()
      .optional()
      .describe('The file path where the plan was saved'),
    hasTaskTool: z
      .boolean()
      .optional()
      .describe('Whether the Agent tool is available in the current context'),
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        'True when the user edited the plan (CCR web UI or Ctrl+G); determines whether the plan is echoed back in tool_result',
      ),
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe(
        'When true, the teammate has sent a plan approval request to the team leader',
      ),
    requestId: z
      .string()
      .optional()
      .describe('Unique identifier for the plan approval request'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ExitPlanModeV2Tool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_PLAN_MODE_V2_TOOL_NAME,
  searchHint: 'present plan for approval and start coding (plan mode only)',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Prompts the user to exit plan mode and start coding'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  shouldDefer: true,
  isEnabled() {
    // When --channels is active the user is likely on Telegram/Discord, not
    // watching the TUI. The plan-approval dialog would hang. Paired with the
    // same gate on EnterPlanMode so plan mode isn't a trap.
    if (
      (RAYU_FEATURES.KAIROS || RAYU_FEATURES.KAIROS_CHANNELS) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false // Now writes to disk
  },
  requiresUserInteraction() {
    // For ALL teammates, no local user interaction needed:
    // - If isPlanModeRequired(): team lead approves via mailbox
    // - Otherwise: exits locally without approval (voluntary plan mode)
    if (isTeammate()) {
      return false
    }
    // For non-teammates, require user confirmation to exit plan mode
    return true
  },
  async validateInput(_input, { getAppState, options }) {
    // Teammate AppState may show leader's mode (runAgent.ts skips override in
    // acceptEdits/bypassPermissions/auto); isPlanModeRequired() is the real source
    if (isTeammate()) {
      return { result: true }
    }
    // The deferred-tool list announces this tool regardless of mode, so the
    // model can call it after plan approval (fresh delta on compact/clear).
    // Reject before checkPermissions to avoid showing the approval dialog.
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      logEvent('tengu_exit_plan_mode_called_outside_plan', {
        model:
          options.mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        hasExitedPlanModeInSession: hasExitedPlanModeInSession(),
      })
      return {
        result: false,
        message:
          'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    // For ALL teammates, bypass the permission UI to avoid sending permission_request
    // The call() method handles the appropriate behavior:
    // - If isPlanModeRequired(): sends plan_approval_request to leader
    // - Otherwise: exits plan mode locally (voluntary plan mode)
    if (isTeammate()) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }

    // For non-teammates, require user confirmation to exit plan mode
    return {
      behavior: 'ask' as const,
      message: 'Exit plan mode?',
      updatedInput: input,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input, context) {
    const isAgent = !!context.agentId

    const filePath = getPlanFilePath(context.agentId)
    // CCR web UI may send an edited plan via permissionResult.updatedInput.
    // queryHelpers.ts full-replaces finalInput, so when CCR sends {} (no edit)
    // input.plan is undefined -> disk fallback. The internal inputSchema omits
    // `plan` (normally injected by normalizeToolInput), hence the narrowing.
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    const plan = inputPlan ?? getPlan(context.agentId)

    // Sync disk so VerifyPlanExecution / Read see the edit. Re-snapshot
    // after: the only other persistFileSnapshotIfRemote call (api.ts) runs
    // in normalizeToolInput, pre-permission — it captured the old plan.
    if (inputPlan !== undefined && filePath) {
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    // Check if this is a teammate that requires leader approval
    if (isTeammate() && isPlanModeRequired()) {
      // Plan is required for plan_mode_required teammates
      if (!plan) {
        throw new Error(
          `No plan file found at ${filePath}. Please write your plan to this file before calling ExitPlanMode.`,
        )
      }
      const agentName = getAgentName() || 'unknown'
      const teamName = getTeamName()
      const requestId = generateRequestId(
        'plan_approval',
        formatAgentId(agentName, teamName || 'default'),
      )

      const approvalRequest = {
        type: 'plan_approval_request',
        from: agentName,
        timestamp: new Date().toISOString(),
        planFilePath: filePath,
        planContent: plan,
        requestId,
      }

      await writeToMailbox(
        'team-lead',
        {
          from: agentName,
          text: jsonStringify(approvalRequest),
          timestamp: new Date().toISOString(),
        },
        teamName,
      )

      // Update task state to show awaiting approval (for in-process teammates)
      const appState = context.getAppState()
      const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
      if (agentTaskId) {
        setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
      }

      return {
        data: {
          plan,
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        },
      }
    }

    // Note: Background verification hook is registered in REPL.tsx AFTER context clear
    // via registerPlanVerificationHook(). Registering here would be cleared during context clear.

    // Ensure mode is changed when exiting plan mode.
    // This handles cases where permission flow didn't set the mode
    // (e.g., when PermissionRequest hook auto-approves without providing updatedPermissions).
    context.setAppState(prev => {
      if (prev.toolPermissionContext.mode !== 'plan') return prev
      setHasExitedPlanMode(true)
      setNeedsPlanModeExitAttachment(true)
      // A confirmed plan enters Orchestrator mode. This intentionally uses the
      // fullManage-equivalent permission behavior so delegated workers can implement and
      // verify without interrupting the orchestration loop for approvals.
      if (RAYU_FEATURES.TRANSCRIPT_CLASSIFIER) {
        // Capture pre-restore state — isAutoModeActive() is the authoritative
        // signal (prePlanMode/strippedDangerousRules are stale after
        // transitionPlanAutoMode deactivates mid-plan).
        const autoWasUsedDuringPlan =
          autoModeStateModule?.isAutoModeActive() ?? false
        autoModeStateModule?.setAutoModeActive(false)
        if (autoWasUsedDuringPlan) {
          setNeedsAutoModeExitAttachment(true)
        }
      }
      // Orchestrator is not auto mode, so restore any rules stripped while
      // planning before applying Orchestrator's fullManage-equivalent semantics.
      let baseContext = prev.toolPermissionContext
      if (prev.toolPermissionContext.strippedDangerousRules) {
        baseContext =
          permissionSetupModule?.restoreDangerousPermissions(baseContext) ??
          baseContext
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...baseContext,
          mode: 'orchestrator',
          prePlanMode: undefined,
        },
      }
    })

    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))

    return {
      data: {
        plan,
        isAgent,
        filePath,
        hasTaskTool: hasTaskTool || undefined,
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    {
      isAgent,
      plan,
      filePath,
      hasTaskTool,
      planWasEdited,
      awaitingLeaderApproval,
      requestId,
    },
    toolUseID,
  ) {
    // Handle teammate awaiting leader approval
    if (awaitingLeaderApproval) {
      return {
        type: 'tool_result',
        content: `Your plan has been submitted to the team lead for approval.

Plan file: ${filePath}

**What happens next:**
1. Wait for the team lead to review your plan
2. You will receive a message in your inbox with approval/rejection
3. If approved, you can proceed with implementation
4. If rejected, refine your plan based on the feedback

**Important:** Do NOT proceed until you receive approval. Check your inbox for response.

Request ID: ${requestId}`,
        tool_use_id: toolUseID,
      }
    }

    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          'User has approved the plan. There is nothing else needed from you now. Please respond with "ok"',
        tool_use_id: toolUseID,
      }
    }

    // Handle empty plan
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content:
          'User has approved exiting plan mode. Orchestrator mode is now active: coordinate and delegate all implementation and verification; do not code or run implementation commands yourself.',
        tool_use_id: toolUseID,
      }
    }

    const teamHint = hasTaskTool
      ? '\n\nDispatch independent, named general-purpose workers in parallel with exact non-overlapping ownership. Keep dependent packets sequential and resume existing workers with SendMessage.'
      : ''

    // Always include the plan — extractApprovedPlan() in the Ultraplan CCR
    // flow parses the tool_result to retrieve the plan text for the local CLI.
    // Label edited plans so the model knows the user changed something.
    const planLabel = planWasEdited
      ? 'Approved Plan (edited by user)'
      : 'Approved Plan'

    return {
      type: 'tool_result',
      content: `User has approved your plan and Orchestrator mode is now active. Do not implement it yourself. Delegate every implementation and verification packet to subagents, coordinate their dependencies, and integrate their results.${teamHint}

Your plan has been saved to: ${filePath}
Use it as the contract for delegated implementation.

## ${planLabel}:
${plan}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
