// fal.ai video client (bring-your-own FAL_KEY): Kling text-to-video and
// image-to-video through fal's queue API.
//
//   1. POST https://queue.fal.run/<model id>          → { status_url, response_url }
//   2. poll status_url until COMPLETED (or FAILED)
//   3. GET response_url → { video: { url } } → download the MP4
//
// Rayu-hosted video goes through rayuVideoClient and Vertex Veo through
// vertexVideoClient; this client only ever serves catalog entries whose backend
// is `fal`.
//
// SECURITY: the key is sent only to the fixed fal hosts; never logged.
import { getRayuApiKey } from '../../utils/rayuConfig.js'
import { ensureMediaModels } from '../../services/rayuAuth/mediaModels.js'
import {
  type VideoModel,
  type VideoParams,
  FAL_VIDEO_BACKEND,
  resolveVideoModel,
} from './models.js'

/** A generated video plus the model id that produced it. */
export type GeneratedVideo = {
  buffer: Buffer
  mediaType: string
  modelId: string
}

const FAL_QUEUE_HOST = 'https://queue.fal.run'

/** How long a fal job may run before the client gives up. */
const FAL_DEADLINE_MS = 10 * 60 * 1000

/** fal.ai key from env (preferred) or the rayu config fallback. */
export function getFalApiKey(): string | null {
  return process.env.FAL_KEY ?? getRayuApiKey('fal') ?? null
}

/** True when fal.ai video generation is configured on this machine. */
export function isFalVideoAvailable(): boolean {
  return getFalApiKey() != null
}

// ── Poll interval override (for tests) ───────────────────────────────────────
let _falPollIntervalMs = 5000

export function _setFalPollInterval(ms: number): void {
  _falPollIntervalMs = ms
}

type FalJob = { request_id: string; status_url: string; response_url: string }

async function falSubmit(
  modelId: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<FalJob> {
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
  return res.json() as Promise<FalJob>
}

async function falPoll(
  job: FalJob,
  apiKey: string,
  signal: AbortSignal | undefined,
  intervalMs: number,
): Promise<unknown> {
  const deadline = Date.now() + FAL_DEADLINE_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('fal.ai video generation timed out.')
    if (intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs))
    const res = await fetch(job.status_url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`fal.ai status error ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { status?: string }
    if (data.status === 'COMPLETED') {
      const r = await fetch(job.response_url, {
        headers: { Authorization: `Key ${apiKey}` },
        signal,
      })
      return r.json()
    }
    if (data.status === 'FAILED') throw new Error('fal.ai video generation failed.')
  }
}

/**
 * Generate a video on fal.ai.
 *
 * The model comes from the server-owned catalog, restricted to the `fal` backend:
 * an explicit id must be a fal entry, and with no id the catalog's fal default
 * for the operation is used.
 */
export async function generateFalVideo(opts: {
  modelId?: string
  params: VideoParams
  isImage2Video?: boolean
  apiKey?: string
  signal?: AbortSignal
  /** Override poll interval ms. Pass 0 in tests to skip the wait. */
  _pollIntervalMs?: number
  /** Pre-resolved model, when the caller already picked one from the catalog. */
  model?: VideoModel
}): Promise<GeneratedVideo> {
  const model =
    opts.model ??
    resolveVideoModel(
      (await ensureMediaModels()).video,
      opts.modelId,
      !!opts.isImage2Video,
      { backends: [FAL_VIDEO_BACKEND] },
    )
  const apiKey = opts.apiKey ?? getFalApiKey()
  if (!apiKey) {
    throw new Error('fal.ai API key not configured. Set FAL_KEY or run /connect.')
  }
  const job = await falSubmit(model.id, model.buildBody(opts.params), apiKey, opts.signal)
  const result = (await falPoll(
    job,
    apiKey,
    opts.signal,
    opts._pollIntervalMs ?? _falPollIntervalMs,
  )) as { video?: { url?: string } }
  const videoUrl = result?.video?.url
  if (!videoUrl) throw new Error('fal.ai returned no video URL in response.')
  const dlRes = await fetch(videoUrl, { signal: opts.signal })
  if (!dlRes.ok) throw new Error(`Failed to download fal.ai video: ${dlRes.status}`)
  return {
    buffer: Buffer.from(await dlRes.arrayBuffer()),
    mediaType: 'video/mp4',
    modelId: model.id,
  }
}
