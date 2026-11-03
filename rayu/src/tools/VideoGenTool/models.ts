// Per-family request builders for video generation, plus model resolution
// against the SERVER-OWNED catalog.
//
// There is deliberately no model registry in this file. Which video models exist,
// their backend, how long a generation takes, and their per-model request
// defaults all come from the Rayu provider at runtime
// (services/rayuAuth/mediaModels.ts → gateway GET /v1/models?media=video), so
// adding a model needs a backend catalog row and no CLI release.
//
// What DOES stay here is the request SHAPE per family — fal.ai's queue payload
// and the Rayu gateway's DashScope body — because that is API mechanics, not
// catalog data. Vertex Veo builds its own body in vertexVideoClient. NVIDIA
// (NVCF Cosmos, SVD) was removed; its catalog rows are skipped by mediaModels.ts.
//
// SECURITY: only model params + prompt are sent; the key is never logged.
import {
  getCachedMediaModels,
  type MediaModelEntry,
  type VideoCapability,
} from '../../services/rayuAuth/mediaModels.js'
import { resolveReferenceImage } from '../../utils/hostedReferenceImage.js'

export type { VideoCapability }
/** Upstream that serves a video model (mirrors the catalog's `backend`). */
export type VideoBackend =
  | 'fal'
  | 'vertex'
  /** Rayu-hosted: proxied by the gateway under the user's account, no key. */
  | 'rayu'

/** The backend fal.ai models carry in the catalog. */
export const FAL_VIDEO_BACKEND = 'fal'

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
  /**
   * The caller's RAW `input_image` value (an https URL or a local file path),
   * for hosted families that accept a reference image verbatim — the
   * dashscope_video builder turns a URL through unchanged and reads/encodes a
   * local path into a `data:` URL. BYO backends use `image` (base64) instead.
   */
  input_image?: string
}

/** Per-model request defaults from the catalog (`defaultParams`). */
export type VideoDefaults = Record<string, unknown>

/** A catalog entry paired with the request builder for its family. */
export type VideoModel = MediaModelEntry & {
  buildBody: (p: VideoParams) => Record<string, unknown>
}

function num(defaults: VideoDefaults, key: string, fallback: number): number {
  const v = defaults[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(defaults: VideoDefaults, key: string, fallback: string): string {
  const v = defaults[key]
  return typeof v === 'string' && v ? v : fallback
}

// ── Family request builders ──────────────────────────────────────────────────

/**
 * fal.ai Kling. One builder for both directions: the presence of an input image
 * decides, so the catalog can list a text-to-video and an image-to-video model id
 * under the same family.
 */
const falKlingBody = (
  p: VideoParams,
  d: VideoDefaults,
): Record<string, unknown> => {
  const common = {
    prompt: p.prompt,
    duration: p.duration ?? str(d, 'duration', '5'),
    aspect_ratio: p.aspect_ratio ?? str(d, 'aspect_ratio', '16:9'),
  }
  if (p.image) {
    return { ...common, image_url: `data:image/png;base64,${p.image}` }
  }
  return {
    ...common,
    negative_prompt: p.negative_prompt ?? '',
    cfg_scale: num(d, 'cfg_scale', 0.5),
  }
}

/**
 * Vertex Veo bodies are built by vertexVideoClient (buildVeoBody), which owns the
 * `instances`/`parameters` shape and the long-running-operation poll. This
 * placeholder keeps the family known so a Veo model resolves; reaching it means
 * a non-Vertex client was handed a Vertex model.
 */
const veoBody = (p: VideoParams): Record<string, unknown> => ({ prompt: p.prompt })

// ── Rayu-hosted (DashScope video) ────────────────────────────────────────────

/** Ratios the gateway/model accepts, in catalogue order. */
const DASHSCOPE_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const
type DashscopeRatio = (typeof DASHSCOPE_VIDEO_RATIOS)[number]
/** `adaptive` has no numeric ratio to compare against, but the wire accepts it. */
type DashscopeVideoRatio = DashscopeRatio | 'adaptive'

/**
 * The hosted clip-length window. wan3.0-video renders 2–30 s and refuses 1 s, so
 * the floor is 2 rather than the 1 the frame-count maths could produce.
 */
const DASHSCOPE_VIDEO_MIN_SECONDS = 2
const DASHSCOPE_VIDEO_MAX_SECONDS = 30

function ratioValue(r: DashscopeRatio): number {
  const [a, b] = r.split(':').map(Number) as [number, number]
  return a / b
}

/**
 * Duration in seconds from the CLI's frame-count/fps pair, clamped to the
 * hosted 2–30 s window. Either one missing means "let the gateway/model
 * default apply" — not zero.
 */
export function dashscopeVideoDuration(p: VideoParams): number | undefined {
  if (p.num_frames == null || p.fps == null || p.fps <= 0) return undefined
  return Math.max(
    DASHSCOPE_VIDEO_MIN_SECONDS,
    Math.min(
      DASHSCOPE_VIDEO_MAX_SECONDS,
      Math.round(p.num_frames / p.fps),
    ),
  )
}

/**
 * Ratio from an explicit `aspect_ratio` when it is one of the five accepted
 * values, else the nearest accepted ratio to width/height when both are known,
 * else undefined.
 */
export function dashscopeVideoRatio(
  p: VideoParams,
): DashscopeVideoRatio | undefined {
  if (p.aspect_ratio) {
    const trimmed = p.aspect_ratio.trim()
    if (trimmed === 'adaptive') return 'adaptive'
    const exact = DASHSCOPE_VIDEO_RATIOS.find((r) => r === trimmed)
    if (exact) return exact
  }
  if (p.width != null && p.height != null && p.width > 0 && p.height > 0) {
    const target = p.width / p.height
    let best: DashscopeRatio = DASHSCOPE_VIDEO_RATIOS[0]
    let bestDelta = Math.abs(ratioValue(best) - target)
    for (const r of DASHSCOPE_VIDEO_RATIOS.slice(1)) {
      const delta = Math.abs(ratioValue(r) - target)
      if (delta < bestDelta) {
        best = r
        bestDelta = delta
      }
    }
    return best
  }
  return undefined
}

/**
 * DashScope video family (Rayu-hosted gateway). The body is
 * `{model, prompt, duration?, ratio?, negative_prompt?, seed?, image?}`;
 * `image` is sent only when the caller supplied `input_image` and the selected
 * catalog entry carries the `image2video` capability (VideoGenTool refuses
 * otherwise — the gateway maps it to a reference_image input).
 *
 * There is no `resolution` from the caller: each hosted catalog entry IS one
 * priced resolution tier (480P / 720P / 1080P are separate models), and the
 * gateway refuses a request for any other tier. The entry's own tier still
 * reaches the gateway through its `defaultParams`.
 *
 * `defaultParams` spread FIRST so the caller's explicit values win and a
 * dashboard edit still reaches the request. Routing/transport keys (`model`,
 * `image`, `img_url`, `audio_url`, `video`) are stripped from the defaults: an
 * admin-owned row must never be able to swap the billed model or smuggle a
 * reference input the user did not ask for — the caller's own image is added
 * AFTER the spread. `stream` and `mask` are stripped too — the gateway rejects
 * them outright, so a stray default would otherwise 400 every request for that
 * model.
 */
const dashscopeVideoBody = (
  p: VideoParams,
  d: VideoDefaults,
): Record<string, unknown> => {
  const {
    model: _model,
    image: _image,
    img_url: _imgUrl,
    audio_url: _audioUrl,
    video: _video,
    stream: _stream,
    mask: _mask,
    ...defaults
  } = d
  const duration = dashscopeVideoDuration(p)
  const ratio = dashscopeVideoRatio(p)
  return {
    ...defaults,
    prompt: p.prompt,
    ...(duration != null ? { duration } : {}),
    ...(ratio != null ? { ratio } : {}),
    ...(p.negative_prompt ? { negative_prompt: p.negative_prompt } : {}),
    ...(p.seed != null ? { seed: p.seed } : {}),
    // Added after the spread so a defaulted image can never survive, and only
    // when the caller actually supplied one.
    ...(p.input_image
      ? {
          image: resolveReferenceImage(p.input_image, {
            gatewayLabel: 'Rayu video gateway',
          }),
        }
      : {}),
  }
}

/**
 * family → request builder. The ONLY thing the CLI must change for a genuinely
 * new request shape; a new model reusing a known shape needs nothing here. An
 * unknown family fails with a clear, named error (see withBuilder).
 */
export const VIDEO_BODY_BUILDERS: Record<
  string,
  (p: VideoParams, d: VideoDefaults) => Record<string, unknown>
> = {
  'fal-kling': falKlingBody,
  veo: veoBody,
  // Rayu-hosted models (backend 'rayu') proxy through the gateway, which holds
  // the upstream provider key and speaks DashScope video to it.
  dashscope_video: dashscopeVideoBody,
}

const VERTEX_BACKEND = 'vertex'

/**
 * Environment overrides — OVERRIDES ONLY, never the source of truth. When unset
 * (the normal case) the catalog's own `default` flag decides.
 */
function envOverride(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/** The video half of the synchronously-available catalog. */
function cachedVideoModels(): MediaModelEntry[] {
  return getCachedMediaModels().video
}

/** True when a model id targets the Vertex Veo backend, per the catalog. */
export function isVertexVideoModel(
  id: string | undefined,
  models?: MediaModelEntry[],
): boolean {
  if (!id) return false
  const entry = (models ?? cachedVideoModels()).find((m) => m.id === id)
  if (entry) return entry.backend === VERTEX_BACKEND
  // Unknown id (offline, or typed by hand): the id shape is the only signal left,
  // and without it a hand-typed Veo id could never reach Vertex.
  return /^veo-/i.test(id)
}

/**
 * Pick the model to use.
 *
 * `opts.backends` is the ORDERED list of backends the caller can actually serve.
 * It is both a filter and a preference: a default is chosen from the first backend
 * in the list that has a usable model, so a client never resolves a default it
 * cannot POST to (which would surface as "API key not configured" for a model the
 * user never chose, or as a bogus routing error).
 *
 * Order: the id the caller named → the `default` model of the most-preferred
 * servable backend → the first usable model of that backend.
 *
 * A named id that is NOT in the catalog is an ERROR, never a silent substitution.
 * A named id that IS in the catalog but cannot do the requested operation DOES
 * fall through to the default — that is how `input_image` routes a text2video-only
 * model to an image2video one, and it is deliberate.
 */
export function resolveVideoModel(
  models: MediaModelEntry[],
  modelId: string | undefined,
  isImage2Video: boolean,
  opts?: { backends?: string[] },
): VideoModel {
  const capability: VideoCapability = isImage2Video ? 'image2video' : 'text2video'
  const backends = opts?.backends

  const known = modelId ? models.find((m) => m.id === modelId) : undefined
  if (modelId && !known) {
    throw new Error(
      `Unknown video model "${modelId}". Available: ` +
        `${models.map((m) => m.id).join(', ') || '(none configured)'}`,
    )
  }
  if (known && backends && !backends.includes(known.backend)) {
    // The tool routes by the model's backend before calling us, so this means the
    // request reached the wrong client — a Rayu bug, not a user error.
    throw new Error(
      `Video model "${known.id}" is served by the "${known.backend}" backend, which this ` +
        `client does not handle. This is a Rayu routing bug — please report it.`,
    )
  }

  const capable = models.filter((m) => m.capabilities.includes(capability))
  const named = known?.capabilities.includes(capability) ? known : undefined
  // Only models this client can actually serve, ordered so the FIRST entry is the
  // right default.
  const chosen = named ?? orderByBackendPreference(capable, backends)[0]

  if (!chosen) {
    throw new Error(
      `No ${capability} model is available` +
        `${backends ? ` for the ${backends.join('/')} backend(s)` : ''}. ` +
        `Add one in the Rayu dashboard (Media models), or check your connection so the CLI ` +
        `can fetch the catalog.`,
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
 * Keep a model id only if the CLI can still act on it — see
 * retainKnownImageModel for the full rationale. A selection remembered from
 * `/model_video_generation` that has left the catalog is dropped (the caller then
 * gets the current default) rather than failing every later generation; a
 * hand-written `veo-*` id is kept because the Vertex client honours it verbatim.
 */
export function retainKnownVideoModel(
  models: MediaModelEntry[],
  id: string | undefined,
): string | undefined {
  if (!id) return undefined
  if (models.some((m) => m.id === id)) return id
  if (isVertexVideoModel(id, models)) return id
  return undefined
}

/** Attach the family's request builder, failing clearly on an unknown family. */
export function withBuilder(entry: MediaModelEntry): VideoModel {
  const builder = VIDEO_BODY_BUILDERS[entry.family]
  if (!builder) {
    throw new Error(
      `Video model "${entry.id}" uses request family "${entry.family}", which this ` +
        `version of Rayu does not know how to build. Update the CLI ` +
        `(npm i -g @rayu-dev/rayu-cli) or pick another model.`,
    )
  }
  const defaults = entry.defaultParams ?? {}
  return { ...entry, buildBody: (p: VideoParams) => builder(p, defaults) }
}

/**
 * Default model id for a backend + capability, for callers that only need the id
 * (e.g. the Vertex client's URL). Returns undefined when the catalog has none.
 */
export function defaultVideoModelId(
  models: MediaModelEntry[],
  backend: string,
  isImage2Video: boolean,
): string | undefined {
  const capability: VideoCapability = isImage2Video ? 'image2video' : 'text2video'
  const usable = models.filter(
    (m) => m.backend === backend && m.capabilities.includes(capability),
  )
  // Only Vertex has a pin; fal follows the catalog's own default.
  const override =
    backend === VERTEX_BACKEND ? envOverride('VERTEX_VIDEO_MODEL') : undefined
  const overridden = override ? usable.find((m) => m.id === override) : undefined
  return (overridden ?? usable.find((m) => m.isDefault) ?? usable[0])?.id
}
