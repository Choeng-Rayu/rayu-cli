// NVIDIA genai image client. POSTs to the genai host with Bearer auth and
// parses the `artifacts[].base64` response into an image buffer.
//
// Image editing (input_image) uses a two-step NVCF asset upload flow:
//   1. POST /v2/nvcf/assets → get assetId + S3 presigned uploadUrl
//   2. PUT uploadUrl with raw image bytes
//   3. POST genai with image: "data:<mime>;example_id,<assetId>" + NVCF-INPUT-ASSET-REFERENCES header
//
// SECURITY: the API key is sent only to the fixed NVIDIA hosts; never logged.
import { getRayuApiKey } from '../../utils/rayuConfig.js'
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import {
  type ImageParams,
  NVIDIA_IMAGE_HOST,
  NVCF_ASSET_HOST,
  resolveModel,
} from './models.js'

export type GeneratedImage = { buffer: Buffer; mediaType: string }

/** NVIDIA API key from rayu config (preferred) or env fallback. */
export function getNvidiaApiKey(): string | null {
  return getRayuApiKey('nvidia') ?? process.env.NVIDIA_API_KEY ?? null
}

/**
 * Upload a raw image buffer to NVCF asset storage and return the assetId.
 * Required for editing models that reject inline base64.
 */
async function uploadImageAsset(
  imageBuffer: Buffer,
  mediaType: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  // Step 1: create the asset entry and get a presigned S3 URL
  const createRes = await fetch(NVCF_ASSET_HOST, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contentType: mediaType, description: 'input image' }),
    signal,
  })
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '')
    throw new Error(`NVIDIA asset create error ${createRes.status}: ${text.slice(0, 200)}`)
  }
  const { assetId, uploadUrl } = (await createRes.json()) as {
    assetId: string
    uploadUrl: string
  }

  // Step 2: PUT the raw bytes to S3 using the presigned URL
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mediaType,
      'x-amz-meta-nvcf-asset-description': 'input image',
    },
    body: new Uint8Array(imageBuffer),
    signal,
  })
  if (!putRes.ok) {
    throw new Error(`NVIDIA asset upload error ${putRes.status}`)
  }

  return assetId
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
  const isEdit = !!opts.isEdit
  const model = resolveModel(opts.modelId, isEdit)

  let params = opts.params
  let assetId: string | undefined

  // Editing models require the image to be uploaded as an NVCF asset first.
  // The genai endpoint rejects inline base64 ("Expected: example_id, got: base64").
  if (isEdit && params.image) {
    const rawBuffer = Buffer.from(params.image, 'base64')
    const imageMime = detectImageFormatFromBuffer(rawBuffer)
    assetId = await uploadImageAsset(rawBuffer, imageMime, apiKey, opts.signal)
    params = { ...params, image: undefined, imageAssetId: assetId, imageMimeType: imageMime }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (assetId) {
    headers['NVCF-INPUT-ASSET-REFERENCES'] = assetId
  }

  const res = await fetch(`${NVIDIA_IMAGE_HOST}/${model.id}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(model.buildBody(params)),
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
