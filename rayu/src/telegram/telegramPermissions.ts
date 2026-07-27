/**
 * BridgePermissionCallbacks implementation for the Telegram bridge.
 *
 * When the REPL needs a permission decision, it sends the linked chat a formatted
 * card with an inline keyboard — "Allow once", "Always allow", "Deny" — and
 * resolves as soon as the user taps a button. Tapping is the primary flow;
 * typing y/n/always still works as a fallback (see handlePermissionReply) for
 * clients that can't render inline keyboards.
 *
 * Each request gets a short id ("p1", "p2", …) because callback_data is capped at
 * 64 bytes by the Bot API and request ids are UUID-length. The short id maps back
 * to the pending record, so a tap resolves exactly the request it belongs to
 * (the previous text-only flow guessed with "the first pending entry").
 */

import type { BridgePermissionCallbacks, BridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import {
  answerCallbackQuery,
  editMessageWithInlineKeyboard,
  escapeHtml,
  sendMessageWithInlineKeyboard,
  type InlineKeyboard,
} from './telegramApi.js'
import { readTelegramConfig } from './telegramConfig.js'
import { toolIcon } from './formatActivity.js'
import {
  attachQuestionHandler,
  closeQuestionSession,
  hasQuestionSession,
  startQuestionFlow,
} from './telegramQuestions.js'
import {
  attachPlanHandler,
  closePlanSession,
  hasPlanSession,
  startPlanApproval,
} from './telegramPlanApproval.js'

/**
 * Tools whose "permission" is really a form: the decision only means anything
 * when it carries the filled-in input (AskUserQuestion `answers`, ExitPlanMode
 * plan approval, ReviewArtifact `selected`). Persisting an allow rule for these
 * would auto-approve every future call with an EMPTY payload — silently
 * breaking them even in the terminal — so "Always allow" is not offered.
 */
const INTERACTION_TOOLS = new Set<string>([
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  'ReviewArtifact',
])

export function isInteractionTool(toolName: string): boolean {
  return INTERACTION_TOOLS.has(toolName)
}

type ResponseHandler = (r: BridgePermissionResponse) => void

/** callback_data namespace: `perm:<action>:<shortId>` */
const CB_PERM = 'perm:'
type PermAction = 'allow' | 'always' | 'deny'

interface PendingPermission {
  requestId: string
  /** Short, callback_data-safe handle for this request. */
  shortId: string
  toolName: string
  description: string
  input: Record<string, unknown>
  chatId: number
  /** Bot token used to send the prompt, so we can edit/cancel it later. */
  token: string
  /** message_id of the prompt; 0 until the send resolves. */
  messageId: number
  handler?: ResponseHandler
}

const PENDING = new Map<string, PendingPermission>() // requestId → record
const BY_SHORT_ID = new Map<string, string>() // shortId → requestId
let shortIdCounter = 0

const YES_WORDS = new Set(['y', 'yes', 'allow', 'ok', 'approve', '1', 'true'])
const NO_WORDS = new Set(['n', 'no', 'deny', 'reject', 'block', 'cancel', '0', 'false'])
const ALWAYS_WORDS = new Set(['a', 'always', 'allow_always', 'always_allow', 'aa'])

/**
 * sendRequest and onResponse can arrive in either order, so both go through
 * this lazily-created record.
 */
function recordFor(requestId: string): PendingPermission {
  const existing = PENDING.get(requestId)
  if (existing) return existing
  const rec: PendingPermission = {
    requestId,
    shortId: `p${++shortIdCounter}`,
    toolName: '',
    description: '',
    input: {},
    chatId: 0,
    token: '',
    messageId: 0,
  }
  PENDING.set(requestId, rec)
  BY_SHORT_ID.set(rec.shortId, requestId)
  return rec
}

function forget(rec: PendingPermission): void {
  PENDING.delete(rec.requestId)
  BY_SHORT_ID.delete(rec.shortId)
}

/** Build the allow/always/deny response for a decision on a specific tool. */
function responseFor(action: PermAction, toolName: string): BridgePermissionResponse {
  if (action === 'deny') return { behavior: 'deny' }
  if (action === 'allow') return { behavior: 'allow' }
  // "always" — allow this turn AND persist an allow rule for the tool.
  return {
    behavior: 'allow',
    updatedPermissions: toolName
      ? [
          {
            type: 'addRules' as const,
            rules: [{ toolName }],
            behavior: 'allow' as const,
            destination: 'localSettings' as const,
          },
        ]
      : undefined,
  }
}

/**
 * The decision buttons. Two per row keeps the card compact on mobile.
 * "Always allow" is omitted for interaction tools — see INTERACTION_TOOLS.
 */
function permissionKeyboard(shortId: string, toolName = ''): InlineKeyboard {
  const first = [
    { text: '✅ Allow once', callback_data: `${CB_PERM}allow:${shortId}` },
  ]
  if (!isInteractionTool(toolName)) {
    first.push({ text: '♾️ Always allow', callback_data: `${CB_PERM}always:${shortId}` })
  }
  return [first, [{ text: '⛔ Deny', callback_data: `${CB_PERM}deny:${shortId}` }]]
}

/** Truncate a single-line value for display inside the card. */
function clip(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/**
 * Pull the most decision-relevant field out of the tool input — the command for
 * shells, the path for file tools, the query for searches — so the user can tell
 * what they're approving without reading raw JSON.
 */
export function summarizePermissionInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  const pick = (key: string): string =>
    typeof inp[key] === 'string' ? (inp[key] as string) : ''
  const candidate =
    pick('command') ||
    pick('file_path') ||
    pick('path') ||
    pick('notebook_path') ||
    pick('url') ||
    pick('pattern') ||
    pick('query') ||
    pick('prompt')
  return candidate ? clip(candidate, 220) : ''
}

/** Render the permission card as Telegram HTML. */
function formatPermissionPrompt(rec: PendingPermission): string {
  const lines = ['🔐 <b>Permission required</b>', '']
  lines.push(`${toolIcon(rec.toolName)} <b>${escapeHtml(rec.toolName || 'tool')}</b>`)
  const target = summarizePermissionInput(rec.toolName, rec.input)
  if (target) lines.push(`<code>${escapeHtml(target)}</code>`)
  if (rec.description?.trim()) lines.push(`<i>${escapeHtml(clip(rec.description, 300))}</i>`)
  lines.push('', 'Choose an option below:')
  return lines.join('\n')
}

/** Render the card after a decision, with the buttons removed. */
function formatDecision(rec: PendingPermission, action: PermAction): string {
  const verdict =
    action === 'deny'
      ? '⛔ <b>Denied</b>'
      : action === 'always'
        ? '♾️ <b>Allowed — always</b>'
        : '✅ <b>Allowed once</b>'
  const target = summarizePermissionInput(rec.toolName, rec.input)
  const lines = [verdict, '', `${toolIcon(rec.toolName)} <b>${escapeHtml(rec.toolName || 'tool')}</b>`]
  if (target) lines.push(`<code>${escapeHtml(target)}</code>`)
  if (action === 'always') lines.push('', `<i>Saved an allow rule for ${escapeHtml(rec.toolName)}.</i>`)
  return lines.join('\n')
}

/**
 * Handle a tap on a permission button. Returns true when the callback belonged to
 * this module (including expired requests), so the bridge stops routing it.
 */
export async function handlePermissionCallback(
  token: string,
  chatId: number,
  callbackQueryId: string,
  data: string,
): Promise<boolean> {
  if (!data.startsWith(CB_PERM)) return false

  const [action, shortId] = data.slice(CB_PERM.length).split(':')
  if (action !== 'allow' && action !== 'always' && action !== 'deny') {
    await answerCallbackQuery(token, callbackQueryId)
    return true
  }

  const requestId = shortId ? BY_SHORT_ID.get(shortId) : undefined
  const rec = requestId ? PENDING.get(requestId) : undefined
  if (!rec) {
    // Stale card (CLI restarted, or the request was already answered/cancelled).
    await answerCallbackQuery(token, callbackQueryId, 'This request is no longer pending.')
    return true
  }

  const toast =
    action === 'deny' ? '⛔ Denied' : action === 'always' ? '♾️ Always allowed' : '✅ Allowed'
  await answerCallbackQuery(token, callbackQueryId, toast)

  rec.handler?.(responseFor(action, rec.toolName))
  forget(rec)

  if (rec.messageId) {
    // Replace the prompt with the outcome and drop the buttons so the decision
    // can't be double-submitted. Empty array clears reply_markup.
    await editMessageWithInlineKeyboard(
      token,
      chatId,
      rec.messageId,
      formatDecision(rec, action),
      [],
      'HTML',
    ).catch(() => {})
  }
  return true
}

/**
 * Fallback for typed replies (y / n / always) from the linked chat. Kept so the
 * bridge still works if a client can't use inline keyboards.
 *
 * A typed word carries no request id, so it resolves the OLDEST pending request
 * only — resolving all of them meant one "y" silently approved every queued
 * prompt (and, for AskUserQuestion, submitted an empty answer set).
 */
export function handlePermissionReply(text: string): boolean {
  if (PENDING.size === 0) return false
  const lower = text.trim().toLowerCase()

  let action: PermAction | null = null
  if (ALWAYS_WORDS.has(lower)) action = 'always'
  else if (YES_WORDS.has(lower)) action = 'allow'
  else if (NO_WORDS.has(lower)) action = 'deny'
  if (action === null) return false

  // Insertion order === arrival order for a Map, so the first value is oldest.
  const rec = PENDING.values().next().value
  if (!rec) return false
  // "always" on an interaction tool would persist a rule that auto-approves
  // future calls with empty input — downgrade it to a one-shot allow.
  const effective = action === 'always' && isInteractionTool(rec.toolName) ? 'allow' : action
  rec.handler?.(responseFor(effective, rec.toolName))
  forget(rec)
  if (rec.messageId && rec.token) {
    void editMessageWithInlineKeyboard(
      rec.token,
      rec.chatId,
      rec.messageId,
      formatDecision(rec, effective),
      [],
      'HTML',
    ).catch(() => {})
  }
  return true
}

export function createTelegramPermissionCallbacks(token: string): BridgePermissionCallbacks {
  return {
    sendRequest(requestId, toolName, input, _toolUseId, description) {
      const chatId = readTelegramConfig().linkedChatId
      if (chatId === undefined) return

      // AskUserQuestion is a form, not a yes/no: the answers travel back as
      // `updatedInput.answers`. Hand it to the question flow, which renders the
      // real question with option buttons. Everything else keeps the plain
      // permission card below.
      if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
        // onResponse may have already run and parked the handler in PENDING —
        // move it over and drop the placeholder record so nothing is orphaned.
        const parked = PENDING.get(requestId)
        const session = startQuestionFlow({
          requestId,
          chatId,
          token,
          input: input ?? {},
          handler: parked?.handler,
        })
        // A malformed/empty question list falls through to the generic card so
        // the request is still answerable rather than hanging.
        if (session) {
          if (parked) forget(parked)
          return
        }
      }

      // Plan approval gets the plan text plus a mode choice instead of a bare
      // "allow". Falls through to the generic card when there is no plan.
      if (toolName === EXIT_PLAN_MODE_TOOL_NAME) {
        const parked = PENDING.get(requestId)
        const started = startPlanApproval({
          requestId,
          chatId,
          token,
          input: input ?? {},
          handler: parked?.handler,
        })
        if (started) {
          if (parked) forget(parked)
          return
        }
      }

      const rec = recordFor(requestId)
      rec.toolName = toolName
      rec.description = description ?? ''
      rec.input = input ?? {}
      rec.chatId = chatId
      rec.token = token

      void sendMessageWithInlineKeyboard(
        token,
        chatId,
        formatPermissionPrompt(rec),
        permissionKeyboard(rec.shortId, toolName),
        'HTML',
      )
        .then(messageId => {
          // The user may have already tapped (record gone) — don't resurrect it.
          if (PENDING.has(requestId)) rec.messageId = messageId
        })
        .catch(() => {})
    },

    sendResponse(_requestId, _response) {
      // no-op: decisions arrive from the poll loop (button taps / typed replies)
    },

    cancelRequest(requestId) {
      // Interactive cards own their own message; close them without resolving
      // (whoever cancelled us already resolved the tool).
      if (hasQuestionSession(requestId)) {
        void closeQuestionSession(requestId)
        return
      }
      if (hasPlanSession(requestId)) {
        void closePlanSession(requestId)
        return
      }
      const rec = PENDING.get(requestId)
      if (!rec) return
      forget(rec)
      if (rec.messageId && rec.token) {
        void editMessageWithInlineKeyboard(
          rec.token,
          rec.chatId,
          rec.messageId,
          '⏹ <b>Request cancelled</b>',
          [],
          'HTML',
        ).catch(() => {})
      }
    },

    onResponse(requestId, handler) {
      // sendRequest and onResponse can arrive in either order. If an interactive
      // card already owns this request, the handler belongs to it.
      if (attachQuestionHandler(requestId, handler)) {
        return () => {
          void closeQuestionSession(requestId, 'expired')
        }
      }
      if (attachPlanHandler(requestId, handler)) {
        return () => {
          void closePlanSession(requestId)
        }
      }
      recordFor(requestId).handler = handler
      return () => {
        const rec = PENDING.get(requestId)
        if (rec) forget(rec)
      }
    },
  }
}
