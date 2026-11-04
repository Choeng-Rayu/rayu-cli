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
// the user not signed in. It mirrors the previous hardcoded registries
// entry-for-entry, minus the NVIDIA backends (genai FLUX / Stable Diffusion /
// Kontext, NVCF Cosmos, SVD), which the CLI no longer serves.
//
// SCOPE SHRANK when video generation became Rayu-hosted only: VIDEO is now an
// EMPTY list, because the fal.ai and Vertex Veo clients were removed and the
// hosted video catalog is server-owned. IMAGE keeps its Vertex Imagen rows, which
// are the remaining bring-your-own backend.
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

/**
 * EMPTY, deliberately.
 *
 * Video generation is Rayu-hosted only and the hosted catalog is server-owned, so
 * there is nothing a client can invent here: a built-in row would advertise a
 * model the gateway may not have. Offline with no session and no Rayu API key the
 * video picker therefore lists nothing and explains why — which is the honest
 * answer, since there is no BYO video backend to fall back to any more (the fal.ai
 * and Vertex Veo clients were removed).
 */
const FALLBACK_VIDEO: MediaModelEntry[] = []

/** The offline catalog. Fresh copies, so a caller cannot mutate the fallback. */
export function fallbackMediaCatalog(): MediaCatalog {
  return {
    image: FALLBACK_IMAGE.map((m) => ({ ...m })),
    video: FALLBACK_VIDEO.map((m) => ({ ...m })),
    source: 'fallback',
    fetchedAt: 0,
  }
}
