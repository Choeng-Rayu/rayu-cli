// Registry of NVIDIA free image-generation models and per-family request
// mappers. These are hosted on the genai host (distinct from the chat baseURL).
// SECURITY: only the model id + user prompt/params are sent; the API key is
// added by the client and never logged.

export const NVIDIA_IMAGE_HOST = 'https://ai.api.nvidia.com/v1/genai'
export const NVCF_ASSET_HOST = 'https://api.nvcf.nvidia.com/v2/nvcf/assets'

export type ImageCapability = 'generate' | 'edit'

export type ImageParams = {
  prompt: string
  width?: number
  height?: number
  aspect_ratio?: string
  steps?: number
  cfg_scale?: number
  seed?: number
  negative_prompt?: string
  /** base64-encoded input image (no data-URI prefix) for editing models. */
  image?: string
  /** NVCF asset ID for the input image; set by the client after upload. */
  imageAssetId?: string
  /** MIME type of the uploaded asset (e.g. "image/jpeg"). */
  imageMimeType?: string
}

export type ImageModel = {
  id: string
  capability: ImageCapability
  buildBody: (p: ImageParams) => Record<string, unknown>
}

// FLUX family. flux.1-schnell is guidance-distilled: the NVIDIA endpoint
// requires cfg_scale<=0 and runs in 1-4 steps. flux.1-dev uses guidance
// (cfg_scale ~3.5) and more steps.
const fluxBody =
  (defaults: { cfg_scale: number; steps: number }) =>
  (p: ImageParams): Record<string, unknown> => ({
    prompt: p.prompt,
    cfg_scale: p.cfg_scale ?? defaults.cfg_scale,
    width: p.width ?? 1024,
    height: p.height ?? 1024,
    steps: p.steps ?? defaults.steps,
    seed: p.seed ?? 0,
  })

// Stable Diffusion 3.5: aspect_ratio + negative_prompt, many steps.
const sdBody = (p: ImageParams): Record<string, unknown> => ({
  prompt: p.prompt,
  cfg_scale: p.cfg_scale ?? 4.5,
  aspect_ratio: p.aspect_ratio ?? '1:1',
  steps: p.steps ?? 50,
  seed: p.seed ?? 0,
  negative_prompt: p.negative_prompt ?? '',
})

// FLUX.1-Kontext-dev: in-context editing — requires uploaded asset (example_id).
// The client uploads the image first and populates imageAssetId + detects the mime type.
const kontextBody = (p: ImageParams): Record<string, unknown> => {
  if (!p.imageAssetId) {
    throw new Error('kontextBody requires imageAssetId (asset must be uploaded first)')
  }
  const mime = p.imageMimeType ?? 'image/jpeg'
  return {
    prompt: p.prompt,
    image: `data:${mime};example_id,${p.imageAssetId}`,
    cfg_scale: p.cfg_scale ?? 3.5,
    steps: p.steps ?? 30,
    seed: p.seed ?? 0,
  }
}

export const DEFAULT_IMAGE_MODEL = 'black-forest-labs/flux.1-schnell'
export const DEFAULT_EDIT_MODEL = 'black-forest-labs/flux.1-kontext-dev'

export const IMAGE_MODELS: Record<string, ImageModel> = {
  [DEFAULT_IMAGE_MODEL]: {
    id: DEFAULT_IMAGE_MODEL,
    capability: 'generate',
    buildBody: fluxBody({ cfg_scale: 0, steps: 4 }),
  },
  'black-forest-labs/flux.1-dev': {
    id: 'black-forest-labs/flux.1-dev',
    capability: 'generate',
    buildBody: fluxBody({ cfg_scale: 3.5, steps: 50 }),
  },
  'stabilityai/stable-diffusion-3.5-large': {
    id: 'stabilityai/stable-diffusion-3.5-large',
    capability: 'generate',
    buildBody: sdBody,
  },
  [DEFAULT_EDIT_MODEL]: {
    id: DEFAULT_EDIT_MODEL,
    capability: 'edit',
    buildBody: kontextBody,
  },
}

/** Resolve the model to use: explicit id if known (and edit-capable when
 *  editing), else the default for the operation. */
export function resolveModel(
  modelId: string | undefined,
  isEdit: boolean,
): ImageModel {
  const m = modelId ? IMAGE_MODELS[modelId] : undefined
  if (m && (!isEdit || m.capability === 'edit')) return m
  return IMAGE_MODELS[isEdit ? DEFAULT_EDIT_MODEL : DEFAULT_IMAGE_MODEL]
}
