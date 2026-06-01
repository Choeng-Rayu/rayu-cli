// Registry of NVIDIA free text-to-video (Cosmos world-generation) models and
// per-family request mappers. Hosted on the genai host, same as image models.
// SECURITY: only the model id + user prompt/params are sent; the API key is
// added by the client and never logged.

export const NVIDIA_VIDEO_HOST = 'https://ai.api.nvidia.com/v1/genai'

export type VideoCapability = 'text2video' | 'image2video'

export type VideoParams = {
  prompt: string
  negative_prompt?: string
  num_frames?: number
  fps?: number
  height?: number
  width?: number
  seed?: number
  aspect_ratio?: string
  /** base64-encoded input image (no data-URI prefix) for image2video models. */
  image?: string
}

export type VideoModel = {
  id: string
  capability: VideoCapability
  /** Rough seconds a generation takes, for the user-facing wait message. */
  estimatedSeconds: number
  buildBody: (p: VideoParams) => Record<string, unknown>
}

// Cosmos Predict text2world: prompt + frame count/fps + seed.
const cosmosText2World = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  negative_prompt: p.negative_prompt ?? '',
  num_frames: p.num_frames ?? 57,
  fps: p.fps ?? 24,
  height: p.height ?? 704,
  width: p.width ?? 1280,
  seed: p.seed ?? 0,
})

// Cosmos Predict video2world: animate a starting image.
const cosmosVideo2World = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  image: `data:image/png;base64,${p.image ?? ''}`,
  num_frames: p.num_frames ?? 57,
  fps: p.fps ?? 24,
  seed: p.seed ?? 0,
})

export const DEFAULT_VIDEO_MODEL = 'nvidia/cosmos-predict2.5-2b/text2world'
export const DEFAULT_IMAGE2VIDEO_MODEL =
  'nvidia/cosmos-predict2.5-2b/video2world'

export const VIDEO_MODELS: Record<string, VideoModel> = {
  [DEFAULT_VIDEO_MODEL]: {
    id: DEFAULT_VIDEO_MODEL,
    capability: 'text2video',
    estimatedSeconds: 120,
    buildBody: cosmosText2World,
  },
  [DEFAULT_IMAGE2VIDEO_MODEL]: {
    id: DEFAULT_IMAGE2VIDEO_MODEL,
    capability: 'image2video',
    estimatedSeconds: 120,
    buildBody: cosmosVideo2World,
  },
}

/** Resolve the model: explicit id if known (and image2video-capable when
 *  animating an image), else the default for the operation. */
export function resolveVideoModel(
  modelId: string | undefined,
  isImage2Video: boolean,
): VideoModel {
  const m = modelId ? VIDEO_MODELS[modelId] : undefined
  if (m && (!isImage2Video || m.capability === 'image2video')) return m
  return VIDEO_MODELS[
    isImage2Video ? DEFAULT_IMAGE2VIDEO_MODEL : DEFAULT_VIDEO_MODEL
  ]
}
