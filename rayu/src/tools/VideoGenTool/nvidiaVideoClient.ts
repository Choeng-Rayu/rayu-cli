// NVIDIA genai video client. POSTs to the genai host with Bearer auth. Handles
// BOTH response modes: synchronous (video returned inline) and the NVCF async
// pattern (HTTP 202 + poll the pexec/status endpoint until the result arrives).
// SECURITY: the API key is sent only to the fixed NVIDIA hosts; never logged.
import { getRayuApiKey } from '../../utils/rayuConfig.js'
import {
  type VideoParams,
  NVIDIA_VIDEO_HOST,
  resolveVideoModel,
} from './models.js'

export type GeneratedVideo = { buffer: Buffer; mediaType: string }

const NVCF_STATUS_HOST = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status'
const POLL_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** NVIDIA API key from rayu config (preferred) or env fallback. */
export function getNvidiaApiKey(): string | null {
  return getRayuApiKey('nvidia') ?? process.env.NVIDIA_API_KEY ?? null
}

/** Pull a base64 MP4 out of whatever shape NVIDIA returns. */
function extractVideoBase64(json: unknown): string | null {
  const j = json as {
    artifacts?: Array<{ base64?: string; finishReason?: string }>
    video?: string
    data?: Array<{ b64_json?: string }>
  }
  const art = j.artifacts?.[0]
  if (art?.finishReason && art.finishReason !== 'SUCCESS') {
    throw new Error(`Video generation failed: ${art.finishReason}`)
  }
  return art?.base64 ?? j.video ?? j.data?.[0]?.b64_json ?? null
}

async function pollNvcf(
  reqId: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('Video generation timed out.')
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const res = await fetch(`${NVCF_STATUS_HOST}/${reqId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    })
    if (res.status === 202) continue
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`NVIDIA status error ${res.status}: ${text.slice(0, 300)}`)
    }
    return res.json()
  }
}

export async function generateVideo(opts: {
  modelId?: string
  params: VideoParams
  isImage2Video?: boolean
  apiKey?: string
  signal?: AbortSignal
}): Promise<GeneratedVideo> {
  const apiKey = opts.apiKey ?? getNvidiaApiKey()
  if (!apiKey) {
    throw new Error(
      'NVIDIA API key not configured. Run /connect or set NVIDIA_API_KEY.',
    )
  }
  const model = resolveVideoModel(opts.modelId, !!opts.isImage2Video)
  const res = await fetch(`${NVIDIA_VIDEO_HOST}/${model.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(model.buildBody(opts.params)),
    signal: opts.signal,
  })

  // Async NVCF mode: 202 + a request id to poll.
  let json: unknown
  if (res.status === 202) {
    const reqId = res.headers.get('NVCF-REQID')
    if (!reqId) throw new Error('NVIDIA returned 202 without a request id.')
    json = await pollNvcf(reqId, apiKey, opts.signal)
  } else if (res.ok) {
    json = await res.json()
  } else {
    const text = await res.text().catch(() => '')
    throw new Error(`NVIDIA video API error ${res.status}: ${text.slice(0, 300)}`)
  }

  const b64 = extractVideoBase64(json)
  if (!b64) {
    throw new Error(
      'NVIDIA video API returned no video (content-filtered or unexpected response).',
    )
  }
  return { buffer: Buffer.from(b64, 'base64'), mediaType: 'video/mp4' }
}
