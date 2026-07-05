// DeepSeek Web client adapter.
//
// Wraps chat.deepseek.com's internal web API behind the Anthropic SDK surface
// that claude.ts depends on (client.beta.messages.create). Handles:
//   1. Chat session creation (POST /api/v0/chat_session/create) — reused across turns
//   2. PoW challenge + solve (POST /api/v0/chat/create_pow_challenge)
//   3. Completion + SSE stream parsing (POST /api/v0/chat/completion)
//
// CHATBOT-ONLY: The DeepSeek web API takes a plain prompt string — no tools, no
// function calling, no system prompt, no roles array. We forward ONLY the
// user's current, literal message (see extractUserPrompt) — no client-side
// history reconstruction. Continuity across turns is DeepSeek's OWN job: its
// chat_session_id plus server-side thread linking (parent_message_id,
// chained from the previous turn's response_message_id — see the session
// cache below) carry context, not this client replaying a transcript. Tool
// schemas and system instructions are fully discarded to avoid account
// flagging by DeepSeek's audit systems.
//
// GATED: requires USE_RAYU_OAUTH=true (Rayu account login enabled) AND
// USE_DEEPSEEK_OAUTH=true. Both must be on. Also requires a paid Rayu plan.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { solvePowChallenge, type PowChallenge } from './deepseekWebPow.js'
import { getRayuConfigHomeDir } from '../../../utils/envUtils.js'

// ---------------------------------------------------------------------------
// Env-driven config (matches .env: DEEPSEEK_OAUTH_WEB_*)
// ---------------------------------------------------------------------------

function getDeepseekToken(): string {
  return process.env.DEEPSEEK_OAUTH_WEB_TOKEN || ''
}

function getDeepseekCookie(): string {
  return process.env.DEEPSEEK_OAUTH_WEB_COOKIE || ''
}

function getDeepseekModel(): string {
  return process.env.DEEPSEEK_OAUTH_WEB_MODEL || 'deepseek-v4-pro-1m'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEPSEEK_WEB_ORIGIN = 'https://chat.deepseek.com'
const DEEPSEEK_WEB_API = `${DEEPSEEK_WEB_ORIGIN}/api/v0`

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

function getAuthHeaders(
  userToken: string,
  cookie?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    authorization: `Bearer ${userToken}`,
    'content-type': 'application/json',
    origin: DEEPSEEK_WEB_ORIGIN,
    referer: `${DEEPSEEK_WEB_ORIGIN}/`,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    'x-app-version': '20241129.1',
    'x-client-locale': 'en_US',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0-always',
  }
  const c = cookie || getDeepseekCookie()
  if (c) headers['cookie'] = c
  return headers
}

// ---------------------------------------------------------------------------
// Chat session cache — persisted to disk so it survives process restarts.
// Maps 1:1 to a chat.deepseek.com tab; reuse across turns so DeepSeek sees
// a real conversation thread instead of isolated single-turn prompts.
//
// Also carries `lastResponseMessageId`: DeepSeek's own thread-linking field.
// The completion stream's `event: ready` frame reports
// {request_message_id, response_message_id} for the turn about to run; the
// NEXT turn sends that response_message_id back as `parent_message_id`
// (instead of always null) so DeepSeek's server links the two turns into one
// thread. This — not client-side prompt reconstruction — is how continuity
// across turns is meant to work for this endpoint.
// ---------------------------------------------------------------------------

const SESSION_FILE = 'deepseek-web-session.json'

type SessionCache = {
  sessionId: string
  lastResponseMessageId?: number | null
}

function sessionPath(): string {
  return join(getRayuConfigHomeDir(), SESSION_FILE)
}

function readSessionCache(): SessionCache | null {
  try {
    const p = sessionPath()
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as SessionCache
    return data.sessionId ? data : null
  } catch {
    return null
  }
}

function readCachedSessionId(): string | null {
  return readSessionCache()?.sessionId ?? null
}

function writeCachedSessionId(id: string): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(
    sessionPath(),
    JSON.stringify({ sessionId: id, lastResponseMessageId: null }),
    { mode: 0o600 },
  )
}

/** Persist the response_message_id this turn returned, for the next turn's
 * parent_message_id. Best-effort: a write failure just means the next turn
 * starts a fresh sub-thread (parent_message_id: null) instead of erroring. */
function writeLastResponseMessageId(id: number | null): void {
  try {
    const cur = readSessionCache()
    if (!cur) return
    writeFileSync(
      sessionPath(),
      JSON.stringify({ ...cur, lastResponseMessageId: id }),
      { mode: 0o600 },
    )
  } catch {
    // best-effort
  }
}

/** Forget the cached session — the next call creates a fresh chat tab. */
export function clearDeepseekWebSession(): void {
  try { unlinkSync(sessionPath()) } catch { /* ok if absent */ }
}

// Mutex for session creation — prevents duplicate sessions when parallel API
// calls (e.g. verifyApiKey + main query) both hit getOrCreateChatSession
// before either writes the session to disk.
let _sessionMutex: Promise<void> = Promise.resolve()

async function getOrCreateChatSession(
  userToken: string,
  cookie?: string,
): Promise<string> {
  const cached = readCachedSessionId()
  if (cached) return cached

  // Serialize session creation so only one POST /chat_session/create fires.
  const prev = _sessionMutex
  let release: () => void
  _sessionMutex = new Promise<void>(r => { release = r })
  await prev

  try {
    // Re-check cache — a concurrent call may have written it while we waited.
    const cachedAfter = readCachedSessionId()
    if (cachedAfter) return cachedAfter

    const res = await fetch(`${DEEPSEEK_WEB_API}/chat_session/create`, {
      method: 'POST',
      headers: getAuthHeaders(userToken, cookie),
      body: JSON.stringify({ character_id: null }),
    })
    const json = (await res.json()) as {
      data?: { biz_data?: { id?: string } }
    }
    const id = json?.data?.biz_data?.id
    if (!id) {
      throw new Error(
        `DeepSeek Web: failed to create chat session — status ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
      )
    }
    writeCachedSessionId(id)
    return id
  } finally {
    release!()
  }
}

// ---------------------------------------------------------------------------
// PoW challenge
// ---------------------------------------------------------------------------

async function fetchPowChallenge(
  userToken: string,
  cookie?: string,
): Promise<PowChallenge> {
  const res = await fetch(`${DEEPSEEK_WEB_API}/chat/create_pow_challenge`, {
    method: 'POST',
    headers: getAuthHeaders(userToken, cookie),
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  })
  const json = (await res.json()) as {
    data?: { biz_data?: { challenge?: PowChallenge } }
  }
  const challenge = json?.data?.biz_data?.challenge
  if (!challenge?.challenge) {
    throw new Error(
      `DeepSeek Web: failed to get PoW challenge — status ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
    )
  }
  return challenge
}

async function postCompletion(
  userToken: string,
  cookie: string | undefined,
  chatSessionId: string,
  parentMessageId: number | null,
  prompt: string,
  powResponse: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = getAuthHeaders(userToken, cookie)
  headers['x-ds-pow-response'] = powResponse

  return fetch(`${DEEPSEEK_WEB_API}/chat/completion`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      prompt,
      ref_file_ids: [],
      thinking_enabled: true,
      search_enabled: false,
    }),
    signal,
  })
}

// ---------------------------------------------------------------------------
// Message extraction: flatten the conversation into one prompt string
// ---------------------------------------------------------------------------

type AnthropicMessage = {
  role: string
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
}

/**
 * Strip harness-injected scaffolding that claude.ts/messages.ts attach to
 * message content for every provider — tool-availability listings and
 * system reminders (skill catalogs, file-read warnings, IDE context, RAYU.md,
 * etc.). These are meant for the model's internal bookkeeping, not visible
 * chat content, and DeepSeek Web has no tools/skills/system-prompt concept at
 * all (see the CHATBOT-ONLY note at the top of this file). Without this, the
 * single message actually forwarded could still be prefixed/suffixed with
 * hundreds of lines of tool/skill catalog text riding inside the same
 * content string as the real human text.
 *
 * Mirrors the existing `<system-reminder>` strip in queryHelpers.ts (same
 * regex) and extends it to `<available-deferred-tools>` (injected by
 * claude.ts) — the two tag-wrapped injection points that can appear inside
 * plain user-message text for this harness.
 */
function stripHarnessInjections(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/g, '')
    .trim()
}

/**
 * True when a message's ENTIRE text is a harness-internal fork prompt rather
 * than something the human typed — e.g. the IDE/TUI "prompt suggestion"
 * feature (predicting what the user might type next) forks a SEPARATE agent
 * call whose message list is [...real conversation so far, ONE internal
 * instruction message], and that instruction message becomes the "last user
 * message" extractUserPrompt would otherwise forward verbatim. Unlike
 * <system-reminder>/<available-deferred-tools> (embedded INSIDE a real
 * message's text — see stripHarnessInjections), this is the message's ENTIRE
 * content, so it can't be stripped down to remaining human text — it must be
 * skipped so extractUserPrompt keeps walking backward to the real turn.
 *
 * Detected structurally (the prompt's own distinctive framing), not by
 * hardcoding the exact wording, since these internal prompts are authored/
 * maintained elsewhere in the harness and could be reworded over time:
 *   - starts with the "[SUGGESTION MODE:" marker (its defining, load-bearing
 *     prefix — every other file in the harness that touches this feature
 *     keys off this exact bracketed tag), OR
 *   - carries multiple internal-meta-instruction phrases together (the kind
 *     of imperative self-referential language ("NEVER SUGGEST", "Reply with
 *     ONLY the suggestion", "Format: 2-12 words") a human chatting would not
 *     plausibly type as their own message).
 */
function isHarnessInternalForkPrompt(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith('[SUGGESTION MODE:')) return true
  const metaMarkers = [
    /never suggest/i,
    /reply with only the suggestion/i,
    /stay silent if the next step/i,
  ]
  const hits = metaMarkers.reduce((n, re) => (re.test(trimmed) ? n + 1 : n), 0)
  return hits >= 2
}

/**
 * Extract ONLY the latest user message's text — nothing else. No history,
 * no tools, no system prompt, no assistant turns.
 *
 * DESIGN: DeepSeek Web is a plain chatbot with its own session
 * (chat_session_id) and its own server-side thread (parent_message_id,
 * chained via getOrCreateChatSession/getResponseMessageId below). Continuity
 * across turns is DeepSeek's job, not this client's: the client's only
 * responsibility is to forward the human's current message as-is and let
 * DeepSeek's own session/thread carry context. Reconstructing history
 * client-side (an earlier version of this function did that) fights the
 * grain of the actual API and reintroduces exactly the kind of
 * harness-shaped complexity (tool lists, system reminders, multi-turn
 * flattening) DeepSeek Web was never meant to see — it is explicitly a
 * "chat with the user's literal message" endpoint, nothing more.
 *
 * Still strips <available-deferred-tools>/<system-reminder> noise (see
 * stripHarnessInjections) since even the single forwarded message can carry
 * that scaffolding embedded in its own text, and SKIPS whole messages that
 * are themselves a harness-internal fork prompt (see
 * isHarnessInternalForkPrompt) rather than something the human typed — e.g.
 * the IDE's prompt-suggestion feature appends its own instruction message as
 * the "last user message" of a background fork call; that message must never
 * be sent to DeepSeek as if it were the human's chat input.
 */
function extractUserPrompt(messages: AnthropicMessage[]): string {
  const blockText = (
    content: AnthropicMessage['content'],
  ): string => {
    if (typeof content === 'string') return stripHarnessInjections(content)
    return content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => stripHarnessInjections(c.text as string))
      .filter(Boolean)
      .join('\n')
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    const text = blockText(msg.content)
    if (!text) continue
    if (isHarnessInternalForkPrompt(text)) continue
    return text
  }
  return 'Hello'
}

// ---------------------------------------------------------------------------
// SSE stream parser: DeepSeek JSON-patch → Anthropic stream events
// ---------------------------------------------------------------------------

type StreamEvent =
  | { type: 'message_start'; message: { id: string; model: string; role: string } }
  | { type: 'content_block_start'; index: number; content_block: { type: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; thinking?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null }; usage: { output_tokens: number } }
  | { type: 'message_stop' }
  // Internal-only (not Anthropic-shaped): carries the response_message_id
  // DeepSeek assigned to this turn's assistant reply, from the `event: ready`
  // SSE frame. doCompletion() consumes and strips this before the stream
  // reaches claude.ts, persisting it as the NEXT turn's parent_message_id so
  // DeepSeek's own server links the two turns into one thread — this is what
  // carries continuity across turns, not client-side history reconstruction.
  | { type: '__ready'; responseMessageId: number | null }

/** The Anthropic-shaped subset actually exposed to callers (claude.ts) — the
 * internal-only `__ready` bookkeeping event is consumed and stripped inside
 * doCompletion()'s teeStream before anything is yielded or buffered. */
type PublicStreamEvent = Exclude<StreamEvent, { type: '__ready' }>

async function* parseSSEStream(
  response: Response,
  model: string,
): AsyncGenerator<StreamEvent> {
  if (!response.body) {
    throw new Error('DeepSeek Web: response has no body')
  }

  const messageId = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  let textIndex = -1
  let currentCursor: string | null = null
  let textStarted = false
  let started = false
  // Set true once the FINISHED branch below has already yielded the closing
  // content_block_stop/message_delta/message_stop sequence for this turn, so
  // the post-loop cleanup (for streams that end WITHOUT an explicit FINISHED
  // marker) never re-yields that sequence a second time. Before this fix, a
  // normal turn — which always sends FINISHED — got the closing sequence
  // TWICE: once from the FINISHED branch, once from the unconditional
  // post-loop fallback, which showed up as extra/duplicated trailing events.
  let finished = false
  let buffer = ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let doubleNewline: number
      while ((doubleNewline = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, doubleNewline)
        buffer = buffer.slice(doubleNewline + 2)

        // SSE blocks may carry a named `event:` line alongside `data:`. Only
        // the `ready` event matters here — it reports
        // {request_message_id, response_message_id} for the turn that is
        // about to run, which we need for the NEXT turn's parent_message_id.
        let eventName: string | null = null
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
            continue
          }
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === '[DONE]') continue

          if (eventName === 'ready') {
            try {
              const readyPayload = JSON.parse(raw) as {
                response_message_id?: number
              }
              yield {
                type: '__ready',
                responseMessageId:
                  typeof readyPayload.response_message_id === 'number'
                    ? readyPayload.response_message_id
                    : null,
              }
            } catch {
              // skip malformed ready frame — parent_message_id chaining is
              // best-effort; a miss just means the next turn starts fresh.
            }
            continue
          }

          try {
            const parsed = JSON.parse(raw) as { p?: string; v?: string }

            if (typeof parsed.p === 'string') {
              currentCursor = parsed.p
            }

            const value = parsed.v
            if (typeof value !== 'string') continue

            if (currentCursor === 'response/thinking_content') {
              // DeepSeek Web is intentionally requested with
              // thinking_enabled:true (postCompletion) because it tends to
              // produce a better final answer, but this is a CHATBOT-ONLY
              // provider with no way for the user to toggle a visible
              // reasoning trace. Surfacing the thinking trace as its own
              // content block made claude.ts (correctly, per its generic
              // content_block_stop handling) yield it as a SEPARATE assistant
              // message from the final answer — i.e. the user saw two
              // response bubbles per turn ("first for thinking, second for
              // message"). Deliberately swallow thinking chunks here so only
              // the final `response/content` text ever becomes a content
              // block: the reasoning is still generated server-side (helping
              // answer quality) but never streamed out as a visible message.
              continue
            } else if (currentCursor === 'response/content') {
              if (!started) {
                started = true
                yield {
                  type: 'message_start',
                  message: { id: messageId, model, role: 'assistant' },
                }
              }
              if (!textStarted) {
                textStarted = true
                textIndex++
                yield {
                  type: 'content_block_start',
                  index: textIndex,
                  content_block: { type: 'text' },
                }
              }
              yield {
                type: 'content_block_delta',
                index: textIndex,
                delta: { type: 'text_delta', text: value },
              }
            } else if (currentCursor === 'response/status' && value === 'FINISHED') {
              if (textStarted) {
                yield { type: 'content_block_stop', index: textIndex }
              }
              yield {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 0 },
              }
              yield { type: 'message_stop' }
              finished = true
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    }

    // Fallback ONLY for a stream that ends (reader exhausted) without ever
    // sending an explicit FINISHED status — a normal turn already closed out
    // via the FINISHED branch above and must not be closed a second time here.
    if (started && !finished) {
      if (textStarted) {
        yield { type: 'content_block_stop', index: textIndex }
      }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      }
      yield { type: 'message_stop' }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

type BetaParams = {
  model: string
  max_tokens?: number
  system?: string | Array<{ type: string; text?: string }>
  messages: AnthropicMessage[]
  tools?: Array<Record<string, unknown>>
  tool_choice?: Record<string, unknown>
  temperature?: number
  stream?: boolean
  metadata?: Record<string, unknown>
}

type BetaMessage = {
  id: string
  model: string
  role: string
  content: Array<{ type: string; text?: string; thinking?: string }>
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number }
}

// ---------------------------------------------------------------------------
// Main client factory
// ---------------------------------------------------------------------------

export function createDeepseekWebClient(
  provider: { apiKey?: string; defaultModel?: string },
  _maxRetries: number,
) {
  const userToken =
    provider.apiKey?.trim() || getDeepseekToken()
  if (!userToken) {
    throw new Error(
      'DeepSeek Web: no auth token configured. Set DEEPSEEK_OAUTH_WEB_TOKEN in .env or run /connect → DeepSeek Web to enter your userToken from chat.deepseek.com.',
    )
  }
  const cookie = getDeepseekCookie() || undefined
  const defaultModel =
    provider.defaultModel || getDeepseekModel() || 'deepseek-v4-pro-1m'

  void _maxRetries

  async function doCompletion(
    params: BetaParams,
    signal?: AbortSignal,
  ): Promise<{ stream: AsyncGenerator<PublicStreamEvent>; model: string }> {
    const model = params.model || defaultModel
    const prompt = extractUserPrompt(params.messages)

    // Make the API call (session + PoW + completion).
    const sessionId = await getOrCreateChatSession(userToken, cookie)
    // DeepSeek's own thread-linking field: the response_message_id the
    // PREVIOUS turn's `event: ready` frame reported becomes THIS turn's
    // parent_message_id, so DeepSeek's server links the two into one
    // thread. null on the very first turn of a session (or if a previous
    // turn's ready frame was missed) — DeepSeek treats that as a new
    // sub-thread root, same as before this feature existed.
    const cachedParentMessageId = readSessionCache()?.lastResponseMessageId ?? null
    const challenge = await fetchPowChallenge(userToken, cookie)
    const powResponse = await solvePowChallenge(challenge)

    const response = await postCompletion(
      userToken, cookie, sessionId, cachedParentMessageId, prompt, powResponse, signal,
    )

    if (!response.ok) {
      // Session stale? Clear and retry once.
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        clearDeepseekWebSession()
        return doCompletion(params, signal)
      }
      const errText = await response.text().catch(() => 'unknown')
      throw new Error(
        `DeepSeek Web: completion failed (${response.status}): ${errText.slice(0, 500)}`,
      )
    }

    // FIXES a silent-hang bug: DeepSeek sometimes answers a completion
    // request with HTTP 200 but a plain JSON ERROR object instead of an
    // SSE stream — e.g. {"biz_code":26,"biz_msg":"invalid message id",...}
    // when the cached parent_message_id (from a previous `event: ready`
    // frame) is no longer valid on DeepSeek's side (observed after a large
    // pasted message; likely a TTL/staleness on the server's thread head).
    // response.ok is true (200), so the old code fell through straight
    // into parseSSEStream, which correctly found ZERO "\n\n"-delimited SSE
    // blocks in a flat JSON body and yielded nothing — no thrown error, no
    // visible message, nothing: the turn looked "stuck" with no feedback.
    // Detect this shape up front (by content-type OR by peeking the body)
    // and — since it's cheap to know it was caused by a bad
    // parent_message_id — retry ONCE with parent_message_id reset to null
    // (a fresh sub-thread) rather than surfacing a confusing error for
    // something the client can just recover from transparently.
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const bodyText = await response.text()
      let bizError: { biz_code?: number; biz_msg?: string } | null = null
      try {
        const parsed = JSON.parse(bodyText) as {
          data?: { biz_code?: number; biz_msg?: string }
        }
        if (parsed?.data && typeof parsed.data.biz_code === 'number') {
          bizError = parsed.data
        }
      } catch {
        // not JSON either — fall through to the generic error below
      }
      if (bizError) {
        if (cachedParentMessageId !== null) {
          // Invalidate the stale thread head so the retry (and every turn
          // after it, until a fresh `event: ready` arrives) starts a new
          // sub-thread instead of repeating the same failure forever.
          writeLastResponseMessageId(null)
          return doCompletion(params, signal)
        }
        // Already null and still erroring — a real, non-recoverable
        // server-side rejection (bad prompt, moderation, quota, etc.).
        throw new Error(
          `DeepSeek Web: completion rejected (biz_code ${bizError.biz_code}): ${bizError.biz_msg ?? 'unknown'}`,
        )
      }
      // Not the known error shape either — surface it plainly rather than
      // silently handing non-SSE text to parseSSEStream, which would once
      // again just yield nothing.
      throw new Error(
        `DeepSeek Web: expected an SSE stream but got "${contentType || 'unknown content-type'}": ${bodyText.slice(0, 300)}`,
      )
    }

    // __ready events are consumed HERE (persisted as the next turn's
    // parent_message_id) and never forwarded — they are not part of the
    // Anthropic-shaped surface claude.ts expects.
    const rawStream = parseSSEStream(response, model)

    async function* teeStream(): AsyncGenerator<PublicStreamEvent> {
      for await (const event of rawStream) {
        if (event.type === '__ready') {
          writeLastResponseMessageId(event.responseMessageId)
          continue
        }
        yield event
      }
    }

    return { stream: teeStream(), model }
  }

  async function runNonStreaming(
    params: BetaParams,
    signal?: AbortSignal,
  ): Promise<BetaMessage> {
    const { stream, model } = await doCompletion(params, signal)
    const content: BetaMessage['content'] = []
    let thinkingText = ''
    let outputText = ''
    let stopReason: string | null = null

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_delta': {
          if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            thinkingText += event.delta.thinking
          } else if (event.delta.type === 'text_delta' && event.delta.text) {
            outputText += event.delta.text
          }
          break
        }
        case 'message_delta':
          stopReason = event.delta.stop_reason
          break
      }
    }

    if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText })
    if (outputText) content.push({ type: 'text', text: outputText })

    return {
      id: `ds_${Date.now()}`,
      model,
      role: 'assistant',
      content,
      stop_reason: stopReason,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }

  async function runStreaming(params: BetaParams, signal?: AbortSignal) {
    const { stream } = await doCompletion(params, signal)
    return {
      data: stream,
      request_id: null,
      response: new Response(null, { status: 200 }),
    }
  }

  // Lazy hybrid: a thenable (non-streaming) + .withResponse() (streaming).
  // claude.ts does: await client.beta.messages.create({stream:true}).withResponse()
  //
  // Guard: only ONE call path fires. The first consumer (then/catch/withResponse)
  // wins; subsequent calls see the cached promise. This prevents duplicate API
  // calls when the SDK or retry logic touches both then() and withResponse() on
  // the same object.
  function create(params: BetaParams, opts?: { signal?: AbortSignal }) {
    const signal = opts?.signal
    let _promise: Promise<unknown> | null = null

    function ensurePromise(
      factory: () => Promise<unknown>,
    ): Promise<unknown> {
      if (!_promise) _promise = factory()
      return _promise
    }

    return {
      then(
        onFulfilled?: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) {
        return ensurePromise(() => runNonStreaming(params, signal)).then(
          onFulfilled,
          onRejected,
        )
      },
      catch(onRejected?: (e: unknown) => unknown) {
        return ensurePromise(() => runNonStreaming(params, signal)).catch(
          onRejected,
        )
      },
      withResponse: () => {
        return ensurePromise(() =>
          runStreaming(params, signal),
        ) as Promise<{
          data: AsyncGenerator<PublicStreamEvent>
          request_id: null
          response: Response
        }>
      },
    }
  }

  return {
    beta: { messages: { create } },
  }
}
