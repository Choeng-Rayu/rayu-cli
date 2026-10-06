/**
 * How an approval is shown in Studio, and how Studio's answer becomes the response
 * the host applies.
 *
 * Shared by BOTH Web Bridge workers — the CLI REPL (webBridgePermissions.ts) and the
 * Rayucode extension host (vscode/host/webBridge/vscodeWebBridge.ts) — because a
 * browser tab must not be able to tell them apart, and two copies of this decision
 * would drift. Transport and id correlation stay in `client/`; this module owns only
 * the permission semantics.
 *
 * WHY ROUTING BY TOOL MATTERS. Studio has three cards, and two tools are forms rather
 * than yes/no gates:
 *
 *  • AskUserQuestion is answered through `updatedInput.answers`. Sent as a generic tool
 *    approval, "Allow" ran the tool with an EMPTY answer set and the model was told the
 *    user had answered, with nothing after the colon.
 *  • ExitPlanMode is "here is the plan — how should I proceed?". As a generic card it
 *    showed neither the plan card nor "approve and auto-accept edits".
 *
 * WHY THE HOST'S OWN INPUT IS USED. The relay and the browser only ever saw a CLAMPED
 * copy of the input (see clampToolInput), so answers are merged onto the input THIS
 * host asked about, using the same builder the terminal and the editor use; a plan
 * approval is the terminal's unedited approval and may carry only the one mode change
 * Studio offers; and a remembered rule must be one this host offered.
 */

import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import {
  buildAskUserQuestionInput,
  parseAskUserQuestions,
} from '../utils/askUserQuestion.js'
import { isInteractionTool } from '../utils/permissions/interactionTools.js'
import type { BridgeDecision, WebBridgePermissionRelay } from './client/index.js'

/** Which Studio card renders a request. */
export type WebBridgeApprovalKind = 'tool' | 'plan' | 'question'

/** One permission request, as the host raised it. */
export interface WebBridgeApprovalRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  description?: string
  toolUseId?: string
  permissionSuggestions?: unknown[]
  blockedPath?: string
}

/** What the host applies: the fields of its permission response, host-agnostic. */
export interface WebBridgeApprovalResponse {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown[]
}

/**
 * The only mode change a remote plan approval may make, built here rather than taken
 * from the frame. Same update as telegramPlanApproval's `acceptEditsUpdate()` — not
 * imported from there because this module also ships in the VS Code extension host,
 * which must not pull in Telegram code.
 */
const ACCEPT_EDITS_UPDATE = {
  type: 'setMode',
  mode: 'acceptEdits',
  destination: 'session',
} as const

function planText(input: Record<string, unknown>): string {
  return typeof input.plan === 'string' ? input.plan : ''
}

/**
 * Pick the card for a request.
 *
 * Falls back to the generic tool card when a form has nothing to show (no parseable
 * questions, no plan text), so the request is still answerable rather than hanging —
 * the same fallback the Telegram bridge uses.
 */
export function approvalKind(request: WebBridgeApprovalRequest): WebBridgeApprovalKind {
  if (
    request.toolName === ASK_USER_QUESTION_TOOL_NAME &&
    parseAskUserQuestions(request.input).length > 0
  ) {
    return 'question'
  }
  if (request.toolName === EXIT_PLAN_MODE_TOOL_NAME && planText(request.input).trim()) {
    return 'plan'
  }
  return 'tool'
}

/**
 * Send a request as its card. False means Studio will never answer it — the caller
 * must not wait on it, and its local prompt stays the only gate.
 */
export function sendApproval(
  relay: WebBridgePermissionRelay,
  kind: WebBridgeApprovalKind,
  request: WebBridgeApprovalRequest,
): boolean {
  switch (kind) {
    case 'question':
      return relay.requestQuestions(request.requestId, {
        questions: parseAskUserQuestions(request.input),
        toolInput: request.input,
      })
    case 'plan':
      return relay.requestPlan(request.requestId, { plan: planText(request.input) })
    case 'tool':
      return relay.requestTool(request.requestId, {
        toolName: request.toolName,
        toolInput: request.input,
        ...(request.description ? { description: request.description } : {}),
        ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
        // A form-like tool is never offered a rule to remember. See isInteractionTool.
        ...(request.permissionSuggestions?.length && !isInteractionTool(request.toolName)
          ? { permissionSuggestions: request.permissionSuggestions }
          : {}),
        ...(request.blockedPath ? { blockedPath: request.blockedPath } : {}),
      })
  }
}

function asksForAcceptEdits(updates: unknown[] | undefined): boolean {
  return (updates ?? []).some(entry => {
    const update = entry as { type?: unknown; mode?: unknown } | null
    return update?.type === 'setMode' && update.mode === 'acceptEdits'
  })
}

/**
 * The only rules a remote "Don't ask again" may persist for a tool.
 *
 * Exactly what Studio can express: the CLI's OWN suggestions echoed back or, when it
 * offered none, the single-tool allow-rule the backend derives from the checkbox (the
 * rule Telegram's "Always allow" writes). Anything else in a frame is something nobody
 * was shown — an allow-rule for another tool, a write to user settings, a `setMode
 * bypassPermissions` — and would outlive the remote session, so it is dropped.
 */
function offeredRules(request: WebBridgeApprovalRequest): unknown[] {
  if (isInteractionTool(request.toolName)) return []
  if (request.permissionSuggestions?.length) return request.permissionSuggestions
  return [
    {
      type: 'addRules',
      rules: [{ toolName: request.toolName }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]
}

/** JSON with sorted keys, so a rule that crossed the relay compares equal to the original. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  )
}

/**
 * Translate Studio's decision into the response the host applies.
 *
 * Returns null when an "allow" cannot be applied — interview answers that do not fit
 * the questions asked. Nothing is synthesised in that case: the local prompt is still
 * on screen and still authoritative, exactly as when the socket drops.
 */
export function resolveApprovalDecision(
  kind: WebBridgeApprovalKind,
  request: WebBridgeApprovalRequest,
  decision: BridgeDecision,
): WebBridgeApprovalResponse | null {
  if (decision.behavior !== 'allow') {
    return { behavior: 'deny', ...(decision.message ? { message: decision.message } : {}) }
  }

  if (kind === 'question') {
    const answered = decision.updatedInput ?? {}
    const updatedInput = buildAskUserQuestionInput(
      request.input,
      answered.answers,
      answered.annotations,
    )
    return updatedInput ? { behavior: 'allow', updatedInput } : null
  }

  if (kind === 'plan') {
    return {
      behavior: 'allow',
      /*
       * `{}` — exactly what the terminal's own plan dialog sends for an unedited plan
       * (ExitPlanModePermissionRequest). The tool then reads the plan from disk, so an
       * edit made to the plan file while this card was open is honoured instead of
       * being overwritten with the snapshot the browser saw, and the model is not told
       * the user edited it. The stdio permission path (VS Code) maps `{}` back to the
       * original input, which is what the editor's own card sends.
       *
       * No mode change on a plain approval, as on Telegram and the editor's card: the
       * ExitPlanMode tool then applies the product rule that a confirmed plan enters
       * Orchestrator mode (AGENTS_ORCHESTRATOR.md). Studio's card states that outcome on
       * the button, and test/webBridgePlanApprovalMode.test.ts pins it.
       */
      updatedInput: {},
      ...(asksForAcceptEdits(decision.updatedPermissions)
        ? { updatedPermissions: [{ ...ACCEPT_EDITS_UPDATE }] }
        : {}),
    }
  }

  const offered = new Set(offeredRules(request).map(canonicalJson))
  const updatedPermissions = (decision.updatedPermissions ?? []).filter(update =>
    offered.has(canonicalJson(update)),
  )

  return {
    behavior: 'allow',
    updatedInput: decision.updatedInput ?? request.input,
    ...(updatedPermissions.length ? { updatedPermissions } : {}),
  }
}
