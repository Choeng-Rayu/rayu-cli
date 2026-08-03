// Per-family request builders for video generation, plus model resolution
// against the SERVER-OWNED catalog.
//
// There is deliberately no model registry in this file. Which video models exist,
// their backend, their NVCF function id, how long a generation takes, and their
// per-model request defaults all come from the Rayu provider at runtime
// (services/rayuAuth/mediaModels.ts → gateway GET /v1/models?media=video), so
// adding a model needs a backend catalog row and no CLI release.
//
// What DOES stay here is the request SHAPE per family — Triton command strings
// for Cosmos, the SVD data-URI body, fal.ai's queue payload — because that is
// third-party API mechanics, not catalog data.
//
// Async pattern (NVCF): HTTP 202 + NVCF-REQID header → poll pexec/status/{reqId}.
// SECURITY: only model params + prompt are sent; the key is never logged.
import {
  getCachedMediaModels,
  type MediaModelEntry,
  type VideoCapability,
} from '../../services/rayuAuth/mediaModels.js'

export type { VideoCapability }
/** Upstream that serves a video model (mirrors the catalog's `backend`). */
export type VideoBackend = 'nvcf' | 'nvidia-svd' | 'fal' | 'vertex'

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

/** Per-model request defaults from the catalog (`defaultParams`). */
export type VideoDefaults = Record<string, unknown>

/** A catalog entry paired with the request builder for its family. */
export type VideoModel = MediaModelEntry & {
  buildBody: (p: VideoParams) => Record<string, unknown>
}

export const NVIDIA_GENAI_HOST =
  process.env.NVIDIA_GENAI_HOST || 'https://ai.api.nvidia.com/v1/genai'

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
 * cosmos-predict1: Triton PREDICT_V2 via NVCF. The internal model name is
 * 'edify' and the exact command API name is undocumented — visit
 * https://build.nvidia.com/nvidia/cosmos-predict1-5b while logged in to see the
 * working playground sample. Best known format from testing: a `command` input
 * with a "t2v"/"i2v" prefix. Takes an OPTIONAL input image, which is why the
 * catalog can list it for both video capabilities.
 */
const cosmosPredict1Body = (p: VideoParams): Record<string, unknown> => {
  const isVideo = !p.image
  // Underscore/space-normalised prompt: quotes and newlines break the command parse.
  const safePrompt = p.prompt.replace(/["\\']/g, '').replace(/\s+/g, ' ').trim()
  const cmd = isVideo
    ? `t2v --prompt="${safePrompt}"${p.seed != null ? ` --seed=${p.seed}` : ''}`
    : `i2v --prompt="${safePrompt}"${p.image ? ` --input_image=${p.image}` : ''}${p.seed != null ? ` --seed=${p.seed}` : ''}`
  return {
    inputs: [{ name: 'command', shape: [1], datatype: 'BYTES', data: [cmd] }],
    outputs: [{ name: 'status', datatype: 'BYTES', shape: [1] }],
  }
}

/** cosmos-transfer1: video-to-video style transfer + prompt. */
const cosmosTransfer1Body = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  seed: p.seed ?? 0,
})

/** cosmos3-nano: lightweight text-to-world. */
const cosmos3NanoBody = (p: VideoParams): Record<string, unknown> => ({
  prompt: p.prompt,
  seed: p.seed ?? 0,
})

/** cosmos-1.0-7b: legacy Triton `text2world` command on the cosmos host. */
const cosmosLegacyText2World = (p: VideoParams): Record<string, unknown> => ({
  inputs: [
    {
      name: 'command',
      shape: [1],
      datatype: 'BYTES',
      data: [
        `text2world --prompt="${p.prompt.replace(/"/g, '\\"')}"${p.seed != null ? ` --seed=${p.seed}` : ''}`,
      ],
    },
  ],
  outputs: [{ name: 'status', datatype: 'BYTES', shape: [1] }],
})

/** NVIDIA Stable Video Diffusion on the genai host (image-to-video). */
const svdBody = (p: VideoParams, d: VideoDefaults): Record<string, unknown> => ({
  image: p.image ? `data:image/png;base64,${p.image}` : '',
  seed: p.seed ?? 0,
  cfg_scale: num(d, 'cfg_scale', 1.8),
  motion_bucket_id: num(d, 'motion_bucket_id', 127),
})

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
 * the NVIDIA client was handed a Vertex model.
 */
const veoBody = (p: VideoParams): Record<string, unknown> => ({ prompt: p.prompt })

/**
 * family → request builder. The ONLY thing the CLI must change for a genuinely
 * new request shape; a new model reusing a known shape needs nothing here. An
 * unknown family fails with a clear, named error (see withBuilder).
 */
export const VIDEO_BODY_BUILDERS: Record<
  string,
  (p: VideoParams, d: VideoDefaults) => Record<string, unknown>
> = {
  'cosmos-predict1': cosmosPredict1Body,
  'cosmos-transfer1': cosmosTransfer1Body,
  'cosmos3-nano': cosmos3NanoBody,
  'cosmos-legacy': cosmosLegacyText2World,
  svd: svdBody,
  'fal-kling': falKlingBody,
  veo: veoBody,
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
  // and misrouting a Veo request to NVIDIA's host is worse than this heuristic.
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
 * Order: the id the caller named → the env override → the `default` model of the
 * most-preferred servable backend → the first usable model of that backend.
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
  // right default. The env override is looked up in this same list, so it can pin a
  // model but never smuggle in one the caller cannot POST to.
  const usable = orderByBackendPreference(capable, backends)
  const override = envOverride(
    isImage2Video ? 'NVIDIA_IMAGE2VIDEO_MODEL' : 'NVIDIA_VIDEO_MODEL',
  )
  const chosen =
    named ?? (override ? usable.find((m) => m.id === override) : undefined) ?? usable[0]

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
  const override = envOverride(
    backend === VERTEX_BACKEND
      ? 'VERTEX_VIDEO_MODEL'
      : isImage2Video
        ? 'NVIDIA_IMAGE2VIDEO_MODEL'
        : 'NVIDIA_VIDEO_MODEL',
  )
  const overridden = override ? usable.find((m) => m.id === override) : undefined
  return (overridden ?? usable.find((m) => m.isDefault) ?? usable[0])?.id
}

/**
 * Backends the NVIDIA/fal video client can POST to, in fallback order. Vertex is
 * deliberately absent: Veo goes through vertexVideoClient's long-running
 * `:predictLongRunning` flow, so resolving a Veo default here would mis-route.
 */
export const NVIDIA_FAL_VIDEO_BACKENDS = ['nvcf', 'nvidia-svd', 'fal']
