// Gemini Code Assist client — gives free Gemini access tied to a Google account
// with NO GCP project/billing, exactly like the Gemini CLI's "Login with Google".
//
// Flow (mirrors gemini-cli packages/core/src/code_assist):
//   1. POST v1internal:loadCodeAssist → resolve `cloudaicompanionProject`.
//   2. If absent, POST v1internal:onboardUser (free tier) and poll until done.
//   3. POST v1internal:generateContent / :streamGenerateContent with the
//      request wrapped as { model, project, request:{…} }. Omitting `project`
//      returns 500, so onboarding is mandatory.
//
// SECURITY: the OAuth bearer token is sent only to cloudcode-pa.googleapis.com;
// never logged.
import { randomUUID } from 'crypto'
import { reportIssue } from '../../../utils/rayuDiagnostics.js'
import {
  readGeminiLoginStore,
  writeGeminiLoginStore,
} from '../../oauth/geminiLogin.js'
import {
  buildGenAIBody,
  toBetaMessageFromGenAI,
  translateGenAIStream,
  type AnyObj,
  type BetaParams,
  type StreamEvent,
} from './genaiTranslate.js'

const ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const API_VERSION = 'v1internal'

const CLIENT_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
}

async function callCodeAssist(
  method: string,
  token: string,
  body: AnyObj,
  signal?: AbortSignal,
  query?: string,
): Promise<Response> {
  const url = `${ENDPOINT}/${API_VERSION}:${method}${query ? `?${query}` : ''}`
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  return globalThis.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * Parse a retry delay (ms) from a Code Assist 429 body — from a RetryInfo
 * `retryDelay: "2s"` or the message "reset after Ns". Exported for testing.
 */
export function parseRetryDelayMs(body: string): number | null {
  const retryInfo = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i)
  if (retryInfo) return Math.ceil(parseFloat(retryInfo[1]) * 1000)
  const reset = body.match(/reset(?:s)?\s+(?:in|after)\s+~?(\d+(?:\.\d+)?)\s*s/i)
  if (reset) return Math.ceil(parseFloat(reset[1]) * 1000)
  return null
}

/**
 * Max seconds to auto-wait for a single 429 reset before surfacing it. The
 * Code Assist consumer endpoint meters by request complexity and a single heavy
 * agentic turn can consume the whole ~40-60s window; gemini-cli simply waits it
 * out and retries. We do the same so heavy tasks succeed (slowly) instead of
 * erroring. Tune/disable via RAYU_GEMINI_MAX_WAIT_S (set 0 to fail fast).
 */
function maxRetryWaitMs(): number {
  const env = parseInt(process.env.RAYU_GEMINI_MAX_WAIT_S || '', 10)
  if (!isNaN(env) && env >= 0) return env * 1000
  return 65_000
}
const MAX_429_RETRIES = 4

/**
 * POST to Code Assist, transparently retrying 429 rate-limit windows the way
 * gemini-cli does (wait the server-indicated reset, then retry). Waits longer
 * than maxRetryWaitMs() (genuine long quota exhaustion) are surfaced instead.
 */
async function callCodeAssistWithRetry(
  method: string,
  token: string,
  body: AnyObj,
  signal?: AbortSignal,
  query?: string,
): Promise<Response> {
  const cap = maxRetryWaitMs()
  for (let attempt = 0; ; attempt++) {
    const res = await callCodeAssist(method, token, body, signal, query)
    if (res.status !== 429 || attempt >= MAX_429_RETRIES || cap <= 0) return res
    const peek = await res.clone().text().catch(() => '')
    // Server-indicated delay, else exponential backoff (1s,2s,4s… capped).
    const delay = parseRetryDelayMs(peek) ?? Math.min(1000 * 2 ** attempt, cap)
    // Genuine long quota exhaustion: surface it instead of hanging.
    if (delay > cap) return res
    await new Promise(r => setTimeout(r, delay + 250))
    if (signal?.aborted) return res
  }
}

type GeminiTier = { id?: string; name?: string; isDefault?: boolean }
type LoadCodeAssistResponse = {
  cloudaicompanionProject?: string
  currentTier?: GeminiTier
  paidTier?: GeminiTier
  allowedTiers?: GeminiTier[]
}

type LROResponse = {
  done?: boolean
  response?: { cloudaicompanionProject?: { id?: string } | string }
}

// gemini-cli UserTierId values.
const TIER_FREE = 'free-tier'
const TIER_LEGACY = 'legacy-tier'

/** Extract a project id from an onboardUser LRO response (string or {id}). */
export function projectIdFromOnboard(op: LROResponse): string | undefined {
  const p = op.response?.cloudaicompanionProject
  if (!p) return undefined
  return typeof p === 'string' ? p : p.id
}

/** The onboarding tier: the default allowed tier, else LEGACY (paid), matching
 *  gemini-cli's getOnboardTier — NOT free-tier, which would cap a paid account. */
export function pickOnboardTier(load: LoadCodeAssistResponse): string {
  const def = load.allowedTiers?.find(t => t.isDefault)?.id
  return def ?? TIER_LEGACY
}

function envProjectId(): string | undefined {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    undefined
  )
}

let cachedProject: string | null = null

/**
 * Resolve the Code Assist `cloudaicompanionProject` for the signed-in account,
 * faithfully mirroring gemini-cli's setupUser so PAID accounts (Google AI Pro /
 * Code Assist Standard) get their real tier instead of being onboarded to free:
 *  - pass GOOGLE_CLOUD_PROJECT + duetProject metadata to loadCodeAssist;
 *  - if `currentTier` is returned, use the server's project (no onboarding);
 *  - otherwise onboard to the DEFAULT allowed tier (LEGACY fallback, not free),
 *    sending the project for non-free tiers and omitting it for free.
 * Cached in-memory and in the login store.
 */
export async function ensureCodeAssistProject(token: string): Promise<string> {
  if (cachedProject) return cachedProject
  const stored = readGeminiLoginStore()?.codeAssistProject
  if (stored) {
    cachedProject = stored
    return stored
  }

  const projectId = envProjectId()
  const metadata = projectId
    ? { ...CLIENT_METADATA, duetProject: projectId }
    : CLIENT_METADATA

  // 1. loadCodeAssist (with project + duetProject so paid entitlements bind).
  const loadRes = await callCodeAssist('loadCodeAssist', token, {
    cloudaicompanionProject: projectId,
    metadata,
  })
  if (!loadRes.ok) {
    const text = await loadRes.text().catch(() => '')
    throw new Error(`Code Assist loadCodeAssist failed ${loadRes.status}: ${text.slice(0, 200)}`)
  }
  const load = (await loadRes.json()) as LoadCodeAssistResponse

  // 2. Paid / already-provisioned accounts: currentTier is set — use the
  //    server-returned project (or env project) directly, NO onboarding (which
  //    would otherwise risk downgrading the account to the free tier).
  if (load.currentTier) {
    const project = load.cloudaicompanionProject || projectId || ''
    cachedProject = project
    const s = readGeminiLoginStore()
    if (s) writeGeminiLoginStore({ ...s, codeAssistProject: project })
    return project
  }

  let project = load.cloudaicompanionProject

  // 3. Otherwise onboard to the default allowed tier (paid LEGACY fallback).
  if (!project) {
    const tierId = pickOnboardTier(load)
    const onboardReq: AnyObj =
      tierId === TIER_FREE
        ? { tierId, cloudaicompanionProject: undefined, metadata: CLIENT_METADATA }
        : { tierId, cloudaicompanionProject: projectId, metadata }
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const obRes = await callCodeAssist('onboardUser', token, onboardReq)
      if (!obRes.ok) {
        const text = await obRes.text().catch(() => '')
        throw new Error(`Code Assist onboardUser failed ${obRes.status}: ${text.slice(0, 200)}`)
      }
      const op = (await obRes.json()) as LROResponse
      const id = projectIdFromOnboard(op)
      if (op.done && id) {
        project = id
        break
      }
      if (op.done) break
      await new Promise(r => setTimeout(r, 2000))
    }
    if (!project) project = projectId
  }

  // Free tier may legitimately operate with an empty project id; cache whatever
  // we resolved (empty string is a valid signal that onboarding completed).
  cachedProject = project ?? ''
  const store = readGeminiLoginStore()
  if (store) writeGeminiLoginStore({ ...store, codeAssistProject: cachedProject })
  return cachedProject
}

export function _resetCodeAssistProjectCacheForTesting(): void {
  cachedProject = null
}

// Stable session id for this Rayu process, mirroring gemini-cli's per-session
// id. Code Assist groups quota/usage by session + prompt; sending these makes
// the backend treat us like the official client instead of anonymous one-off
// calls (which are rate-limited far more aggressively).
const SESSION_ID = randomUUID()

/** Build the v1internal request wrapper, matching gemini-cli's CAGenerateContentRequest:
 *  { model, project, user_prompt_id, request:{…, session_id} }. */
export function buildCodeAssistBody(params: BetaParams, project: string): AnyObj {
  const b = buildGenAIBody(params)
  const request: AnyObj = { contents: b.contents, session_id: SESSION_ID }
  if (b.systemInstruction) {
    request.systemInstruction = { parts: [{ text: b.systemInstruction }] }
  }
  if (b.tools) request.tools = b.tools
  if (Object.keys(b.config).length) request.generationConfig = b.config
  return {
    model: b.model,
    project,
    user_prompt_id: randomUUID(),
    request,
  }
}

/** Parse an SSE byte stream into successive `chunk.response` objects. */
export async function* parseSSEResponses(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnyObj> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const json = line.slice(5).trim()
        if (!json || json === '[DONE]') continue
        try {
          const obj = JSON.parse(json) as { response?: AnyObj }
          if (obj.response) yield obj.response
          else yield obj as AnyObj
        } catch {
          // ignore partial/non-JSON keepalives
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function normalizeError(e: unknown, model: string): Error {
  reportIssue('code_assist.request_failed', 'Code Assist request failed', {
    model,
    error: e instanceof Error ? e.message : String(e),
  })
  const raw = e instanceof Error ? e.message : String(e)
  // 429 RESOURCE_EXHAUSTED that survived auto-retry — a longer quota/rate
  // window. Short RPM throttles are retried transparently (see retry wrapper).
  if (/\b429\b|RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|exhausted your capacity/i.test(raw)) {
    const reset = raw.match(/reset(?:s)?\s+(?:in|after)\s+~?(\d+s)/i)?.[1]
    return new Error(
      `Gemini rate limit reached for "${model}"` +
        (reset ? ` (resets in ~${reset})` : '') +
        `. Short throttles are retried automatically; this one is longer. ` +
        `Preview/pro models have tighter limits — for higher throughput run ` +
        `/model and pick gemini-2.5-flash, or wait for the reset. ` +
        `(Original: ${raw.slice(0, 160)})`,
    )
  }
  // 404 NOT_FOUND on Code Assist almost always means the model id isn't served
  // on this account/tier (Code Assist uses ids like gemini-3-pro-preview,
  // gemini-2.5-pro, gemini-2.5-flash — not the Vertex/AI-Studio names).
  if (/\b404\b|NOT_FOUND|Requested entity was not found/i.test(raw)) {
    return new Error(
      `Model "${model}" is not available on the Gemini Code Assist (Login with ` +
        `Gemini) backend. Run /model and pick one of: gemini-3.1-pro-preview, ` +
        `gemini-2.5-pro, gemini-2.5-flash. (Original: ${raw.slice(0, 160)})`,
    )
  }
  return e instanceof Error ? e : new Error(String(e))
}

export type CodeAssistConfig = {
  getToken: () => Promise<string>
  maxRetries?: number
  providerId?: string
}

/**
 * Build an Anthropic-SDK-shaped client (beta.messages.create) backed by the
 * Gemini Code Assist endpoint. No GCP project required from the user.
 */
export function createCodeAssistClient(config: CodeAssistConfig): unknown {
  async function runNonStreaming(params: BetaParams): Promise<AnyObj> {
    try {
      const token = await config.getToken()
      const project = await ensureCodeAssistProject(token)
      const res = await callCodeAssistWithRetry(
        'generateContent',
        token,
        buildCodeAssistBody(params, project),
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Code Assist generateContent ${res.status}: ${text.slice(0, 300)}`)
      }
      const json = (await res.json()) as { response?: AnyObj }
      return toBetaMessageFromGenAI(json.response ?? (json as AnyObj), params.model)
    } catch (e) {
      throw normalizeError(e, params.model)
    }
  }

  async function runStreaming(params: BetaParams): Promise<{
    data: AsyncGenerator<StreamEvent>
    request_id: null
    response: Response
  }> {
    try {
      const token = await config.getToken()
      const project = await ensureCodeAssistProject(token)
      const res = await callCodeAssistWithRetry(
        'streamGenerateContent',
        token,
        buildCodeAssistBody(params, project),
        undefined,
        'alt=sse',
      )
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new Error(`Code Assist streamGenerateContent ${res.status}: ${text.slice(0, 300)}`)
      }
      const chunks = parseSSEResponses(res.body)
      return {
        data: translateGenAIStream(chunks, params.model),
        request_id: null,
        response: new Response(null, { status: 200 }),
      }
    } catch (e) {
      throw normalizeError(e, params.model)
    }
  }

  return {
    beta: {
      messages: {
        create(params: BetaParams) {
          if (params.stream) {
            const p = Promise.resolve()
            return Object.assign(p, { withResponse: () => runStreaming(params) })
          }
          return runNonStreaming(params)
        },
      },
    },
  }
}
