/**
 * AskUserQuestion over Telegram.
 *
 * The tool's answers are not returned by `call()` — they are injected through
 * the permission channel as `updatedInput.answers` (see
 * AskUserQuestionPermissionRequest.tsx, which builds
 * `{ ...input, answers, annotations }` and passes it to `onAllow`). The generic
 * Telegram permission card can only reply allow/deny, so a tap used to resolve
 * the tool with `answers = {}` and the model received "User has answered your
 * questions: ." — this module is the missing half: it renders the real question
 * on the phone and hands the collected answers back in `updatedInput`.
 *
 * One session per permission request. Cards are edited in place (one message for
 * the whole interview) and every `callback_data` stays far below the Bot API's
 * 64-byte cap by referring to a short session handle plus indices.
 *
 * Deliberate gap vs the terminal dialog: the TUI lets the user attach images to
 * an answer (`onAllow(..., contentBlocks)`). `BridgePermissionResponse` has no
 * `contentBlocks` field, so supporting that would mean changing shared
 * permission plumbing. Text answers, "Other", and notes reach full parity.
 */

import type { BridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js'
import { escapeHtml, type InlineKeyboard } from './telegramApi.js'
import { interactiveTransport } from './telegramInteractive.js'

/** callback_data namespace: `q:<action>:<sid>[:<qIndex>[:<optIndex>]]` */
const CB_QUESTION = 'q:'

/** Telegram's hard cap on message text. */
const MAX_CARD_CHARS = 4096

/**
 * o = choose / toggle an option
 * d = done with a multi-select question (commit the draft)
 * s = submit the whole interview from the review card
 * x = answer with free text ("Other")
 * n = attach a note to the current question
 * b = back one question
 * c = cancel (declines the tool)
 */
export type QuestionAction = 'o' | 'd' | 's' | 'x' | 'n' | 'b' | 'c'

const ACTIONS = new Set<string>(['o', 'd', 's', 'x', 'n', 'b', 'c'])

export interface QuestionOptionLike {
  label: string
  description?: string
  preview?: string
}

export interface QuestionLike {
  question: string
  header?: string
  options: QuestionOptionLike[]
  multiSelect?: boolean
}

export interface QuestionSession {
  requestId: string
  /** Short handle used inside callback_data (`k1`, `k2`, …). */
  sid: string
  chatId: number
  token: string
  /** message_id of the card; 0 until the first send resolves. */
  messageId: number
  questions: QuestionLike[]
  /** The tool input we were asked about — answers are merged onto this. */
  input: Record<string, unknown>
  /** question text → final answer (multi-select values joined with ", "). */
  answers: Map<string, string>
  /** question text → free-text note, surfaced as `annotations[q].notes`. */
  notes: Map<string, string>
  /** question text → in-progress multi-select selection. */
  multiDraft: Map<string, Set<string>>
  /** Current question, or `questions.length` for the review card. */
  index: number
  /** Set while we are waiting for a force_reply (free text or note). */
  awaiting?: {
    kind: 'other' | 'note'
    qIndex: number
    /** message_id of the force_reply prompt, matched against reply_to_message. */
    promptMessageId: number
  }
  handler?: (response: BridgePermissionResponse) => void
  settled: boolean
}

const SESSIONS = new Map<string, QuestionSession>() // requestId → session
const BY_SID = new Map<string, string>() // sid → requestId
let sidCounter = 0

const OPTION_BADGES = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣']

// ---------------------------------------------------------------------------
// callback_data codec (pure)
// ---------------------------------------------------------------------------

export function encodeQ(
  action: QuestionAction,
  sid: string,
  qIndex?: number,
  optIndex?: number,
): string {
  const parts = [action, sid]
  if (qIndex !== undefined) parts.push(String(qIndex))
  if (optIndex !== undefined) parts.push(String(optIndex))
  return CB_QUESTION + parts.join(':')
}

export function parseQ(data: string):
  | {
      action: QuestionAction
      sid: string
      qIndex?: number
      optIndex?: number
    }
  | undefined {
  if (!data.startsWith(CB_QUESTION)) return undefined
  const [action, sid, qi, oi] = data.slice(CB_QUESTION.length).split(':')
  if (!action || !ACTIONS.has(action) || !sid) return undefined
  const qIndex = qi === undefined || qi === '' ? undefined : Number(qi)
  const optIndex = oi === undefined || oi === '' ? undefined : Number(oi)
  if (qIndex !== undefined && !Number.isInteger(qIndex)) return undefined
  if (optIndex !== undefined && !Number.isInteger(optIndex)) return undefined
  return { action: action as QuestionAction, sid, qIndex, optIndex }
}

// ---------------------------------------------------------------------------
// Session state machine (pure)
// ---------------------------------------------------------------------------

/**
 * Read `questions` out of an arbitrary tool input. The bridge poll loop must
 * never throw, so anything unexpected degrades to an empty list instead of
 * trusting the shape.
 */
export function parseQuestions(input: unknown): QuestionLike[] {
  const raw = (input as { questions?: unknown } | undefined)?.questions
  if (!Array.isArray(raw)) return []
  const questions: QuestionLike[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const q = item as Record<string, unknown>
    if (typeof q.question !== 'string' || !q.question) continue
    const options: QuestionOptionLike[] = []
    if (Array.isArray(q.options)) {
      for (const optRaw of q.options) {
        if (!optRaw || typeof optRaw !== 'object') continue
        const opt = optRaw as Record<string, unknown>
        if (typeof opt.label !== 'string' || !opt.label) continue
        options.push({
          label: opt.label,
          ...(typeof opt.description === 'string' && {
            description: opt.description,
          }),
          ...(typeof opt.preview === 'string' && { preview: opt.preview }),
        })
      }
    }
    questions.push({
      question: q.question,
      ...(typeof q.header === 'string' && { header: q.header }),
      options,
      multiSelect: q.multiSelect === true,
    })
  }
  return questions
}

export function createSession(params: {
  requestId: string
  chatId: number
  token: string
  input: Record<string, unknown>
  questions?: QuestionLike[]
}): QuestionSession {
  return {
    requestId: params.requestId,
    sid: `k${++sidCounter}`,
    chatId: params.chatId,
    token: params.token,
    messageId: 0,
    questions: params.questions ?? parseQuestions(params.input),
    input: params.input,
    answers: new Map(),
    notes: new Map(),
    multiDraft: new Map(),
    index: 0,
    settled: false,
  }
}

function currentQuestion(session: QuestionSession): QuestionLike | undefined {
  return session.questions[session.index]
}

function draftFor(session: QuestionSession, question: QuestionLike): Set<string> {
  let set = session.multiDraft.get(question.question)
  if (!set) {
    set = new Set()
    session.multiDraft.set(question.question, set)
  }
  return set
}

/**
 * The terminal dialog skips its review step for a single single-select question
 * (`hideSubmitTab` in AskUserQuestionPermissionRequest). Mirror that so simple
 * questions are one tap on the phone too.
 */
export function autoSubmits(session: QuestionSession): boolean {
  return session.questions.length === 1 && !session.questions[0]?.multiSelect
}

export function isReviewing(session: QuestionSession): boolean {
  return session.index >= session.questions.length
}

/** Record a single-select choice (or a free-text answer) and move on. */
export function answerQuestion(
  session: QuestionSession,
  qIndex: number,
  value: string,
): void {
  const question = session.questions[qIndex]
  if (!question) return
  session.answers.set(question.question, value)
  advance(session, qIndex)
}

/** Toggle one option of a multi-select question. */
export function toggleOption(
  session: QuestionSession,
  qIndex: number,
  optIndex: number,
): void {
  const question = session.questions[qIndex]
  const option = question?.options[optIndex]
  if (!question || !option) return
  const draft = draftFor(session, question)
  if (draft.has(option.label)) draft.delete(option.label)
  else draft.add(option.label)
}

/** Add a free-text value to a multi-select draft ("Other" on a multi question). */
export function addDraftValue(
  session: QuestionSession,
  qIndex: number,
  value: string,
): void {
  const question = session.questions[qIndex]
  if (!question) return
  draftFor(session, question).add(value)
}

/**
 * Commit a multi-select draft. Joined with ", " to match the terminal dialog
 * (AskUserQuestionPermissionRequest.tsx: `label.join(", ")`), which the tool's
 * output schema documents as the multi-select format.
 */
export function commitMultiSelect(session: QuestionSession, qIndex: number): boolean {
  const question = session.questions[qIndex]
  if (!question) return false
  const draft = draftFor(session, question)
  if (draft.size === 0) return false
  session.answers.set(question.question, [...draft].join(', '))
  advance(session, qIndex)
  return true
}

export function setNote(session: QuestionSession, qIndex: number, note: string): void {
  const question = session.questions[qIndex]
  if (!question) return
  const trimmed = note.trim()
  if (trimmed) session.notes.set(question.question, trimmed)
}

export function goBack(session: QuestionSession): void {
  session.index = Math.max(0, Math.min(session.index, session.questions.length) - 1)
}

/** Advance to the next unanswered question, or to the review card. */
function advance(session: QuestionSession, fromIndex: number): void {
  for (let i = fromIndex + 1; i < session.questions.length; i++) {
    const q = session.questions[i]
    if (q && !session.answers.has(q.question)) {
      session.index = i
      return
    }
  }
  // Nothing left after this one — fall back to any earlier gap before review.
  for (let i = 0; i < session.questions.length; i++) {
    const q = session.questions[i]
    if (q && !session.answers.has(q.question)) {
      session.index = i
      return
    }
  }
  session.index = session.questions.length
}

export function allAnswered(session: QuestionSession): boolean {
  return session.questions.every(q => session.answers.has(q.question))
}

/**
 * Build the `updatedInput` the tool expects: the original input plus `answers`
 * keyed by question text, plus `annotations` carrying the selected option's
 * preview and any note — exactly the object the terminal dialog submits.
 */
export function buildUpdatedInput(session: QuestionSession): Record<string, unknown> {
  const answers: Record<string, string> = {}
  const annotations: Record<string, { preview?: string; notes?: string }> = {}

  for (const question of session.questions) {
    const answer = session.answers.get(question.question)
    if (answer === undefined) continue
    answers[question.question] = answer
    const selected = question.options.find(opt => opt.label === answer)
    const note = session.notes.get(question.question)
    if (selected?.preview || note) {
      annotations[question.question] = {
        ...(selected?.preview && { preview: selected.preview }),
        ...(note && { notes: note }),
      }
    }
  }

  return {
    ...session.input,
    answers,
    ...(Object.keys(annotations).length > 0 && { annotations }),
  }
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

function clip(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function progressLine(session: QuestionSession, question: QuestionLike): string {
  const total = session.questions.length
  const position = total > 1 ? `Q${session.index + 1}/${total} · ` : ''
  const header = question.header ? escapeHtml(clip(question.header, 24)) : 'Your input'
  return `❓ <b>${position}${header}</b>`
}

/**
 * Render the card for the current question. `compact` drops option descriptions
 * and previews — used as the fallback when the full card exceeds Telegram's
 * 4096-char limit.
 */
export function renderQuestionCard(session: QuestionSession, compact = false): string {
  if (isReviewing(session)) return renderReviewCard(session)
  const question = currentQuestion(session)
  if (!question) return renderReviewCard(session)

  const multi = question.multiSelect === true
  const draft = session.multiDraft.get(question.question)
  const lines = [progressLine(session, question), '']
  lines.push(`<b>${escapeHtml(clip(question.question, 500))}</b>`)
  if (multi) lines.push('<i>Pick any number, then tap Done.</i>')
  lines.push('')

  question.options.forEach((opt, i) => {
    const badge = multi
      ? draft?.has(opt.label)
        ? '☑'
        : '☐'
      : (OPTION_BADGES[i] ?? `${i + 1}.`)
    lines.push(`${badge} <b>${escapeHtml(clip(opt.label, 80))}</b>`)
    if (!compact && opt.description) {
      lines.push(`    <i>${escapeHtml(clip(opt.description, 220))}</i>`)
    }
    if (!compact && opt.preview) {
      // pre/code cannot contain other entities, so the preview goes in raw
      // (escaped) — no nested formatting.
      lines.push(`<pre>${escapeHtml(clip(opt.preview, 400))}</pre>`)
    }
  })

  const note = session.notes.get(question.question)
  if (note) lines.push('', `📝 <i>${escapeHtml(clip(note, 200))}</i>`)

  // Typing is always accepted as a custom answer (see handleQuestionTextInput),
  // so say so — it is the fallback when force_reply doesn't engage.
  lines.push('', '<i>Tap an option, or just send your own answer as a message.</i>')

  return lines.join('\n')
}

export function renderReviewCard(session: QuestionSession): string {
  const lines = ['📋 <b>Review your answers</b>', '']
  for (const question of session.questions) {
    const answer = session.answers.get(question.question)
    lines.push(`• <b>${escapeHtml(clip(question.question, 160))}</b>`)
    lines.push(`    ↳ ${answer ? escapeHtml(clip(answer, 200)) : '<i>not answered</i>'}`)
    const note = session.notes.get(question.question)
    if (note) lines.push(`    📝 <i>${escapeHtml(clip(note, 160))}</i>`)
  }
  lines.push('', '<i>Submit sends these answers back to Rayu.</i>')
  return lines.join('\n')
}

export function renderSummaryCard(session: QuestionSession): string {
  const lines = ['✅ <b>Answers sent to Rayu</b>', '']
  for (const question of session.questions) {
    const answer = session.answers.get(question.question)
    if (answer === undefined) continue
    lines.push(`• <b>${escapeHtml(clip(question.question, 160))}</b>`)
    lines.push(`    ↳ ${escapeHtml(clip(answer, 200))}`)
    const note = session.notes.get(question.question)
    if (note) lines.push(`    📝 <i>${escapeHtml(clip(note, 160))}</i>`)
  }
  return lines.join('\n')
}

export function renderClosedCard(
  reason: 'cancelled' | 'answered-elsewhere' | 'expired',
): string {
  if (reason === 'cancelled') {
    return '⛔ <b>Declined</b>\n\n<i>Rayu was told you did not want to answer.</i>'
  }
  if (reason === 'answered-elsewhere') {
    return '⏹ <b>Answered in the terminal</b>\n\n<i>This card is no longer active.</i>'
  }
  return '⏹ <b>This question is no longer active.</b>'
}

/** Clamp a card to Telegram's limit, preferring the compact form over a hard cut. */
export function fitCard(session: QuestionSession): string {
  const full = renderQuestionCard(session)
  if (full.length <= MAX_CARD_CHARS) return full
  const compact = renderQuestionCard(session, true)
  if (compact.length <= MAX_CARD_CHARS) return compact
  return compact.slice(0, MAX_CARD_CHARS)
}

// ---------------------------------------------------------------------------
// Keyboards (pure)
// ---------------------------------------------------------------------------

/** Keep button labels short — Telegram truncates long ones mid-word on mobile. */
function buttonLabel(badge: string, label: string): string {
  return `${badge} ${clip(label, 28)}`
}

export function questionKeyboard(session: QuestionSession): InlineKeyboard {
  if (isReviewing(session)) return reviewKeyboard(session)
  const question = currentQuestion(session)
  if (!question) return reviewKeyboard(session)

  const multi = question.multiSelect === true
  const draft = session.multiDraft.get(question.question)
  const rows: InlineKeyboard = question.options.map((opt, i) => [
    {
      text: buttonLabel(
        multi ? (draft?.has(opt.label) ? '☑' : '☐') : (OPTION_BADGES[i] ?? `${i + 1}.`),
        opt.label,
      ),
      callback_data: encodeQ('o', session.sid, session.index, i),
    },
  ])

  if (multi) {
    rows.push([
      {
        text: '✅ Done',
        callback_data: encodeQ('d', session.sid, session.index),
      },
    ])
  }

  const extras = [
    {
      text: '✏️ Other…',
      callback_data: encodeQ('x', session.sid, session.index),
    },
    {
      text: '📝 Note',
      callback_data: encodeQ('n', session.sid, session.index),
    },
  ]
  rows.push(extras)

  const tail: InlineKeyboard[number] = []
  if (session.index > 0) {
    tail.push({ text: '⬅ Back', callback_data: encodeQ('b', session.sid) })
  }
  tail.push({ text: '⛔ Cancel', callback_data: encodeQ('c', session.sid) })
  rows.push(tail)

  return rows
}

export function reviewKeyboard(session: QuestionSession): InlineKeyboard {
  const rows: InlineKeyboard = []
  if (allAnswered(session)) {
    rows.push([{ text: '✅ Submit', callback_data: encodeQ('s', session.sid) }])
  }
  rows.push([
    { text: '⬅ Back', callback_data: encodeQ('b', session.sid) },
    { text: '⛔ Cancel', callback_data: encodeQ('c', session.sid) },
  ])
  return rows
}

// ---------------------------------------------------------------------------
// Session registry + I/O
// ---------------------------------------------------------------------------

function register(session: QuestionSession): void {
  SESSIONS.set(session.requestId, session)
  BY_SID.set(session.sid, session.requestId)
}

function forget(session: QuestionSession): void {
  SESSIONS.delete(session.requestId)
  BY_SID.delete(session.sid)
}

export function hasQuestionSession(requestId: string): boolean {
  return SESSIONS.has(requestId)
}

export function getQuestionSession(requestId: string): QuestionSession | undefined {
  return SESSIONS.get(requestId)
}

/** Attach the resolver once `onResponse` arrives (order vs sendRequest varies). */
export function attachQuestionHandler(
  requestId: string,
  handler: (response: BridgePermissionResponse) => void,
): boolean {
  const session = SESSIONS.get(requestId)
  if (!session) return false
  session.handler = handler
  return true
}

/** Test helper — drop all in-flight sessions. */
export function resetQuestionSessions(): void {
  SESSIONS.clear()
  BY_SID.clear()
}

async function paintCard(session: QuestionSession): Promise<void> {
  const text = fitCard(session)
  const keyboard = questionKeyboard(session)
  const transport = interactiveTransport()
  if (session.messageId) {
    await transport
      .editCard(session.token, session.chatId, session.messageId, text, keyboard)
      .catch(() => {})
    return
  }
  const messageId = await transport
    .sendCard(session.token, session.chatId, text, keyboard)
    .catch(() => 0)
  // The user may have already settled it (or it was cancelled) — don't revive.
  if (messageId && SESSIONS.has(session.requestId)) session.messageId = messageId
}

/**
 * Start the Telegram interview for one AskUserQuestion request. Fire-and-forget:
 * `sendRequest` is synchronous, so the first card is painted in the background.
 */
export function startQuestionFlow(params: {
  requestId: string
  chatId: number
  token: string
  input: Record<string, unknown>
  handler?: (response: BridgePermissionResponse) => void
}): QuestionSession | undefined {
  const session = createSession(params)
  if (session.questions.length === 0) return undefined
  if (params.handler) session.handler = params.handler
  register(session)
  void paintCard(session)
  return session
}

function settle(session: QuestionSession, response: BridgePermissionResponse): void {
  if (session.settled) return
  session.settled = true
  forget(session)
  session.handler?.(response)
}

async function submit(session: QuestionSession): Promise<void> {
  const text = renderSummaryCard(session)
  const updatedInput = buildUpdatedInput(session)
  settle(session, { behavior: 'allow', updatedInput })
  await closeCard(session, text)
}

async function closeCard(session: QuestionSession, text: string): Promise<void> {
  if (!session.messageId) return
  await interactiveTransport()
    .editCard(session.token, session.chatId, session.messageId, text, [])
    .catch(() => {})
}

/**
 * Close a session because the decision came from somewhere else (the terminal
 * dialog answered it, or the turn was aborted). Never calls the handler — the
 * other side already resolved.
 */
export async function closeQuestionSession(
  requestId: string,
  reason: 'answered-elsewhere' | 'expired' = 'answered-elsewhere',
): Promise<boolean> {
  const session = SESSIONS.get(requestId)
  if (!session) return false
  session.settled = true
  forget(session)
  await closeCard(session, renderClosedCard(reason))
  return true
}

/**
 * Handle a tap on a question card. Returns true when the callback belonged to
 * this module (including stale cards) so the bridge stops routing it.
 */
export async function handleQuestionCallback(
  token: string,
  chatId: number,
  callbackQueryId: string,
  data: string,
): Promise<boolean> {
  const parsed = parseQ(data)
  if (!parsed) return false

  const transport = interactiveTransport()
  const requestId = BY_SID.get(parsed.sid)
  const session = requestId ? SESSIONS.get(requestId) : undefined
  if (!session || session.chatId !== chatId) {
    await transport.answerCallback(
      token,
      callbackQueryId,
      'This question is no longer active.',
    )
    return true
  }

  const qIndex = parsed.qIndex ?? session.index
  const question = session.questions[qIndex]

  switch (parsed.action) {
    case 'o': {
      const option = question?.options[parsed.optIndex ?? -1]
      if (!question || !option) {
        await transport.answerCallback(token, callbackQueryId)
        break
      }
      if (question.multiSelect) {
        toggleOption(session, qIndex, parsed.optIndex ?? 0)
        await transport.answerCallback(token, callbackQueryId, clip(option.label, 60))
        await paintCard(session)
      } else {
        answerQuestion(session, qIndex, option.label)
        await transport.answerCallback(token, callbackQueryId, `✅ ${clip(option.label, 50)}`)
        if (autoSubmits(session) && allAnswered(session)) {
          await submit(session)
        } else {
          await paintCard(session)
        }
      }
      break
    }
    case 'd': {
      const committed = commitMultiSelect(session, qIndex)
      if (!committed) {
        await transport.answerCallback(token, callbackQueryId, 'Pick at least one option.')
        break
      }
      await transport.answerCallback(token, callbackQueryId, '✅ Saved')
      await paintCard(session)
      break
    }
    case 's': {
      if (!allAnswered(session)) {
        await transport.answerCallback(token, callbackQueryId, 'Some questions are unanswered.')
        break
      }
      await transport.answerCallback(token, callbackQueryId, '✅ Sent')
      await submit(session)
      break
    }
    case 'x':
    case 'n': {
      await transport.answerCallback(token, callbackQueryId)
      await promptForText(session, parsed.action === 'x' ? 'other' : 'note', qIndex)
      break
    }
    case 'b': {
      goBack(session)
      await transport.answerCallback(token, callbackQueryId)
      await paintCard(session)
      break
    }
    case 'c': {
      await transport.answerCallback(token, callbackQueryId, '⛔ Declined')
      settle(session, {
        behavior: 'deny',
        message: 'User declined to answer questions',
      })
      await closeCard(session, renderClosedCard('cancelled'))
      break
    }
  }
  return true
}

async function promptForText(
  session: QuestionSession,
  kind: 'other' | 'note',
  qIndex: number,
): Promise<void> {
  const question = session.questions[qIndex]
  if (!question) return
  const text =
    kind === 'other'
      ? `✏️ <b>Your own answer</b>\n\n<i>${escapeHtml(clip(question.question, 200))}</i>\n\nReply with your answer.`
      : `📝 <b>Add a note</b>\n\n<i>${escapeHtml(clip(question.question, 200))}</i>\n\nReply with anything Rayu should know.`
  const promptMessageId = await interactiveTransport()
    .sendForceReply(
      session.token,
      session.chatId,
      text,
      kind === 'other' ? 'Type your answer' : 'Type your note',
    )
    .catch(() => 0)
  session.awaiting = { kind, qIndex, promptMessageId }
}

/**
 * Consume a text message aimed at an open question card. Returns true when the
 * text was used, so the bridge does not enqueue it as a new turn.
 *
 * Matching is deliberately forgiving, in this order:
 *  1. a reply whose target is our force_reply prompt (the happy path);
 *  2. any session in this chat that is waiting for free text;
 *  3. any session in this chat sitting on a question — typing is treated as the
 *     free-text answer for it.
 *
 * (3) exists because `force_reply` is not dependable: desktop clients and
 * clients where the prompt is no longer the newest message often drop the reply
 * association, so the user's answer arrived with no `reply_to_message` and, with
 * strict matching, fell through to the model as a brand-new turn. Typing is also
 * exactly how the terminal dialog takes a custom answer, so this matches it.
 * The review card is excluded — at that point the user is choosing Submit or
 * Cancel, and swallowing chat there would be surprising.
 */
export async function handleQuestionTextInput(
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed) return false

  let replyMatch: QuestionSession | undefined
  let awaitingMatch: QuestionSession | undefined
  let openMatch: QuestionSession | undefined
  for (const session of SESSIONS.values()) {
    if (session.chatId !== chatId || session.settled) continue
    if (
      session.awaiting &&
      replyToMessageId !== undefined &&
      session.awaiting.promptMessageId === replyToMessageId
    ) {
      replyMatch = session
      break
    }
    if (session.awaiting) awaitingMatch ??= session
    else if (!isReviewing(session)) openMatch ??= session
  }
  const session = replyMatch ?? awaitingMatch ?? openMatch
  if (!session) return false

  // Greedy capture (case 3) must not eat slash commands — a user typing
  // /interrupt while a card is open means the command, not an answer. When the
  // user explicitly asked to type (Other/Note) or replied to our prompt, take
  // the text verbatim so answers that legitimately start with "/" still work.
  const isGreedy = session === openMatch && !session.awaiting
  if (isGreedy && trimmed.startsWith('/')) return false

  // No awaiting record (case 3) → treat it as the answer to the current question.
  const kind = session.awaiting?.kind ?? 'other'
  const qIndex = session.awaiting?.qIndex ?? session.index
  session.awaiting = undefined
  const question = session.questions[qIndex]
  if (!question) return true

  if (kind === 'note') {
    setNote(session, qIndex, trimmed)
    await paintCard(session)
    return true
  }

  if (question.multiSelect) {
    addDraftValue(session, qIndex, trimmed)
    await paintCard(session)
    return true
  }

  answerQuestion(session, qIndex, trimmed)
  if (autoSubmits(session) && allAnswered(session)) {
    await submit(session)
  } else {
    await paintCard(session)
  }
  return true
}
