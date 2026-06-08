// Gemini-on-Vertex chat client using Vertex AI's NATIVE genai endpoint
// (`…/publishers/google/models/{model}:generateContent` /
// `:streamGenerateContent`). It reuses the hardened genai translation
// (genaiTranslate) so the SAME Gemini fixes used by the Login/Code-Assist path
// apply here: tool-schema sanitization, Gemini-3 thought_signature
// capture/replay (the cause of the "Function call is missing a thought_signature"
// 400), and non-null content.
//
// This replaces the previous OpenAI-compat (`/endpoints/openapi/chat/completions`)
// routing, whose adapter could not preserve thought_signatures across tool turns.
//
// SECURITY: the OAuth bearer token is sent only to the Vertex host; never logged.
import { reportIssue } from '../../../utils/rayuDiagnostics.js'
import { DEFAULT_VERTEX_REGION, vertexHost } from '../../../utils/rayuProviders.js'
import type { RayuProvider } from '../../../utils/rayuConfig.js'
import { getVertexAccessToken } from './vertexAuth.js'
import { parseSSEResponses } from './codeAssistClient.js'
import {
  buildGenAIBody,
  toBetaMessageFromGenAI,
  translateGenAIStream,
  type AnyObj,
  type BetaParams,
  type StreamEvent,
} from './genaiTranslate.js'

/** Strip any `models/` or `google/` prefix — the native endpoint takes the bare
 *  model id in the URL path (the `google/` publisher prefix is openapi-only). */
export function bareVertexModel(model: string): string {
  return model.replace(/^models\//, '').replace(/^google\//, '')
}

/** Build the native GenerateContentRequest body from Anthropic params. */
export function buildVertexGenaiBody(params: BetaParams): AnyObj {
  const b = buildGenAIBody(params)
  const body: AnyObj = { contents: b.contents }
  if (b.systemInstruction) body.systemInstruction = { parts: [{ text: b.systemInstruction }] }
  if (b.tools) body.tools = b.tools
  if (Object.keys(b.config).length) body.generationConfig = b.config
  return body
}

function normalizeError(e: unknown, model: string): Error {
  reportIssue('vertex_genai.request_failed', 'Vertex genai request failed', {
    model,
    error: e instanceof Error ? e.message : String(e),
  })
  const raw = e instanceof Error ? e.message : String(e)
  // 403: project not set up for Vertex AI.
  if (/\b403\b|PERMISSION_DENIED|has not been used|aiplatform.*disabled/i.test(raw)) {
    return new Error(
      'Vertex AI access denied. On your GCP project: enable the "Vertex AI API" ' +
        '(console.cloud.google.com/apis/library/aiplatform.googleapis.com), ensure ' +
        'billing is active, and grant your account the "Vertex AI User" role ' +
        `(roles/aiplatform.user). (Original: ${raw.slice(0, 240)})`,
    )
  }
  // 404: model not served in this region.
  if (/\b404\b|Publisher Model|was not found|NOT_FOUND/i.test(raw)) {
    return new Error(
      `Model "${model}" isn't available on Vertex in this region. Gemini 3.x is ` +
        'served in `global` / `us-central1` — reconnect (/connect → Vertex) and pick ' +
        'the `global` region, or choose a model your region serves (e.g. gemini-2.5-pro, ' +
        `gemini-2.5-flash). (Original: ${raw.slice(0, 200)})`,
    )
  }
  return e instanceof Error ? e : new Error(String(e))
}

export type VertexGenaiConfig = {
  project: string
  region: string
  maxRetries?: number
  providerId?: string
  /** Token source (defaults to the shared Vertex OAuth/ADC resolver). */
  getToken?: () => Promise<string>
}

function modelUrl(cfg: VertexGenaiConfig, model: string, method: string, query?: string): string {
  const region = cfg.region || DEFAULT_VERTEX_REGION
  const m = bareVertexModel(model)
  return (
    `https://${vertexHost(region)}/v1beta1/projects/${cfg.project}` +
    `/locations/${region}/publishers/google/models/${m}:${method}${query ? `?${query}` : ''}`
  )
}

async function callVertex(
  cfg: VertexGenaiConfig,
  model: string,
  method: string,
  body: AnyObj,
  signal?: AbortSignal,
  query?: string,
): Promise<Response> {
  const getToken = cfg.getToken ?? getVertexAccessToken
  const token = await getToken()
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  return globalThis.fetch(modelUrl(cfg, model, method, query), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // The publisher endpoints require a quota/billing project.
      'x-goog-user-project': cfg.project,
    },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * Build an Anthropic-SDK-shaped client (beta.messages.create) backed by Vertex's
 * native genai endpoint. Returns null-free; throws a clear error on failure.
 */
export function createVertexGenaiClient(
  provider: Pick<RayuProvider, 'id' | 'gcpProject' | 'gcpRegion'>,
  maxRetries: number,
): unknown {
  const project = provider.gcpProject || process.env.GOOGLE_CLOUD_PROJECT || ''
  const cfg: VertexGenaiConfig = {
    project,
    region: provider.gcpRegion || DEFAULT_VERTEX_REGION,
    maxRetries,
    providerId: provider.id,
  }

  function ensureProject(): void {
    if (!cfg.project) {
      throw new Error(
        'No GCP project configured for Vertex AI. Run /connect → Google Gemini — ' +
          'Vertex AI, or set GOOGLE_CLOUD_PROJECT.',
      )
    }
  }

  async function runNonStreaming(params: BetaParams): Promise<AnyObj> {
    try {
      ensureProject()
      const res = await callVertex(cfg, params.model, 'generateContent', buildVertexGenaiBody(params))
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Vertex generateContent ${res.status}: ${text.slice(0, 300)}`)
      }
      const json = (await res.json()) as AnyObj
      return toBetaMessageFromGenAI(json, params.model)
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
      ensureProject()
      const res = await callVertex(
        cfg,
        params.model,
        'streamGenerateContent',
        buildVertexGenaiBody(params),
        undefined,
        'alt=sse',
      )
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new Error(`Vertex streamGenerateContent ${res.status}: ${text.slice(0, 300)}`)
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
