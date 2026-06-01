// NVIDIA genai image client. POSTs to the genai host with Bearer auth and
// parses the `artifacts[].base64` response into an image buffer.
// SECURITY: the API key is sent only to the fixed NVIDIA genai host; never logged.
import { getRayuApiKey } from '../../utils/rayuConfig.js'
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import {
  type ImageParams,
  NVIDIA_IMAGE_HOST,
  resolveModel,
} from './models.js'

export type GeneratedImage = { buffer: Buffer; mediaType: string }

/** NVIDIA API key from rayu config (preferred) or env fallback. */
export function getNvidiaApiKey(): string | null {
  return getRayuApiKey('nvidia') ?? process.env.NVIDIA_API_KEY ?? null
}

export async function generateImage(opts: {
  modelId?: string
  params: ImageParams
  isEdit?: boolean
  apiKey?: string
  signal?: AbortSignal
}): Promise<GeneratedImage> {
  const apiKey = opts.apiKey ?? getNvidiaApiKey()
  if (!apiKey) {
    throw new Error(
      'NVIDIA API key not configured. Run /connect or set NVIDIA_API_KEY.',
    )
  }
  const model = resolveModel(opts.modelId, !!opts.isEdit)
  const res = await fetch(`${NVIDIA_IMAGE_HOST}/${model.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(model.buildBody(opts.params)),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `NVIDIA image API error ${res.status}: ${text.slice(0, 300)}`,
    )
  }
  const json = (await res.json()) as {
    artifacts?: Array<{ base64?: string; finishReason?: string }>
  }
  const art = json.artifacts?.[0]
  if (art?.finishReason && art.finishReason !== 'SUCCESS') {
    throw new Error(`Image generation failed: ${art.finishReason}`)
  }
  if (!art?.base64) {
    throw new Error(
      'NVIDIA image API returned no image (content-filtered or asset-reference response).',
    )
  }
  const buffer = Buffer.from(art.base64, 'base64')
  return { buffer, mediaType: detectImageFormatFromBuffer(buffer) }
}
