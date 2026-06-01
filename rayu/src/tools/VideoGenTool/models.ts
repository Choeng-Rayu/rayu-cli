// Registry of NVIDIA-hosted video generation models (Physical AI catalog).
// All use the NVCF pexec host: api.nvcf.nvidia.com/v2/nvcf/pexec/functions/{id}
// Auth: Bearer $NVIDIA_API_KEY (free from build.nvidia.com, 20 requests/model)
// Async pattern: HTTP 202 + NVCF-REQID header → poll pexec/status/{reqId}
// SECURITY: only model params + prompt sent; key never logged.

export type VideoCapability = 'text2video' | 'image2video'
export type VideoBackend = 'nvcf' | 'nvidia-svd' | 'fal'

export type VideoParams = {
  prompt: string
  negative_prompt?: string
  num_frames?: number
  fps?: number
  height?: number
  width?: number
  seed?: number
  aspect_ratio?: string
  duration?: string
  /** base64-encoded input image (no data-URI prefix) for image2video models. */
  image?: string
  /** Index of input image (cosmos-predict1-5b). 0 or 1. */
  input_image_index?: number
}

export type VideoModel = {
  id: string
  backend: VideoBackend
  capability: VideoCapability
  /** NVCF function UUID (for nvcf backend). */
  nvcfFunctionId?: string
  /** Rough seconds a generation takes, for the user-facing wait message. */
  estimatedSeconds: number
  buildBody: (p: VideoParams) => Record<string, unknown>
}

// ── NVCF model bodies ─────────────────────────────────────────────────────────

// cosmos-predict1-5b: Triton Inference Server PREDICT_V2 format.
// Model name is 'edify'. Command: "t2v text=<prompt>" or "t2w text=<prompt>"
// Output name is 'media' (returns base64 video) or 'status' (returns job status).
const cosmosPredict1Body = (p: VideoParams): Record<string, unknown> => {
  const isVideo = !p.image
  const cmd = isVideo
    ? `t2v text=${p.prompt}${p.seed != null ? ` seed=${p.seed}` : ''}`
    : `i2v text=${p.prompt} image=${p.image}${p.seed != null ? ` seed=${p.seed}` : ''}`
  return {
    inputs: [
      { name: 'command', shape: [1], datatype: 'BYTES', data: [cmd] },
    ],
    outputs: [
      { name: 'media', datatype: 'BYTES', shape: [1] },
    ],
  }
}

// cosmos-transfer1-7b: video-to-video style transfer + prompt
const cosmosTransfer1Body = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  seed: p.seed ?? 0,
})

// cosmos3-nano: text-to-world lightweight model
const cosmos3NanoBody = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  seed: p.seed ?? 0,
})

// cosmos-1.0-7b: legacy Triton format
const cosmosLegacyText2World = (p: VideoParams): Record<string, unknown> => ({
  inputs: [
    {
      name: 'command',
      shape: [1],
      datatype: 'BYTES',
      data: [`text2world --prompt="${p.prompt.replace(/"/g, '\\"')}"${p.seed != null ? ` --seed=${p.seed}` : ''}`],
    },
  ],
  outputs: [{ name: 'status', datatype: 'BYTES', shape: [1] }],
})

// ── NVIDIA SVD (simple genai host) ───────────────────────────────────────────
export const NVIDIA_GENAI_HOST = 'https://ai.api.nvidia.com/v1/genai'

const svdBody = (p: VideoParams): Record<string, unknown> => ({
  image: p.image ? `data:image/png;base64,${p.image}` : '',
  seed: p.seed ?? 0,
  cfg_scale: 1.8,
  motion_bucket_id: 127,
})

// ── fal.ai (fallback) ────────────────────────────────────────────────────────
const falKlingText2VideoBody = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  negative_prompt: p.negative_prompt ?? '',
  duration: p.duration ?? '5',
  aspect_ratio: p.aspect_ratio ?? '16:9',
  cfg_scale: 0.5,
})

const falKlingImage2VideoBody = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  image_url: `data:image/png;base64,${p.image ?? ''}`,
  duration: p.duration ?? '5',
  aspect_ratio: p.aspect_ratio ?? '16:9',
})

// ── Registry ─────────────────────────────────────────────────────────────────

export const DEFAULT_VIDEO_MODEL = 'nvidia/cosmos-predict1-5b'
export const DEFAULT_IMAGE2VIDEO_MODEL = 'nvidia/cosmos-predict1-5b'

export const VIDEO_MODELS: Record<string, VideoModel> = {
  // ── NVIDIA Physical AI (free, 20 requests, NVCF function IDs) ──────────────
  'nvidia/cosmos-predict1-5b': {
    id: 'nvidia/cosmos-predict1-5b',
    backend: 'nvcf',
    capability: 'text2video',
    nvcfFunctionId: 'eef816a3-3940-413b-93c9-513ae29f34f9',
    estimatedSeconds: 120,
    buildBody: cosmosPredict1Body,
  },
  'nvidia/cosmos-transfer1-7b': {
    id: 'nvidia/cosmos-transfer1-7b',
    backend: 'nvcf',
    capability: 'image2video',
    nvcfFunctionId: 'abb63707-47ee-497c-81a3-37e685bacdc6',
    estimatedSeconds: 120,
    buildBody: cosmosTransfer1Body,
  },
  'nvidia/cosmos3-nano': {
    id: 'nvidia/cosmos3-nano',
    backend: 'nvcf',
    capability: 'text2video',
    nvcfFunctionId: 'd09cd49d-d7f2-4361-928f-ea22af707249',
    estimatedSeconds: 90,
    buildBody: cosmos3NanoBody,
  },
  // ── NVIDIA Cosmos legacy (Triton format, cosmos host) ─────────────────────
  'nvidia/cosmos-1.0-7b-diffusion-text2world': {
    id: 'nvidia/cosmos-1.0-7b-diffusion-text2world',
    backend: 'nvcf',
    capability: 'text2video',
    // Uses cosmos host directly (no separate NVCF function ID needed)
    estimatedSeconds: 120,
    buildBody: cosmosLegacyText2World,
  },
  // ── NVIDIA Stable Video Diffusion (genai host, image-to-video) ─────────────
  'stabilityai/stable-video-diffusion': {
    id: 'stabilityai/stable-video-diffusion',
    backend: 'nvidia-svd',
    capability: 'image2video',
    estimatedSeconds: 60,
    buildBody: svdBody,
  },
  // ── fal.ai (fallback when no NVIDIA key) ───────────────────────────────────
  'fal-ai/kling-video/v2.1/standard/text-to-video': {
    id: 'fal-ai/kling-video/v2.1/standard/text-to-video',
    backend: 'fal',
    capability: 'text2video',
    estimatedSeconds: 90,
    buildBody: falKlingText2VideoBody,
  },
  'fal-ai/kling-video/v2.1/standard/image-to-video': {
    id: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    backend: 'fal',
    capability: 'image2video',
    estimatedSeconds: 90,
    buildBody: falKlingImage2VideoBody,
  },
}

/** Resolve model: use explicit id if known + capability matches, else default. */
export function resolveVideoModel(
  modelId: string | undefined,
  isImage2Video: boolean,
): VideoModel {
  const m = modelId ? VIDEO_MODELS[modelId] : undefined
  if (m && (!isImage2Video || m.capability === 'image2video')) return m
  return VIDEO_MODELS[isImage2Video ? DEFAULT_IMAGE2VIDEO_MODEL : DEFAULT_VIDEO_MODEL]
}
