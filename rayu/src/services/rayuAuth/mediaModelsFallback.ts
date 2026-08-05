// OFFLINE fallback for the image/video model catalog.
//
// ────────────────────────────────────────────────────────────────────────────
// THIS IS NOT THE SOURCE OF TRUTH, AND IT IS FROZEN.
// ────────────────────────────────────────────────────────────────────────────
// The catalog lives in the Rayu backend (`media_models`) and reaches the CLI
// through the gateway (`GET /v1/models?media=all`). Whenever that catalog is
// reachable it REPLACES this list wholesale — nothing here is merged into it, and
// a model deleted server-side does not survive here.
//
// DO NOT ADD MODELS TO THIS FILE. A new image or video model belongs in
// rayu-backend/src/media-models/media-models.constants.ts (or straight into the
// dashboard), which needs no CLI release. This list is deliberately frozen at the
// exact set the CLI shipped before catalog discovery existed; growing it would
// recreate the hardcoded registry that discovery replaced.
//
// WHY IT EXISTS AT ALL: the one case of **no gateway** — `USE_RAYU_OAUTH` off, or
// the user not signed in. Media generation in that mode runs entirely on the
// user's OWN key (NVIDIA_API_KEY / FAL_KEY / GCP credentials) and never touches
// Rayu infrastructure, so disabling the tools would be a pure regression for BYOK
// users with no security or correctness upside (Option B of the plan). It mirrors
// the previous hardcoded registries one-for-one precisely so that a direct-key
// user loses NO model they could use before.
//
// Entries are tagged `source: 'fallback'` so the UI can say so.
//
// Ordering is significant: it reproduces the old registries' order, which decides
// ties when no model carries the `default` flag for a capability.
import type { MediaCatalog, MediaModelEntry } from './mediaModels.js'

const FALLBACK_IMAGE: MediaModelEntry[] = [
  {
    // Guidance-distilled: the NVIDIA endpoint requires cfg_scale<=0, 1-4 steps.
    id: 'black-forest-labs/flux.1-schnell',
    label: 'FLUX.1 Schnell',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'flux',
    defaultParams: { cfg_scale: 0, steps: 4 },
    isDefault: true,
  },
  {
    // Uses real guidance, so a much higher cfg_scale and step count.
    id: 'black-forest-labs/flux.1-dev',
    label: 'FLUX.1 Dev',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'flux',
    defaultParams: { cfg_scale: 3.5, steps: 50 },
  },
  {
    id: 'stabilityai/stable-diffusion-3.5-large',
    label: 'Stable Diffusion 3.5 Large',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'sd3',
    defaultParams: { cfg_scale: 4.5, steps: 50, aspect_ratio: '1:1' },
  },
  {
    // In-context editing: the client uploads the image as an NVCF asset first.
    id: 'black-forest-labs/flux.1-kontext-dev',
    label: 'FLUX.1 Kontext Dev (edit)',
    mediaType: 'image',
    capabilities: ['edit'],
    backend: 'nvidia',
    family: 'kontext',
    defaultParams: { cfg_scale: 3.5, steps: 30 },
    isDefault: true,
  },
  {
    id: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
    isDefault: true,
  },
  {
    id: 'imagen-4.0-fast-generate-001',
    label: 'Imagen 4 Fast',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
  },
  {
    id: 'imagen-4.0-ultra-generate-001',
    label: 'Imagen 4 Ultra',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
  },
  {
    // Imagen 4 is generate-only; editing needs the Imagen 3 capability model.
    id: 'imagen-3.0-capability-001',
    label: 'Imagen 3 Capability (edit)',
    mediaType: 'image',
    capabilities: ['edit'],
    backend: 'vertex',
    family: 'imagen',
    isDefault: true,
  },
]

const FALLBACK_VIDEO: MediaModelEntry[] = [
  {
    // Takes an OPTIONAL input image, so it serves both video operations — which
    // is why the old hardcoded DEFAULT_IMAGE2VIDEO_MODEL was this same model.
    id: 'nvidia/cosmos-predict1-5b',
    label: 'Cosmos Predict1 5B',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'nvcf',
    family: 'cosmos-predict1',
    nvcfFunctionId: 'eef816a3-3940-413b-93c9-513ae29f34f9',
    estimatedSeconds: 120,
    isDefault: true,
  },
  {
    id: 'nvidia/cosmos-transfer1-7b',
    label: 'Cosmos Transfer1 7B',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'nvcf',
    family: 'cosmos-transfer1',
    nvcfFunctionId: 'abb63707-47ee-497c-81a3-37e685bacdc6',
    estimatedSeconds: 120,
  },
  {
    id: 'nvidia/cosmos3-nano',
    label: 'Cosmos3 Nano',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'nvcf',
    family: 'cosmos3-nano',
    nvcfFunctionId: 'd09cd49d-d7f2-4361-928f-ea22af707249',
    estimatedSeconds: 90,
  },
  {
    // Legacy Triton format on the dedicated cosmos host — no NVCF function id.
    id: 'nvidia/cosmos-1.0-7b-diffusion-text2world',
    label: 'Cosmos 1.0 7B Text2World',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'nvcf',
    family: 'cosmos-legacy',
    estimatedSeconds: 120,
  },
  {
    id: 'stabilityai/stable-video-diffusion',
    label: 'Stable Video Diffusion',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'nvidia-svd',
    family: 'svd',
    estimatedSeconds: 60,
    defaultParams: { cfg_scale: 1.8, motion_bucket_id: 127 },
  },
  {
    id: 'fal-ai/kling-video/v2.1/standard/text-to-video',
    label: 'Kling Video 2.1 (text-to-video)',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'fal',
    family: 'fal-kling',
    estimatedSeconds: 90,
    defaultParams: { duration: '5', aspect_ratio: '16:9', cfg_scale: 0.5 },
    isDefault: true,
  },
  {
    id: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    label: 'Kling Video 2.1 (image-to-video)',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'fal',
    family: 'fal-kling',
    estimatedSeconds: 90,
    defaultParams: { duration: '5', aspect_ratio: '16:9' },
    isDefault: true,
  },
  // GA ids only. Google retired the …-generate-preview ids on 2026-04-02.
  {
    id: 'veo-3.1-generate-001',
    label: 'Veo 3.1',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 120,
    isDefault: true,
  },
  {
    id: 'veo-3.1-fast-generate-001',
    label: 'Veo 3.1 Fast',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 90,
  },
  {
    id: 'veo-3.0-generate-001',
    label: 'Veo 3.0',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 120,
  },
  {
    id: 'veo-3.0-fast-generate-001',
    label: 'Veo 3.0 Fast',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 90,
  },
]

/** The offline catalog. Fresh copies, so a caller cannot mutate the fallback. */
export function fallbackMediaCatalog(): MediaCatalog {
  return {
    image: FALLBACK_IMAGE.map((m) => ({ ...m })),
    video: FALLBACK_VIDEO.map((m) => ({ ...m })),
    source: 'fallback',
    fetchedAt: 0,
  }
}
