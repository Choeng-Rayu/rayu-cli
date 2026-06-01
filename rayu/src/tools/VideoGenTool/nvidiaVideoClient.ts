// Video generation client.
// Primary: NVIDIA Physical AI models via NVCF (api.nvcf.nvidia.com)
//   - cosmos-predict1-5b, cosmos-transfer1-7b, cosmos3-nano
//   - Request: simple JSON { prompt, seed }
//   - Response: async 202+poll → { asset_url } → download MP4
// Legacy: cosmos-1.0-7b via ai.api.nvidia.com/v1/cosmos (Triton format, ZIP)
// SVD: ai.api.nvidia.com/v1/genai (simple JSON, base64 response)
// Fallback: fal.ai (FAL_KEY)
// SECURITY: keys sent only to their fixed hosts; never logged.
import { getRayuApiKey } from '../../utils/rayuConfig.js'
import {
  type VideoParams,
  NVIDIA_GENAI_HOST,
  resolveVideoModel,
} from './models.js'

export type GeneratedVideo = { buffer: Buffer; mediaType: string }

const NVCF_PEXEC_HOST = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/functions'
const NVCF_STATUS_HOST = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status'
const NVCF_ASSET_HOST = 'https://api.nvcf.nvidia.com/v1/assets'
const NVIDIA_COSMOS_HOST = 'https://ai.api.nvidia.com/v1/cosmos'

// ── Key helpers ───────────────────────────────────────────────────────────────

export function getNvidiaApiKey(): string | null {
  return getRayuApiKey('nvidia') ?? process.env.NVIDIA_API_KEY ?? null
}

export function getFalApiKey(): string | null {
  return getRayuApiKey('fal') ?? process.env.FAL_KEY ?? null
}

export function isVideoEnabled(): boolean {
  return getNvidiaApiKey() != null || getFalApiKey() != null
}

// ── Poll interval overrides (for tests) ──────────────────────────────────────
let _nvidiaPollIntervalMs = 5000
let _falPollIntervalMs = 5000

export function _setNvidiaPollInterval(ms: number): void {
  _nvidiaPollIntervalMs = ms
}
export function _setFalPollInterval(ms: number): void {
  _falPollIntervalMs = ms
}

// ── NVCF poll (shared) ────────────────────────────────────────────────────────
async function pollNvcf(
  reqId: string,
  apiKey: string,
  signal?: AbortSignal,
  intervalMs = 5000,
): Promise<Response> {
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    if (Date.now() > deadline) throw new Error('NVIDIA video generation timed out.')
    if (intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs))
    const res = await fetch(`${NVCF_STATUS_HOST}/${reqId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    })
    if (res.status === 202) continue
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`NVIDIA status error ${res.status}: ${text.slice(0, 300)}`)
    }
    return res
  }
}

// ── NVIDIA NVCF backend (cosmos-predict1-5b, transfer, cosmos3-nano) ──────────
// Response: { asset_url: "https://api.nvcf.nvidia.com/v1/assets/{id}" } → download MP4
async function generateVideoNvcf(opts: {
  nvcfFunctionId: string
  body: Record<string, unknown>
  apiKey: string
  signal?: AbortSignal
  _pollIntervalMs?: number
}): Promise<GeneratedVideo> {
  const res = await fetch(`${NVCF_PEXEC_HOST}/${opts.nvcfFunctionId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  })

  let finalRes: Response
  if (res.status === 202) {
    const reqId = res.headers.get('NVCF-REQID')
    if (!reqId) throw new Error('NVIDIA returned 202 without a request id.')
    finalRes = await pollNvcf(reqId, opts.apiKey, opts.signal, opts._pollIntervalMs ?? _nvidiaPollIntervalMs)
  } else if (res.ok) {
    finalRes = res
  } else {
    const text = await res.text().catch(() => '')
    throw new Error(`NVIDIA video API error ${res.status}: ${text.slice(0, 300)}`)
  }

  // Response is JSON — handle multiple possible response shapes:
  // 1. Triton PREDICT_V2: { model_name, outputs: [{name:'media', data:[b64]}] }
  // 2. asset_url: { asset_url: "https://api.nvcf.nvidia.com/v1/assets/{id}" }
  // 3. Direct base64: { video: "<b64>" }
  const json = (await finalRes.json()) as {
    asset_url?: string
    video?: string
    outputs?: Array<{ name: string; data: string[] }>
    model_name?: string
  }

  // Triton PREDICT_V2 response
  if (json.outputs) {
    // Check status output first for errors
    const statusOut = json.outputs.find(o => o.name === 'status')
    const statusMsg = statusOut?.data?.[0] ?? ''
    if (statusMsg.includes('unknown API in cmd string')) {
      throw new Error(
        `NVIDIA cosmos-predict1-5b: the internal API command name is undocumented. ` +
        `Visit https://build.nvidia.com/nvidia/cosmos-predict1-5b while logged in ` +
        `to see the working code sample. Error: ${statusMsg.slice(0, 150)}`,
      )
    }
    if (statusMsg.startsWith('inference failed')) {
      throw new Error(`NVIDIA video generation failed: ${statusMsg}`)
    }
    // Success — get media/video output
    const mediaOut = json.outputs.find(o => o.name === 'media' || o.name === 'video' || o.name === 'output')
    const b64 = mediaOut?.data?.[0]
    if (b64) return { buffer: Buffer.from(b64, 'base64'), mediaType: 'video/mp4' }
    // If status says success (no error) but no media, the video may be in the status response itself
    if (statusMsg && !statusMsg.includes('failed')) {
      // Some edify responses put the video directly in status as base64
      try {
        const buf = Buffer.from(statusMsg, 'base64')
        if (buf.length > 1000) return { buffer: buf, mediaType: 'video/mp4' }
      } catch { /* not base64 */ }
    }
  }

  // asset_url response
  if (json.asset_url) {
    const dlRes = await fetch(json.asset_url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: opts.signal,
    })
    if (!dlRes.ok) throw new Error(`NVIDIA asset download error ${dlRes.status}`)
    return { buffer: Buffer.from(await dlRes.arrayBuffer()), mediaType: 'video/mp4' }
  }

  // Direct base64
  if (json.video) {
    return { buffer: Buffer.from(json.video, 'base64'), mediaType: 'video/mp4' }
  }

  throw new Error('NVIDIA video API returned no video (no media output, asset_url, or video field).')
}

// ── NVIDIA legacy cosmos host (Triton format, ZIP response) ──────────────────
async function generateVideoCosmosLegacy(opts: {
  modelId: string
  body: Record<string, unknown>
  apiKey: string
  signal?: AbortSignal
  _pollIntervalMs?: number
}): Promise<GeneratedVideo> {
  const res = await fetch(`${NVIDIA_COSMOS_HOST}/${opts.modelId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  })

  let finalRes: Response
  if (res.status === 202) {
    const reqId = res.headers.get('NVCF-REQID')
    if (!reqId) throw new Error('NVIDIA returned 202 without a request id.')
    finalRes = await pollNvcf(reqId, opts.apiKey, opts.signal, opts._pollIntervalMs ?? _nvidiaPollIntervalMs)
  } else if (res.ok) {
    finalRes = res
  } else {
    const text = await res.text().catch(() => '')
    throw new Error(`NVIDIA video API error ${res.status}: ${text.slice(0, 300)}`)
  }

  const location = finalRes.headers.get('Location')
  const buffer = location
    ? Buffer.from(await (await fetch(location, { signal: opts.signal })).arrayBuffer())
    : Buffer.from(await finalRes.arrayBuffer())

  const mp4 = extractMp4FromZip(buffer)
  return { buffer: mp4 ?? buffer, mediaType: 'video/mp4' }
}

function extractMp4FromZip(buf: Buffer): Buffer | null {
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i + 4] === 0x66 && buf[i + 5] === 0x74 && buf[i + 6] === 0x79 && buf[i + 7] === 0x70) {
      return buf.slice(i)
    }
  }
  return null
}

// ── NVIDIA SVD (genai host, image-to-video, JSON base64) ─────────────────────
async function generateVideoSvd(opts: {
  modelId: string
  body: Record<string, unknown>
  apiKey: string
  signal?: AbortSignal
  _pollIntervalMs?: number
}): Promise<GeneratedVideo> {
  const res = await fetch(`${NVIDIA_GENAI_HOST}/${opts.modelId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  })

  let finalRes: Response
  if (res.status === 202) {
    const reqId = res.headers.get('NVCF-REQID')
    if (!reqId) throw new Error('NVIDIA returned 202 without a request id.')
    finalRes = await pollNvcf(reqId, opts.apiKey, opts.signal, opts._pollIntervalMs ?? _nvidiaPollIntervalMs)
  } else if (res.ok) {
    finalRes = res
  } else {
    const text = await res.text().catch(() => '')
    throw new Error(`NVIDIA video API error ${res.status}: ${text.slice(0, 300)}`)
  }

  const json = (await finalRes.json()) as {
    video?: string
    artifacts?: Array<{ base64?: string; finishReason?: string }>
    finish_reason?: string
  }
  const b64 = json.video ?? json.artifacts?.[0]?.base64
  if (!b64) throw new Error('NVIDIA SVD returned no video data.')
  return { buffer: Buffer.from(b64, 'base64'), mediaType: 'video/mp4' }
}

// ── fal.ai backend ────────────────────────────────────────────────────────────
const FAL_QUEUE_HOST = 'https://queue.fal.run'

async function falSubmit(
  modelId: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ request_id: string; status_url: string; response_url: string }> {
  const res = await fetch(`${FAL_QUEUE_HOST}/${modelId}`, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`fal.ai submit error ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json() as Promise<{ request_id: string; status_url: string; response_url: string }>
}

async function falPoll(
  statusUrl: string,
  responseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
  intervalMs = 5000,
): Promise<unknown> {
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    if (Date.now() > deadline) throw new Error('fal.ai video generation timed out.')
    if (intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs))
    const res = await fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` }, signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`fal.ai status error ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { status?: string }
    if (data.status === 'COMPLETED') {
      const r = await fetch(responseUrl, { headers: { Authorization: `Key ${apiKey}` }, signal })
      return r.json()
    }
    if (data.status === 'FAILED') throw new Error('fal.ai video generation failed.')
  }
}

async function generateVideoFal(opts: {
  modelId: string
  body: Record<string, unknown>
  apiKey: string
  signal?: AbortSignal
  _pollIntervalMs?: number
}): Promise<GeneratedVideo> {
  const job = await falSubmit(opts.modelId, opts.body, opts.apiKey, opts.signal)
  const result = (await falPoll(
    job.status_url,
    job.response_url,
    opts.apiKey,
    opts.signal,
    opts._pollIntervalMs ?? _falPollIntervalMs,
  )) as { video?: { url?: string } }
  const videoUrl = result?.video?.url
  if (!videoUrl) throw new Error('fal.ai returned no video URL in response.')
  const dlRes = await fetch(videoUrl, { signal: opts.signal })
  if (!dlRes.ok) throw new Error(`Failed to download fal.ai video: ${dlRes.status}`)
  return { buffer: Buffer.from(await dlRes.arrayBuffer()), mediaType: 'video/mp4' }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generateVideo(opts: {
  modelId?: string
  params: VideoParams
  isImage2Video?: boolean
  apiKey?: string
  signal?: AbortSignal
  /** Override poll interval ms. Pass 0 in tests to skip the wait. */
  _pollIntervalMs?: number
}): Promise<GeneratedVideo> {
  const model = resolveVideoModel(opts.modelId, !!opts.isImage2Video)
  const body = model.buildBody(opts.params)

  if (model.backend === 'nvcf') {
    const apiKey = opts.apiKey ?? getNvidiaApiKey()
    if (!apiKey) throw new Error('NVIDIA API key not configured. Set NVIDIA_API_KEY or run /connect.')

    // New NVCF models (cosmos-predict1-5b, transfer, cosmos3-nano) use function ID
    if (model.nvcfFunctionId) {
      return generateVideoNvcf({
        nvcfFunctionId: model.nvcfFunctionId,
        body,
        apiKey,
        signal: opts.signal,
        _pollIntervalMs: opts._pollIntervalMs,
      })
    }

    // Legacy cosmos-1.0-7b uses the ai.api.nvidia.com/v1/cosmos host
    return generateVideoCosmosLegacy({
      modelId: model.id,
      body,
      apiKey,
      signal: opts.signal,
      _pollIntervalMs: opts._pollIntervalMs,
    })
  }

  if (model.backend === 'nvidia-svd') {
    const apiKey = opts.apiKey ?? getNvidiaApiKey()
    if (!apiKey) throw new Error('NVIDIA API key not configured. Set NVIDIA_API_KEY or run /connect.')
    return generateVideoSvd({ modelId: model.id, body, apiKey, signal: opts.signal, _pollIntervalMs: opts._pollIntervalMs })
  }

  // fal.ai fallback
  const apiKey = opts.apiKey ?? getFalApiKey()
  if (!apiKey) throw new Error('fal.ai API key not configured. Set FAL_KEY or run /connect.')
  return generateVideoFal({ modelId: model.id, body, apiKey, signal: opts.signal, _pollIntervalMs: opts._pollIntervalMs })
}
