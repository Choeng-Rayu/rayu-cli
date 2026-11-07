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
// SCOPE HAS SHRUNK TO NOTHING: BOTH lists are empty. Video generation became
// Rayu-hosted only first (the fal.ai and Vertex Veo clients were removed), and
// image generation followed — image is served exclusively by the Rayu-hosted
// gateway, so an offline built-in row could only advertise a model the product no
// longer routes to. Keeping it would have re-exposed Vertex Imagen on a machine
// with no Google credentials, which is exactly the failure this replaced.
//
// Entries are tagged `source: 'fallback'` so the UI can say so.
//
// Ordering is significant: it reproduces the old registries' order, which decides
// ties when no model carries the `default` flag for a capability.
import type { MediaCatalog, MediaModelEntry } from './mediaModels.js'

/**
 * EMPTY, deliberately — image is Rayu-hosted only.
 *
 * The hosted catalog is server-owned, so there is nothing a client can invent:
 * a built-in row would advertise a model the gateway may not have (or may have
 * priced differently). Offline with no session and no Rayu API key the image
 * picker lists nothing and explains why, which is the honest answer now that
 * there is no bring-your-own image backend to fall back to.
 */
const FALLBACK_IMAGE: MediaModelEntry[] = []

/**
 * EMPTY, deliberately — video is Rayu-hosted only, for the same reason.
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
