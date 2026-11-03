// Per-family request builders for image generation, plus model resolution
// against the SERVER-OWNED catalog.
//
// There is deliberately no model registry in this file. Which image models exist,
// what they can do, which backend serves them, and their per-model request
// defaults all come from the Rayu provider at runtime
// (services/rayuAuth/mediaModels.ts → gateway GET /v1/models?media=image), so
// adding a model needs a backend catalog row and no CLI release.
//
// What DOES stay here is the request SHAPE per family: the flat body the Rayu
// gateway's /v1/images/generations route accepts. Vertex Imagen builds its own
// body in vertexImageClient. NVIDIA genai (FLUX / Stable Diffusion / Kontext) was
// removed; its catalog rows are skipped by mediaModels.ts.
//
// SECURITY: only the model id + user prompt/params are sent; credentials are
// added by the client and never logged.
import {
  getCachedMediaModels,
  type ImageCapability,
  type MediaModelEntry,
} from '../../services/rayuAuth/mediaModels.js'
import { resolveReferenceImage } from '../../utils/hostedReferenceImage.js'

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
  /** base64-encoded input image (no data-URI prefix) for Vertex Imagen edits. */
  image?: string
  /**
   * The caller's RAW `input_image` value (an https URL or a local file path),
   * for hosted families that accept a reference image verbatim — the gateway
   * body builder turns an https URL through unchanged and reads/encodes a
   * local path into a `data:` URL. Vertex uses `image` (base64) instead.
   */
  input_image?: string
}

/** Per-model request defaults from the catalog (`defaultParams`). */
export type ImageDefaults = Record<string, unknown>

/**
 * A catalog entry paired with the request builder for its family — what the
 * clients actually need.
 */
export type ImageModel = MediaModelEntry & {
  buildBody: (p: ImageParams) => Record<string, unknown>
}

/**
 * Vertex Imagen builds its own `instances`/`parameters` body in
 * vertexImageClient (buildImagenBody), so reaching this is a routing bug — a
 * non-Vertex client was handed a Vertex model.
 */
const vertexUnsupported = (): Record<string, unknown> => {
  throw new Error('Vertex Imagen models are built by vertexImageClient, not buildBody')
}

// ── OpenAI Images (Rayu-hosted) ──────────────────────────────────────────────

/** Longest side of an aspect-ratio-derived `size`, per the gateway contract. */
const OPENAI_IMAGE_LONG_SIDE = 1024
/** Allowed range for the derived short side (the gateway rejects outside it). */
const OPENAI_IMAGE_MIN_SIDE = 512
const OPENAI_IMAGE_MAX_SIDE = 2048

function roundTo8(n: number): number {
  return Math.round(n / 8) * 8
}

/**
 * Translate the CLI's width/height/aspect_ratio params into an OpenAI Images
 * `WxH` size string, or undefined to let the gateway/model default apply.
 *
 * - width AND height → used verbatim (`1024x768`).
 * - aspect_ratio only → long side 1024, short side = 1024/ratio rounded to a
 *   multiple of 8 and clamped to 512..2048, preserving orientation:
 *   `1:1` → `1024x1024`, `16:9` → `1024x576`, `9:16` → `576x1024`.
 * - neither → undefined (the gateway applies the model's `default_size`).
 *
 * A malformed ratio is ignored rather than thrown: it is a user-supplied hint,
 * and failing the whole generation over it would be worse than the default size.
 */
export function sizeFromParams(p: ImageParams): string | undefined {
  if (p.width != null && p.height != null) {
    return `${p.width}x${p.height}`
  }
  if (!p.aspect_ratio) return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:\/]\s*(\d+(?:\.\d+)?)\s*$/.exec(
    p.aspect_ratio,
  )
  if (!match) return undefined
  const a = Number(match[1])
  const b = Number(match[2])
  if (!(a > 0) || !(b > 0)) return undefined

  const landscape = a >= b
  const ratio = landscape ? a / b : b / a
  const short = Math.min(
    OPENAI_IMAGE_MAX_SIDE,
    Math.max(OPENAI_IMAGE_MIN_SIDE, roundTo8(OPENAI_IMAGE_LONG_SIDE / ratio)),
  )
  return landscape
    ? `${OPENAI_IMAGE_LONG_SIDE}x${short}`
    : `${short}x${OPENAI_IMAGE_LONG_SIDE}`
}

/**
 * OpenAI Images family (Rayu-hosted gateway). This is the de-facto standard
 * shape: `{model, prompt, n, size?, negative_prompt?, seed?}`. The model id and
 * `response_format` are added by rayuImageClient.
 *
 * The catalog's `defaultParams` (e.g. Qwen's `prompt_extend`) spread FIRST, so
 * the caller's explicit values win and a dashboard edit still reaches the
 * request. `image`/`mask` are stripped from the DEFAULTS: an admin-owned row
 * must never smuggle an edit payload the user did not ask for. The CALLER's
 * image is the opposite — it is added AFTER the spread, and only when the tool
 * already verified the selected entry advertises the `edit` capability (a
 * generate-only hosted model is refused upstream of this builder, so an opaque
 * upstream 400 is never earned).
 *
 * `model` and `response_format` are stripped for a different reason: they are
 * routing/transport fields, not model knobs. A dashboard row that carried either
 * could otherwise replace the model the caller selected, or make the gateway
 * answer with a URL the CLI did not ask for. rayuImageClient sets both after the
 * spread as a second line of defence.
 */
const openaiImagesBody = (
  p: ImageParams,
  d: ImageDefaults,
): Record<string, unknown> => {
  // Never forward a defaulted edit payload or a routing field, even if a
  // misconfigured defaultParams row carries one.
  const {
    image: _image,
    mask: _mask,
    model: _model,
    response_format: _responseFormat,
    stream: _stream,
    ...defaults
  } = d
  const size = sizeFromParams(p)
  return {
    ...defaults,
    prompt: p.prompt,
    n: 1,
    ...(size ? { size } : {}),
    ...(p.negative_prompt ? { negative_prompt: p.negative_prompt } : {}),
    ...(p.seed != null ? { seed: p.seed } : {}),
    // Added after the spread so a defaulted image can never survive, and only
    // when the caller actually supplied one (the gateway maps `image` to an
    // image-to-image edit call on the edit-capable families it advertises).
    ...(p.input_image
      ? {
          image: resolveReferenceImage(p.input_image, {
            gatewayLabel: 'Rayu image gateway',
          }),
        }
      : {}),
  }
}

/**
 * family → request builder. This map is the ONLY thing the CLI has to change for
 * a genuinely new request shape; a new model reusing a known shape needs nothing
 * here. An unknown family fails with a clear, named error (see withBuilder).
 */
export const IMAGE_BODY_BUILDERS: Record<
  string,
  (p: ImageParams, d: ImageDefaults) => Record<string, unknown>
> = {
  imagen: vertexUnsupported,
  // Rayu-hosted models (backend 'rayu') proxy through the gateway, which speaks
  // OpenAI Images to whichever upstream the admin configured.
  openai_images: openaiImagesBody,
  // DashScope multimodal (Qwen Image): the gateway exposes it on the SAME
  // /v1/images/generations contract and maps `image` to the upstream
  // image-to-image edit call, so the normalized body shape is identical —
  // capabilities (not the family) decide whether an edit is accepted.
  dashscope_multimodal: openaiImagesBody,
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
  // shape is the only signal left, so keep the narrow prefix check as a last
  // resort: without it a hand-typed Imagen id could never reach Vertex.
  return /^imagen-/i.test(id)
}

/** The image half of the synchronously-available catalog. */
function cachedImageModels(): MediaModelEntry[] {
  return getCachedMediaModels().image
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
  // Only Vertex has a pin: it is the one BYO image backend.
  const override =
    backend === VERTEX_BACKEND
      ? envOverride(isEdit ? 'VERTEX_EDIT_MODEL' : 'VERTEX_IMAGE_MODEL')
      : undefined
  const overridden = override ? usable.find((m) => m.id === override) : undefined
  return (overridden ?? usable.find((m) => m.isDefault) ?? usable[0])?.id
}
