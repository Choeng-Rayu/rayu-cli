// DeepSeek Web client adapter.
//
// Wraps chat.deepseek.com's internal web API behind the Anthropic SDK surface
// that claude.ts depends on (client.beta.messages.create). Handles:
//   1. Chat session creation (POST /api/v0/chat_session/create) — reused across turns
//   2. PoW challenge + solve (POST /api/v0/chat/create_pow_challenge)
//   3. Completion + SSE stream parsing (POST /api/v0/chat/completion)
//
// CHATBOT-ONLY: The DeepSeek web API takes a plain prompt string — no tools, no
// function calling, no system prompt. We extract ONLY the last user message and
// send it as-is. All tool schemas and system instructions are discarded to avoid
// account flagging by DeepSeek's audit systems. The chat session is reused across
// turns so the conversation thread stays intact on DeepSeek's side.
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
// ---------------------------------------------------------------------------

const SESSION_FILE = 'deepseek-web-session.json'

function sessionPath(): string {
  return join(getRayuConfigHomeDir(), SESSION_FILE)
}

function readCachedSessionId(): string | null {
  try {
    const p = sessionPath()
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as { sessionId: string }
    return data.sessionId || null
  } catch {
    return null
  }
}

function writeCachedSessionId(id: string): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(sessionPath(), JSON.stringify({ sessionId: id }), { mode: 0o600 })
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
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: true,
      search_enabled: false,
    }),
    signal,
  })
}

// ---------------------------------------------------------------------------
// Message extraction: only the user's latest message, nothing else
// ---------------------------------------------------------------------------

type AnthropicMessage = {
  role: string
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
}

/**
 * Extract ONLY the last user message text. System prompts, tool schemas,
 * conversation history, and all agentic instructions are discarded.
 * This is a plain chatbot — no tools, no system context, no multi-turn.
 */
function extractUserPrompt(messages: AnthropicMessage[]): string {
  // Walk backwards to find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('\n')
    if (content) return content
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

        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === '[DONE]') continue

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

  // Dedup with lock-first ordering: set _inFlight BEFORE any async work so
  // concurrent callers serialize rather than both entering the API call.
  // The first caller streams live; subsequent callers within the window get
  // a buffered replay.
  let _inFlight: Promise<void> | null = null
  let _lastPrompt = ''
  let _lastBufferedAt = 0
  let _lastEvents: StreamEvent[] | null = null
  let _lastModel = ''
  const DEDUP_WINDOW_MS = 5000

  function replayedStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
    let i = 0
    return (async function* () {
      for (; i < events.length; i++) yield events[i]
    })()
  }

  async function doCompletion(
    params: BetaParams,
    signal?: AbortSignal,
  ): Promise<{ stream: AsyncGenerator<StreamEvent>; model: string }> {
    const model = params.model || defaultModel
    const prompt = extractUserPrompt(params.messages)

    // 1. Dedup hit: same prompt within window → replay buffered events.
    if (prompt === _lastPrompt && _lastEvents && Date.now() - _lastBufferedAt < DEDUP_WINDOW_MS) {
      return { stream: replayedStream(_lastEvents), model: _lastModel }
    }

    // 2. If a call is in flight, wait for it, then re-check (will hit dedup).
    if (_inFlight) {
      await _inFlight
      return doCompletion(params, signal)
    }

    // 3. Lock FIRST, then execute. This is the critical fix: setting _inFlight
    //    before any await means the second caller sees it and waits at step 2.
    let release: () => void
    _inFlight = new Promise<void>(r => { release = r! })

    // Safety: release lock on abort so the next caller doesn't hang forever.
    const onAbort = () => {
      if (_inFlight) { _inFlight = null; release!() }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // Make the API call (session + PoW + completion).
      const sessionId = await getOrCreateChatSession(userToken, cookie)
      const challenge = await fetchPowChallenge(userToken, cookie)
      const powResponse = await solvePowChallenge(challenge)

      const response = await postCompletion(
        userToken, cookie, sessionId, prompt, powResponse, signal,
      )

      if (!response.ok) {
        // Session stale? Clear and retry once.
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          clearDeepseekWebSession()
          _inFlight = null
          release!()
          signal?.removeEventListener('abort', onAbort)
          return doCompletion(params, signal)
        }
        const errText = await response.text().catch(() => 'unknown')
        throw new Error(
          `DeepSeek Web: completion failed (${response.status}): ${errText.slice(0, 500)}`,
        )
      }

      // Tee: live stream to the first consumer + buffer for dedup replays.
      const rawStream = parseSSEStream(response, model)
      const events: StreamEvent[] = []

      async function* teeStream(): AsyncGenerator<StreamEvent> {
        try {
          for await (const event of rawStream) {
            events.push(event)
            yield event
          }
        } finally {
          _lastPrompt = prompt
          _lastBufferedAt = Date.now()
          _lastEvents = events
          _lastModel = model
          if (_inFlight) { _inFlight = null; release!() }
          signal?.removeEventListener('abort', onAbort)
        }
      }

      return { stream: teeStream(), model }
    } catch (err) {
      _inFlight = null
      release!()
      signal?.removeEventListener('abort', onAbort)
      throw err
    }
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
          data: AsyncGenerator<StreamEvent>
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
