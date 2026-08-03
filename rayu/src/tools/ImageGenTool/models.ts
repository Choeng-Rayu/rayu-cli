// Per-family request builders for image generation, plus model resolution
// against the SERVER-OWNED catalog.
//
// There is deliberately no model registry in this file. Which image models exist,
// what they can do, which backend serves them, and their per-model request
// defaults all come from the Rayu provider at runtime
// (services/rayuAuth/mediaModels.ts → gateway GET /v1/models?media=image), so
// adding a model needs a backend catalog row and no CLI release.
//
// What DOES stay here is the request SHAPE per family: how NVIDIA's genai host
// wants a FLUX body vs a Stable Diffusion body vs a Kontext edit body. That is
// third-party API mechanics, not catalog data, and moving it server-side would
// mean proxying image traffic the gateway holds no key for.
//
// SECURITY: only the model id + user prompt/params are sent; the API key is added
// by the client and never logged.
import {
  getCachedMediaModels,
  type ImageCapability,
  type MediaModelEntry,
} from '../../services/rayuAuth/mediaModels.js'

export const NVIDIA_IMAGE_HOST =
  process.env.NVIDIA_IMAGE_HOST || 'https://ai.api.nvidia.com/v1/genai'
export const NVCF_ASSET_HOST =
  process.env.NVCF_ASSET_HOST || 'https://api.nvcf.nvidia.com/v2/nvcf/assets'

export type { ImageCapability }

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

/**
 * Per-model request defaults from the catalog (`defaultParams`). Read with
 * `num()`/`str()` below so a mistyped dashboard value can never put a string
 * where the upstream expects a number.
 */
export type ImageDefaults = Record<string, unknown>

/**
 * A catalog entry paired with the request builder for its family — what the
 * clients actually need.
 */
export type ImageModel = MediaModelEntry & {
  buildBody: (p: ImageParams) => Record<string, unknown>
}

function num(defaults: ImageDefaults, key: string, fallback: number): number {
  const v = defaults[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(defaults: ImageDefaults, key: string, fallback: string): string {
  const v = defaults[key]
  return typeof v === 'string' && v ? v : fallback
}

// ── Family request builders ──────────────────────────────────────────────────
// Each takes the caller's params plus the model's catalog defaults. The built-in
// numbers are last-resort defaults for a catalog row that sets none — the
// dashboard value always wins.

/**
 * FLUX family. Guidance-distilled variants (flux.1-schnell) need cfg_scale<=0 and
 * 1-4 steps; guidance variants (flux.1-dev) need cfg_scale ~3.5 and many steps.
 * That difference is per-MODEL data, so it arrives in `defaultParams` and one
 * builder serves the whole family.
 */
const fluxBody = (
  p: ImageParams,
  d: ImageDefaults,
): Record<string, unknown> => ({
  prompt: p.prompt,
  cfg_scale: p.cfg_scale ?? num(d, 'cfg_scale', 3.5),
  width: p.width ?? num(d, 'width', 1024),
  height: p.height ?? num(d, 'height', 1024),
  steps: p.steps ?? num(d, 'steps', 4),
  seed: p.seed ?? 0,
})

/** Stable Diffusion 3.5: aspect_ratio + negative_prompt, many steps. */
const sdBody = (p: ImageParams, d: ImageDefaults): Record<string, unknown> => ({
  prompt: p.prompt,
  cfg_scale: p.cfg_scale ?? num(d, 'cfg_scale', 4.5),
  aspect_ratio: p.aspect_ratio ?? str(d, 'aspect_ratio', '1:1'),
  steps: p.steps ?? num(d, 'steps', 50),
  seed: p.seed ?? 0,
  negative_prompt: p.negative_prompt ?? '',
})

/**
 * FLUX.1-Kontext in-context editing: the genai endpoint rejects inline base64
 * ("Expected: example_id, got: base64"), so the client uploads the image as an
 * NVCF asset first and fills in imageAssetId + imageMimeType.
 */
const kontextBody = (
  p: ImageParams,
  d: ImageDefaults,
): Record<string, unknown> => {
  if (!p.imageAssetId) {
    throw new Error('kontextBody requires imageAssetId (asset must be uploaded first)')
  }
  const mime = p.imageMimeType ?? 'image/jpeg'
  return {
    prompt: p.prompt,
    image: `data:${mime};example_id,${p.imageAssetId}`,
    cfg_scale: p.cfg_scale ?? num(d, 'cfg_scale', 3.5),
    steps: p.steps ?? num(d, 'steps', 30),
    seed: p.seed ?? 0,
  }
}

/**
 * Vertex Imagen builds its own `instances`/`parameters` body in
 * vertexImageClient (buildImagenBody), so reaching this is a routing bug — the
 * NVIDIA client was handed a Vertex model.
 */
const vertexUnsupported = (): Record<string, unknown> => {
  throw new Error('Vertex Imagen models are built by vertexImageClient, not buildBody')
}

/**
 * family → request builder. This map is the ONLY thing the CLI has to change for
 * a genuinely new request shape; a new model reusing a known shape needs nothing
 * here. An unknown family fails with a clear, named error (see resolveModel).
 */
export const IMAGE_BODY_BUILDERS: Record<
  string,
  (p: ImageParams, d: ImageDefaults) => Record<string, unknown>
> = {
  flux: fluxBody,
  sd3: sdBody,
  kontext: kontextBody,
  imagen: vertexUnsupported,
}

/** Families whose bodies are built by the Vertex client instead of here. */
const VERTEX_BACKEND = 'vertex'

/**
 * Environment overrides. These are OVERRIDES ONLY — a way to pin a model for a
 * one-off run or a test — never the source of truth. When unset (the normal
 * case) the catalog's own `default` flag decides.
 */
function envOverride(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/** True when a model id targets the Vertex Imagen backend, per the catalog. */
export function isVertexImageModel(
  id: string | undefined,
  models?: MediaModelEntry[],
): boolean {
  if (!id) return false
  const catalog = models ?? cachedImageModels()
  const entry = catalog.find((m) => m.id === id)
  if (entry) return entry.backend === VERTEX_BACKEND
  // Not in the catalog we have (offline, or an id the user typed by hand). The id
  // shape is the only signal left, and getting this wrong would send an Imagen
  // request to NVIDIA's host, so keep the narrow prefix check as a last resort.
  return /^imagen-/i.test(id)
}

/** The image half of the synchronously-available catalog. */
function cachedImageModels(): MediaModelEntry[] {
  return getCachedMediaModels().image
}

/**
 * Pick the model to use.
 *
 * `opts.backends` is the ORDERED list of backends the caller can actually serve;
 * it is both a filter and a preference, so a client never resolves a default it
 * cannot POST to.
 *
 * Order: the id the caller named → the env override → the `default` model of the
 * most-preferred servable backend → its first usable model.
 *
 * A named id that is NOT in the catalog is an ERROR, never a silent substitution:
 * generating with a different model than the one asked for is worse than failing.
 * A named id that IS in the catalog but cannot do the requested operation DOES
 * fall through to the default — that is how `input_image` routes a generate-only
 * model to the edit model, and it is deliberate.
 *
 * Also throws when the catalog has nothing for the operation, or when the chosen
 * model's family has no request builder in this CLI build — both are actionable
 * ("update the CLI" / "add a model in the dashboard") and far better than an
 * opaque upstream 400.
 */
export function resolveModel(
  models: MediaModelEntry[],
  modelId: string | undefined,
  isEdit: boolean,
  opts?: { backends?: string[] },
): ImageModel {
  const capability: ImageCapability = isEdit ? 'edit' : 'generate'
  const backends = opts?.backends

  const known = modelId ? models.find((m) => m.id === modelId) : undefined
  if (modelId && !known) {
    throw new Error(
      `Unknown image model "${modelId}". Available: ` +
        `${models.map((m) => m.id).join(', ') || '(none configured)'}`,
    )
  }
  if (known && backends && !backends.includes(known.backend)) {
    // The tool routes by the model's backend before calling us, so this means the
    // request reached the wrong client — a Rayu bug, not a user error.
    throw new Error(
      `Image model "${known.id}" is served by the "${known.backend}" backend, which this ` +
        `client does not handle. This is a Rayu routing bug — please report it.`,
    )
  }

  const capable = models.filter((m) => m.capabilities.includes(capability))
  const named = known?.capabilities.includes(capability) ? known : undefined
  // Only models this client can actually serve, ordered so the FIRST entry is the
  // right default: preferred backend first, and the flagged default first within
  // each backend. The env override is looked up in this same list, so it can pin a
  // model but never smuggle in one the caller cannot POST to.
  const usable = orderByBackendPreference(capable, backends)
  const override = envOverride(isEdit ? 'NVIDIA_EDIT_MODEL' : 'NVIDIA_IMAGE_MODEL')
  const chosen =
    named ?? (override ? usable.find((m) => m.id === override) : undefined) ?? usable[0]

  if (!chosen) {
    throw new Error(
      `No ${capability === 'edit' ? 'image-editing' : 'image-generation'} model is available` +
        `${backends ? ` for the ${backends.join('/')} backend(s)` : ''}. ` +
        `Add one in the Rayu dashboard (Media models), or check your connection so the CLI can ` +
        `fetch the catalog.`,
    )
  }
  return withBuilder(chosen)
}

/**
 * Models the caller can serve, in default-selection order: backends in the given
 * preference order, and within each backend the catalog's `default` flag first,
 * then server order (sortOrder). So `list[0]` is the model to use when nothing was
 * named, and a flat `find` never jumps to a less-preferred backend.
 */
function orderByBackendPreference(
  capable: MediaModelEntry[],
  backends: string[] | undefined,
): MediaModelEntry[] {
  const defaultFirst = (ms: MediaModelEntry[]): MediaModelEntry[] => [
    ...ms.filter((m) => m.isDefault),
    ...ms.filter((m) => !m.isDefault),
  ]
  if (!backends) return defaultFirst(capable)
  return backends.flatMap((b) =>
    defaultFirst(capable.filter((m) => m.backend === b)),
  )
}

/**
 * Keep a model id only if the CLI can still act on it.
 *
 * The id a user picked earlier via `/model_image_generation` is persisted in
 * their config, but the catalog is server-owned: an admin can remove a model, a
 * plan change can withdraw it, and offline the CLI only has its built-ins. A
 * choice made weeks ago must not turn every later generation into an error, so a
 * stale selection is DROPPED (the caller then gets the current default) — the
 * same rule the chat model picker applies to a removed hosted model.
 *
 * Vertex ids are kept even when absent from the catalog, because the Vertex
 * client honours a hand-written `imagen-*` id verbatim (so a brand-new Google
 * model works before the dashboard has it).
 *
 * An id passed EXPLICITLY as a tool argument is validated separately and rejected
 * loudly; this is only for the remembered preference.
 */
export function retainKnownImageModel(
  models: MediaModelEntry[],
  id: string | undefined,
): string | undefined {
  if (!id) return undefined
  if (models.some((m) => m.id === id)) return id
  if (isVertexImageModel(id, models)) return id
  return undefined
}

/** Attach the family's request builder, failing clearly on an unknown family. */
export function withBuilder(entry: MediaModelEntry): ImageModel {
  const builder = IMAGE_BODY_BUILDERS[entry.family]
  if (!builder) {
    throw new Error(
      `Image model "${entry.id}" uses request family "${entry.family}", which this ` +
        `version of Rayu does not know how to build. Update the CLI ` +
        `(npm i -g @rayu-dev/rayu-cli) or pick another model.`,
    )
  }
  const defaults = entry.defaultParams ?? {}
  return { ...entry, buildBody: (p: ImageParams) => builder(p, defaults) }
}

/**
 * Default model id for a backend + capability, for callers that only need the id
 * (e.g. the Vertex client's URL). Returns undefined when the catalog has none.
 */
export function defaultImageModelId(
  models: MediaModelEntry[],
  backend: string,
  isEdit: boolean,
): string | undefined {
  const capability: ImageCapability = isEdit ? 'edit' : 'generate'
  const usable = models.filter(
    (m) => m.backend === backend && m.capabilities.includes(capability),
  )
  const override = envOverride(
    backend === VERTEX_BACKEND
      ? isEdit
        ? 'VERTEX_EDIT_MODEL'
        : 'VERTEX_IMAGE_MODEL'
      : isEdit
        ? 'NVIDIA_EDIT_MODEL'
        : 'NVIDIA_IMAGE_MODEL',
  )
  const overridden = override ? usable.find((m) => m.id === override) : undefined
  return (overridden ?? usable.find((m) => m.isDefault) ?? usable[0])?.id
}
