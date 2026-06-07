// Google Vertex AI video client for Veo 3.1.
//
// Video generation is long-running: POST to `:predictLongRunning` returns an
// operation name, which we poll via `:fetchPredictOperation` until `done`,
// then decode `response.videos[0].bytesBase64Encoded` into an MP4 buffer.
//
// SECURITY: the OAuth bearer token is sent only to the Vertex host; never logged.
import {
  getVertexAccessToken,
  resolveVertexProjectRegion,
} from '../../services/api/gemini/vertexAuth.js'
import { isGeminiVertexConfigured } from '../../utils/model/providers.js'
import { DEFAULT_VERTEX_VIDEO_MODEL, type VideoParams } from './models.js'

export type GeneratedVideo = { buffer: Buffer; mediaType: string }

/** True when Veo-on-Vertex is configured/available (sync best-effort). */
export function isGeminiVertexVideoAvailable(): boolean {
  return isGeminiVertexConfigured()
}

type VeoOperation = {
  name?: string
  done?: boolean
  error?: { message?: string }
  response?: {
    videos?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>
    // Some responses nest under generatedSamples / generateVideoResponse.
    generatedSamples?: Array<{ video?: { uri?: string; encodedVideo?: string } }>
  }
}

/** Build the Veo :predict body. Exported for testing. */
export function buildVeoBody(params: VideoParams): Record<string, unknown> {
  return {
    instances: [
      {
        prompt: params.prompt,
        ...(params.image
          ? { image: { bytesBase64Encoded: params.image, mimeType: 'image/png' } }
          : {}),
      },
    ],
    parameters: {
      sampleCount: 1,
      ...(params.aspect_ratio ? { aspectRatio: params.aspect_ratio } : {}),
      ...(params.duration ? { durationSeconds: Number(params.duration) || 8 } : {}),
      ...(params.negative_prompt ? { negativePrompt: params.negative_prompt } : {}),
      ...(params.seed != null ? { seed: params.seed } : {}),
    },
  }
}

/**
 * Extract the base64 MP4 from a completed Veo operation, across the known
 * response shapes. Returns null when not present. Exported for testing.
 */
export function extractVideoBase64(op: VeoOperation): string | null {
  const direct = op.response?.videos?.[0]?.bytesBase64Encoded
  if (direct) return direct
  const sample = op.response?.generatedSamples?.[0]?.video?.encodedVideo
  return sample ?? null
}

function baseModelUrl(region: string, project: string, model: string): string {
  return (
    `https://${region}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${region}/publishers/google/models/${model}`
  )
}

/** Generate a video on Vertex AI Veo. Polls the operation until done. */
export async function generateVertexVideo(opts: {
  modelId?: string
  params: VideoParams
  signal?: AbortSignal
  /** Override poll interval ms (pass 0 in tests to skip the wait). */
  _pollIntervalMs?: number
  /** Override deadline ms (tests). */
  _deadlineMs?: number
}): Promise<GeneratedVideo> {
  const { project, region } = await resolveVertexProjectRegion()
  if (!project) {
    throw new Error(
      'No GCP project configured for Vertex Veo. Run /connect → Gemini / Vertex AI, ' +
        'or set GOOGLE_CLOUD_PROJECT.',
    )
  }
  // Veo is regional-only — the `global` location used for chat isn't valid
  // here, so fall back to a real region.
  const vidRegion = !region || region === 'global' ? 'us-central1' : region
  const model =
    opts.modelId && /^veo-/i.test(opts.modelId)
      ? opts.modelId
      : DEFAULT_VERTEX_VIDEO_MODEL
  const token = await getVertexAccessToken()
  const url = baseModelUrl(vidRegion, project, model)

  // 1) Kick off the long-running operation.
  const startRes = await fetch(`${url}:predictLongRunning`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildVeoBody(opts.params)),
    signal: opts.signal,
  })
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => '')
    throw new Error(`Vertex Veo API error ${startRes.status}: ${text.slice(0, 300)}`)
  }
  const op = (await startRes.json()) as VeoOperation
  if (!op.name) {
    throw new Error('Vertex Veo did not return an operation name.')
  }

  // 2) Poll until the operation completes.
  const intervalMs = opts._pollIntervalMs ?? 10_000
  const deadline = Date.now() + (opts._deadlineMs ?? 10 * 60 * 1000)
  while (Date.now() < deadline) {
    if (intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs))
    const freshToken = await getVertexAccessToken()
    const pollRes = await fetch(`${url}:fetchPredictOperation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${freshToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operationName: op.name }),
      signal: opts.signal,
    })
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => '')
      throw new Error(`Vertex Veo poll error ${pollRes.status}: ${text.slice(0, 300)}`)
    }
    const status = (await pollRes.json()) as VeoOperation
    if (status.error?.message) {
      throw new Error(`Vertex Veo generation failed: ${status.error.message}`)
    }
    if (status.done) {
      const b64 = extractVideoBase64(status)
      if (!b64) {
        throw new Error('Vertex Veo completed but returned no video (content-filtered?).')
      }
      return { buffer: Buffer.from(b64, 'base64'), mediaType: 'video/mp4' }
    }
  }
  throw new Error('Vertex Veo generation timed out.')
}
