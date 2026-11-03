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
// user's OWN credentials (FAL_KEY / GCP credentials) and never touches Rayu
// infrastructure, so disabling the tools would be a pure regression for BYOK
// users with no security or correctness upside (Option B of the plan). It mirrors
// the previous hardcoded registries entry-for-entry, minus the NVIDIA backends
// (genai FLUX / Stable Diffusion / Kontext, NVCF Cosmos, SVD), which the CLI no
// longer serves.
//
// Entries are tagged `source: 'fallback'` so the UI can say so.
//
// Ordering is significant: it reproduces the old registries' order, which decides
// ties when no model carries the `default` flag for a capability.
import type { MediaCatalog, MediaModelEntry } from './mediaModels.js'

const FALLBACK_IMAGE: MediaModelEntry[] = [
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
