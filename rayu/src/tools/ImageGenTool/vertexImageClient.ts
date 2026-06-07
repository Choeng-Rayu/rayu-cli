// Google Vertex AI image client for the Imagen family.
//
// Imagen 4 (imagen-4.0-*) is generate-only; image editing uses the Imagen 3
// capability model (imagen-3.0-capability-001) with a raw reference image. Both
// are invoked via the publisher `:predict` endpoint and return base64 PNGs.
//
// SECURITY: the OAuth bearer token is sent only to the Vertex host; never logged.
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import {
  getVertexAccessToken,
  resolveVertexProjectRegion,
} from '../../services/api/gemini/vertexAuth.js'
import { isGeminiVertexConfigured } from '../../utils/model/providers.js'
import {
  DEFAULT_VERTEX_EDIT_MODEL,
  DEFAULT_VERTEX_IMAGE_MODEL,
  type ImageParams,
} from './models.js'

export type GeneratedImage = { buffer: Buffer; mediaType: string }

/** True when Imagen-on-Vertex is configured/available (sync best-effort). */
export function isGeminiVertexImageAvailable(): boolean {
  return isGeminiVertexConfigured()
}

type VertexPrediction = { bytesBase64Encoded?: string; mimeType?: string }

function predictUrl(region: string, project: string, model: string): string {
  return (
    `https://${region}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${region}/publishers/google/models/${model}:predict`
  )
}

/** Build the :predict body for an Imagen generate or edit request. */
export function buildImagenBody(opts: {
  isEdit: boolean
  params: ImageParams
}): Record<string, unknown> {
  const { isEdit, params } = opts
  if (isEdit) {
    // Imagen 3 capability model: whole-image (mask-free) edit using a single
    // raw reference image.
    return {
      instances: [
        {
          prompt: params.prompt,
          referenceImages: [
            {
              referenceType: 'REFERENCE_TYPE_RAW',
              referenceId: 1,
              referenceImage: { bytesBase64Encoded: params.image ?? '' },
            },
          ],
        },
      ],
      parameters: {
        editMode: 'EDIT_MODE_DEFAULT',
        sampleCount: 1,
      },
    }
  }
  return {
    instances: [{ prompt: params.prompt }],
    parameters: {
      sampleCount: 1,
      ...(params.aspect_ratio ? { aspectRatio: params.aspect_ratio } : {}),
      ...(params.negative_prompt ? { negativePrompt: params.negative_prompt } : {}),
      ...(params.seed != null ? { seed: params.seed } : {}),
    },
  }
}

/**
 * Generate or edit an image on Vertex AI Imagen. Returns the first prediction
 * decoded to a Buffer + media type.
 */
export async function generateVertexImage(opts: {
  modelId?: string
  params: ImageParams
  isEdit?: boolean
  signal?: AbortSignal
}): Promise<GeneratedImage> {
  const isEdit = !!opts.isEdit
  const { project, region } = await resolveVertexProjectRegion()
  if (!project) {
    throw new Error(
      'No GCP project configured for Vertex Imagen. Run /connect → Gemini / Vertex AI, ' +
        'or set GOOGLE_CLOUD_PROJECT.',
    )
  }
  // Imagen is regional-only — the `global` location used for chat isn't valid
  // here, so fall back to a real region.
  const imgRegion = !region || region === 'global' ? 'us-central1' : region
  const model =
    opts.modelId && /^imagen-/i.test(opts.modelId)
      ? opts.modelId
      : isEdit
        ? DEFAULT_VERTEX_EDIT_MODEL
        : DEFAULT_VERTEX_IMAGE_MODEL

  const token = await getVertexAccessToken()
  const res = await fetch(predictUrl(imgRegion, project, model), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildImagenBody({ isEdit, params: opts.params })),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Vertex Imagen API error ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as { predictions?: VertexPrediction[] }
  const pred = json.predictions?.[0]
  if (!pred?.bytesBase64Encoded) {
    throw new Error(
      'Vertex Imagen returned no image (content-filtered or invalid request).',
    )
  }
  const buffer = Buffer.from(pred.bytesBase64Encoded, 'base64')
  return {
    buffer,
    mediaType: pred.mimeType ?? detectImageFormatFromBuffer(buffer),
  }
}
