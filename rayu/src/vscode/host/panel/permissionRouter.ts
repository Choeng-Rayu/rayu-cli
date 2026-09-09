/**
 * Tool permission requests.
 *
 * The engine runs with `--permission-prompt-tool=stdio`, so `getCanUseToolFn` in
 * `cli/print.ts` returns `structuredIO.createCanUseTool()`. That sends a
 * `can_use_tool` control request and BLOCKS the tool until a matching
 * `control_response` comes back. This module is what answers it.
 *
 * ── AN UNANSWERED REQUEST IS A STUCK TURN, NOT A LOST MESSAGE ───────────────────
 *
 * There is no timeout on the engine side, and there should not be: a human is being
 * asked a question. So every path out of a pending request must either answer it or
 * explicitly cancel it. Silence is the one outcome that produces a session which
 * looks alive, shows a spinner, and will never finish.
 *
 * ── THE RESPONSE SHAPE IS EXACT ────────────────────────────────────────────────
 *
 * `utils/permissions/PermissionPromptToolResultSchema.ts` validates what we send:
 *
 *   allow → { behavior: 'allow', updatedInput, updatedPermissions?, decisionClassification? }
 *   deny  → { behavior: 'deny',  message,      interrupt?,          decisionClassification? }
 *
 * `updatedInput` is REQUIRED on allow, not optional. We do not offer input editing,
 * so the original input is echoed back — omitting it fails validation and the engine
 * treats the malformed answer as a denial, which would look like the approval button
 * not working.
 *
 * `decisionClassification` is how "allow once" and "always allow" differ:
 * `user_temporary` applies to this call, `user_permanent` records a lasting rule
 * alongside `updatedPermissions`.
 *
 * ── TWO RULES CARRIED OVER FROM THE WEB BRIDGE ──────────────────────────────────
 *
 * `webBridge/webBridgePermissions.ts` documents both, and both are about trust in a
 * control the user has to be able to rely on:
 *
 * 1. CANCELLATION MUST RELIABLY DISMISS THE CARD. "A card left offering Allow/Deny
 *    for a decision nobody is waiting on is a control that does nothing when
 *    pressed, and this is the one control that has to be trustworthy."
 *
 * 2. LOSING THE CHANNEL MUST NOT FABRICATE A DENIAL. If the panel closes or the
 *    engine dies, pending cards are dismissed WITHOUT inventing an answer.
 *    Auto-denying would reject a tool the user was in the middle of approving;
 *    auto-allowing would grant consent that was never given.
 */
import type { ControlClient, InboundControlRequest } from '../engine/controlClient.js'
import { summariseInput } from '../../../utils/activity/activityBlocks.js'
import {
  buildAskUserQuestionInput,
  parseAskUserQuestions,
} from '../../../utils/askUserQuestion.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../../tools/AskUserQuestionTool/prompt.js'
import type { PermissionRequestView } from '../../shared/webviewProtocol.js'

/** What the user chose. */
export type PermissionDecision =
  /** Run it this once. */
  | { kind: 'allow-once' }
  /** Run it, and stop asking for this tool. */
  | { kind: 'allow-always' }
  /** Refuse. */
  | { kind: 'deny' }

export interface PermissionRouterCallbacks {
  /** Show an approval card. */
  onShow: (view: PermissionRequestView) => void
  /** Remove a card, because it is no longer answerable. */
  onDismiss: (requestId: string) => void
}

interface Pending {
  requestId: string
  toolName: string
  toolUseId?: string
  /** Echoed back on allow — `updatedInput` is required by the engine's schema. */
  input: Record<string, unknown>
  /** Rules the engine suggested, replayed on "always allow". */
  suggestions: unknown[]
  /**
   * Present only for a request mirrored from an ATTACHED session: the callback that
   * carries the decision back over IPC. Absent for local requests, which are answered
   * through this panel's own ControlClient.
   */
  respondRemotely?: (response: unknown) => void
  /** The card as the webview sees it, retained so a resync can restore it. */
  view: PermissionRequestView
}

export class PermissionRouter {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly callbacks: PermissionRouterCallbacks) {}

  /** True while any card is outstanding. */
  get hasPending(): boolean {
    return this.pending.size > 0
  }

  /**
   * Outstanding cards, for the state snapshot.
   *
   * The engine stays blocked across a webview re-creation, so a collapsed panel must
   * come back with its cards intact — otherwise the turn is stuck and there is
   * nothing on screen to unblock it.
   */
  snapshot(): PermissionRequestView[] {
    return [...this.pending.values()].map(p => p.view)
  }

  /** Route one `can_use_tool` request to the panel. */
  present(request: InboundControlRequest): void {
    const inner = request.request
    const toolName = typeof inner.tool_name === 'string' ? inner.tool_name : 'tool'
    const input =
      inner.input && typeof inner.input === 'object'
        ? (inner.input as Record<string, unknown>)
        : {}

    const view: PermissionRequestView = {
      requestId: request.requestId,
      agentId: typeof inner.agent_id === 'string' ? inner.agent_id : undefined,
      toolName:
        typeof inner.display_name === 'string' ? inner.display_name : toolName,
      // Same one-line summary the tool pill uses, so the card and the pill that
      // follows it describe the action identically.
      label: summariseInput(input),
      parameters: prettyParameters(input),
      description: typeof inner.description === 'string' ? inner.description : null,
      // Surfaced because it is usually the reason the engine could not decide by
      // itself — a path outside the workspace — which is exactly what the user
      // needs to know before approving.
      blockedPath: typeof inner.blocked_path === 'string' ? inner.blocked_path : null,
      reason:
        typeof inner.decision_reason === 'string' ? inner.decision_reason : null,
      canAlwaysAllow: toolName !== ASK_USER_QUESTION_TOOL_NAME,
      ...(toolName === ASK_USER_QUESTION_TOOL_NAME && {
        questionInteraction: { questions: parseAskUserQuestions(input) },
      }),
    }

    this.pending.set(request.requestId, {
      requestId: request.requestId,
      toolName,
      toolUseId:
        typeof inner.tool_use_id === 'string' ? inner.tool_use_id : undefined,
      input,
      suggestions: Array.isArray(inner.permission_suggestions)
        ? inner.permission_suggestions
        : [],
      view,
    })

    this.callbacks.onShow(view)
  }

  /**
   * Present a permission request raised by an ATTACHED CLI session.
   *
   * ── WHY THIS IS SEPARATE FROM `present` ────────────────────────────────────────
   *
   * A local request is answered through `ControlClient.respond()` on this panel's own
   * engine. A mirrored one has to travel back over IPC to the process that raised it, so
   * the responder is supplied per-request rather than being the panel's control client.
   *
   * The card itself is built the same way, so a mirrored request is indistinguishable
   * from a local one on screen — which is the point: the user should not have to know
   * which process is asking in order to answer.
   */
  presentMirrored(
    request: {
      requestId: string
      toolName: string
      input: unknown
      toolUseId?: string
      description?: string
    },
    respond: (response: unknown) => void,
  ): void {
    const input =
      request.input && typeof request.input === 'object'
        ? (request.input as Record<string, unknown>)
        : {}

    const view: PermissionRequestView = {
      requestId: request.requestId,
      toolName: request.toolName,
      label: summariseInput(input),
      parameters: prettyParameters(input),
      description: request.description ?? null,
      blockedPath: null,
      reason: null,
      // The IPC decision payload has no "update permissions" channel, so offering
      // "always allow" here would present a choice that silently degrades to once.
      canAlwaysAllow: false,
      ...(request.toolName === ASK_USER_QUESTION_TOOL_NAME && {
        questionInteraction: { questions: parseAskUserQuestions(input) },
      }),
    }

    this.pending.set(request.requestId, {
      requestId: request.requestId,
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      input,
      suggestions: [],
      view,
      respondRemotely: respond,
    })

    this.callbacks.onShow(view)
  }

  /**
   * Remove a card without answering it.
   *
   * Used when an attached session reports the request was withdrawn, or was answered on
   * ANOTHER attached interface. Deliberately does not send a decision: the request is
   * already settled, and fabricating one here could allow a tool the user denied
   * elsewhere.
   */
  dismiss(requestId: string): void {
    if (!this.pending.delete(requestId)) return
    this.callbacks.onDismiss(requestId)
  }

  /**
   * Answer a card.
   *
   * `control.respond()` itself refuses ids it no longer holds, so a double-click or a
   * decision racing a cancellation cannot produce two answers for one gate.
   */
  resolve(
    control: ControlClient | null,
    requestId: string,
    decision: PermissionDecision,
  ): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    // AskUserQuestion must be answered by the question form. A generic allow would
    // echo the input without `answers`, which the tool interprets as an empty reply.
    if (
      entry.toolName === ASK_USER_QUESTION_TOOL_NAME &&
      decision.kind !== 'deny'
    ) return
    this.pending.delete(requestId)
    this.callbacks.onDismiss(requestId)

    // A mirrored request goes back to the process that raised it. The session's own
    // pending-decision map deletes the handler before running it, so a decision made
    // simultaneously on another interface cannot be applied twice.
    if (entry.respondRemotely) {
      entry.respondRemotely(
        decision.kind === 'deny'
          ? { behavior: 'deny', message: 'The user denied this from the editor.' }
          : { behavior: 'allow', updatedInput: entry.input },
      )
      return
    }

    if (!control) return

    if (decision.kind === 'deny') {
      control.respond(requestId, {
        behavior: 'deny',
        // Required by the schema. Phrased as the user's decision because the engine
        // shows it to the model, which then has to explain why it stopped.
        message: 'The user declined to run this tool.',
        decisionClassification: 'user_reject',
      })
      return
    }

    control.respond(requestId, {
      behavior: 'allow',
      // REQUIRED. Echoed unchanged: this UI does not offer input editing, and
      // omitting the field fails validation, which the engine reads as a denial.
      updatedInput: entry.input,
      ...(decision.kind === 'allow-always'
        ? {
            decisionClassification: 'user_permanent',
            // The engine's own suggestions are replayed rather than invented here:
            // it knows the rule shape that matches what it asked about, and a
            // hand-built rule risks being broader than the user agreed to.
            ...(entry.suggestions.length > 0
              ? { updatedPermissions: entry.suggestions }
              : {}),
          }
        : { decisionClassification: 'user_temporary' }),
    })
  }

  /** Answer AskUserQuestion through the same updatedInput contract as the CLI. */
  resolveQuestions(
    control: ControlClient | null,
    requestId: string,
    answers: Record<string, string>,
    notes: Record<string, string>,
  ): { toolUseId?: string; answers: Record<string, string> } | null {
    const entry = this.pending.get(requestId)
    if (!entry || entry.toolName !== ASK_USER_QUESTION_TOOL_NAME) return null

    const updatedInput = buildAskUserQuestionInput(entry.input, answers, notes)
    if (!updatedInput) return null

    this.pending.delete(requestId)
    this.callbacks.onDismiss(requestId)
    const response = {
      behavior: 'allow' as const,
      updatedInput,
      decisionClassification: 'user_temporary' as const,
    }
    if (entry.respondRemotely) entry.respondRemotely(response)
    else control?.respond(requestId, response)

    return {
      toolUseId: entry.toolUseId,
      answers: updatedInput.answers as Record<string, string>,
    }
  }

  /**
   * The engine withdrew a request — it resolved the decision another way.
   *
   * Dismiss only. Answering afterwards would be a decision on a gate that is already
   * closed.
   */
  engineCancelled(requestId: string): void {
    if (!this.pending.delete(requestId)) return
    this.callbacks.onDismiss(requestId)
  }

  /**
   * Drop every pending card WITHOUT answering.
   *
   * Called when the panel closes, the engine exits, or a new session starts. See rule
   * 2 in the header: fabricating a denial here would reject a tool the user was
   * mid-way through approving, and would look exactly like the model giving up.
   */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.pending.delete(requestId)
      this.callbacks.onDismiss(requestId)
    }
  }
}

/** Pretty-print parameters for the card, bounded so a huge input cannot fill it. */
function prettyParameters(input: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(input, null, 2)
    return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…[truncated]` : text
  } catch {
    // Circular or non-serialisable. The label still says what it acted on.
    return ''
  }
}
