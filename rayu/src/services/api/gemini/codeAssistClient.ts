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

type LoadCodeAssistResponse = {
  cloudaicompanionProject?: string
  currentTier?: { id?: string }
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
}

type LROResponse = {
  done?: boolean
  response?: { cloudaicompanionProject?: { id?: string } | string }
}

/** Extract a project id from an onboardUser LRO response (string or {id}). */
export function projectIdFromOnboard(op: LROResponse): string | undefined {
  const p = op.response?.cloudaicompanionProject
  if (!p) return undefined
  return typeof p === 'string' ? p : p.id
}

/** Choose the tier id to onboard with: the default tier, else 'free-tier'. */
export function pickOnboardTier(load: LoadCodeAssistResponse): string {
  const def = load.allowedTiers?.find(t => t.isDefault)?.id
  return def ?? load.currentTier?.id ?? 'free-tier'
}

let cachedProject: string | null = null

/**
 * Resolve the Code Assist `cloudaicompanionProject` for the signed-in account,
 * onboarding the free tier if needed. Cached in-memory and in the login store.
 */
export async function ensureCodeAssistProject(token: string): Promise<string> {
  if (cachedProject) return cachedProject
  const stored = readGeminiLoginStore()?.codeAssistProject
  if (stored) {
    cachedProject = stored
    return stored
  }

  // 1. loadCodeAssist
  const loadRes = await callCodeAssist('loadCodeAssist', token, {
    metadata: CLIENT_METADATA,
  })
  if (!loadRes.ok) {
    const text = await loadRes.text().catch(() => '')
    throw new Error(`Code Assist loadCodeAssist failed ${loadRes.status}: ${text.slice(0, 200)}`)
  }
  const load = (await loadRes.json()) as LoadCodeAssistResponse
  let project = load.cloudaicompanionProject

  // 2. onboardUser when no project is provisioned yet.
  if (!project) {
    const tierId = pickOnboardTier(load)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const obRes = await callCodeAssist('onboardUser', token, {
        tierId,
        metadata: CLIENT_METADATA,
      })
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

/** Build the v1internal request wrapper { model, project, request:{…} }. */
export function buildCodeAssistBody(params: BetaParams, project: string): AnyObj {
  const b = buildGenAIBody(params)
  const request: AnyObj = { contents: b.contents }
  if (b.systemInstruction) {
    request.systemInstruction = { parts: [{ text: b.systemInstruction }] }
  }
  if (b.tools) request.tools = b.tools
  if (Object.keys(b.config).length) request.generationConfig = b.config
  return { model: b.model, project, request }
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
      const res = await callCodeAssist(
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
      const res = await callCodeAssist(
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
