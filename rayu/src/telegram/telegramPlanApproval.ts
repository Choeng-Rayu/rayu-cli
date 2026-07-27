/**
 * ExitPlanMode over Telegram.
 *
 * The generic permission card already technically worked for plan approval
 * (allow = plan accepted), but it showed no plan and offered no way to pick the
 * follow-up permission mode or to send the model back to planning with feedback.
 * This card shows the plan and the three decisions that matter remotely.
 *
 * Deliberately a subset of the terminal dialog: no context clearing, no
 * ultraplan hand-off, and none of the auto/bypass mode matrix. Those depend on
 * REPL state that the bridge has no business mutating from a phone tap — if they
 * are ever needed here they should be added explicitly, not inferred.
 */

import type { BridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js'
import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'
import { type InlineKeyboard } from './telegramApi.js'
import { renderTelegramHtml } from './telegramMarkdown.js'
import { interactiveTransport } from './telegramInteractive.js'

/** callback_data namespace: `pl:<action>:<sid>` */
const CB_PLAN = 'pl:'

/** a = approve · e = approve and auto-accept edits · k = keep planning */
export type PlanAction = 'a' | 'e' | 'k'

const PLAN_ACTIONS = new Set<string>(['a', 'e', 'k'])

const MAX_PLAN_CHARS = 3200

interface PlanSession {
  requestId: string
  sid: string
  chatId: number
  token: string
  messageId: number
  plan: string
  /** Set while waiting for "keep planning" feedback via force_reply. */
  awaitingFeedbackFor?: number
  handler?: (response: BridgePermissionResponse) => void
  settled: boolean
}

const SESSIONS = new Map<string, PlanSession>() // requestId → session
const BY_SID = new Map<string, string>() // sid → requestId
let sidCounter = 0

export function encodePlan(action: PlanAction, sid: string): string {
  return `${CB_PLAN}${action}:${sid}`
}

export function parsePlan(
  data: string,
): { action: PlanAction; sid: string } | undefined {
  if (!data.startsWith(CB_PLAN)) return undefined
  const [action, sid] = data.slice(CB_PLAN.length).split(':')
  if (!action || !PLAN_ACTIONS.has(action) || !sid) return undefined
  return { action: action as PlanAction, sid }
}

/** Pull the plan text out of the tool input without trusting its shape. */
export function readPlan(input: unknown): string {
  const plan = (input as { plan?: unknown } | undefined)?.plan
  return typeof plan === 'string' ? plan : ''
}

export function renderPlanCard(plan: string): string {
  const body = renderTelegramHtml(plan.slice(0, MAX_PLAN_CHARS))
  return ['📋 <b>Plan ready for review</b>', '', body].join('\n')
}

export function planKeyboard(sid: string): InlineKeyboard {
  return [
    [{ text: '✅ Approve', callback_data: encodePlan('a', sid) }],
    [{ text: '⚡ Approve + auto-accept edits', callback_data: encodePlan('e', sid) }],
    [{ text: '✏️ Keep planning', callback_data: encodePlan('k', sid) }],
  ]
}

/** Session-scoped mode switch — the same update the terminal dialog sends. */
export function acceptEditsUpdate(): PermissionUpdate[] {
  return [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
}

export function planResponseFor(action: 'a' | 'e'): BridgePermissionResponse {
  if (action === 'e') {
    return { behavior: 'allow', updatedPermissions: acceptEditsUpdate() }
  }
  return { behavior: 'allow' }
}

export function hasPlanSession(requestId: string): boolean {
  return SESSIONS.has(requestId)
}

export function attachPlanHandler(
  requestId: string,
  handler: (response: BridgePermissionResponse) => void,
): boolean {
  const session = SESSIONS.get(requestId)
  if (!session) return false
  session.handler = handler
  return true
}

export function resetPlanSessions(): void {
  SESSIONS.clear()
  BY_SID.clear()
}

export function startPlanApproval(params: {
  requestId: string
  chatId: number
  token: string
  input: Record<string, unknown>
  handler?: (response: BridgePermissionResponse) => void
}): boolean {
  const plan = readPlan(params.input)
  if (!plan.trim()) return false

  const session: PlanSession = {
    requestId: params.requestId,
    sid: `p${++sidCounter}`,
    chatId: params.chatId,
    token: params.token,
    messageId: 0,
    plan,
    settled: false,
    ...(params.handler && { handler: params.handler }),
  }
  SESSIONS.set(session.requestId, session)
  BY_SID.set(session.sid, session.requestId)

  void interactiveTransport()
    .sendCard(
      session.token,
      session.chatId,
      renderPlanCard(plan),
      planKeyboard(session.sid),
    )
    .then(messageId => {
      if (SESSIONS.has(session.requestId)) session.messageId = messageId
    })
    .catch(() => {})
  return true
}

function settle(session: PlanSession, response: BridgePermissionResponse): void {
  if (session.settled) return
  session.settled = true
  SESSIONS.delete(session.requestId)
  BY_SID.delete(session.sid)
  session.handler?.(response)
}

async function closeCard(session: PlanSession, text: string): Promise<void> {
  if (!session.messageId) return
  await interactiveTransport()
    .editCard(session.token, session.chatId, session.messageId, text, [])
    .catch(() => {})
}

/** Close without resolving — the terminal (or an abort) already decided. */
export async function closePlanSession(requestId: string): Promise<boolean> {
  const session = SESSIONS.get(requestId)
  if (!session) return false
  session.settled = true
  SESSIONS.delete(requestId)
  BY_SID.delete(session.sid)
  await closeCard(session, '⏹ <b>Handled in the terminal</b>')
  return true
}

export async function handlePlanCallback(
  token: string,
  chatId: number,
  callbackQueryId: string,
  data: string,
): Promise<boolean> {
  const parsed = parsePlan(data)
  if (!parsed) return false

  const transport = interactiveTransport()
  const requestId = BY_SID.get(parsed.sid)
  const session = requestId ? SESSIONS.get(requestId) : undefined
  if (!session || session.chatId !== chatId) {
    await transport.answerCallback(token, callbackQueryId, 'This plan is no longer pending.')
    return true
  }

  if (parsed.action === 'k') {
    await transport.answerCallback(token, callbackQueryId)
    const promptId = await transport
      .sendForceReply(
        session.token,
        session.chatId,
        '✏️ <b>Keep planning</b>\n\nReply with what should change.',
        'What should change?',
      )
      .catch(() => 0)
    session.awaitingFeedbackFor = promptId
    return true
  }

  await transport.answerCallback(
    token,
    callbackQueryId,
    parsed.action === 'e' ? '⚡ Approved (auto-accept edits)' : '✅ Approved',
  )
  settle(session, planResponseFor(parsed.action))
  await closeCard(
    session,
    parsed.action === 'e'
      ? '⚡ <b>Plan approved</b>\n\n<i>Edits will be auto-accepted for this session.</i>'
      : '✅ <b>Plan approved</b>',
  )
  return true
}

/**
 * Consume the "keep planning" feedback reply. Returns true when the text was
 * used, so the bridge does not enqueue it as a separate turn.
 */
export async function handlePlanTextInput(
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed) return false

  let matched: PlanSession | undefined
  let fallback: PlanSession | undefined
  for (const session of SESSIONS.values()) {
    if (session.chatId !== chatId || session.awaitingFeedbackFor === undefined) continue
    if (replyToMessageId !== undefined && session.awaitingFeedbackFor === replyToMessageId) {
      matched = session
      break
    }
    fallback ??= session
  }
  const session = matched ?? fallback
  if (!session) return false

  session.awaitingFeedbackFor = undefined
  settle(session, { behavior: 'deny', message: trimmed })
  await closeCard(session, '✏️ <b>Back to planning</b>\n\n<i>Your feedback was sent to Rayu.</i>')
  return true
}
