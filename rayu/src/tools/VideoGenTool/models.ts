// Per-family request builders for video generation, plus model resolution
// against the SERVER-OWNED catalog.
//
// There is deliberately no model registry in this file. Which video models exist,
// their backend, how long a generation takes, and their per-model request
// defaults all come from the Rayu provider at runtime
// (services/rayuAuth/mediaModels.ts → gateway GET /v1/models?media=video), so
// adding a model needs a backend catalog row and no CLI release.
//
// What DOES stay here is the request SHAPE for the Rayu-hosted family — the
// gateway's DashScope body — because that is API mechanics, not catalog data.
// Video generation is Rayu-hosted ONLY: the fal.ai and Vertex Veo clients were
// removed, so `fal-kling` / `veo` model rows are skipped by mediaModels.ts
// (RETIRED_MEDIA_BACKENDS) instead of being offered.
//
// SECURITY: only model params + prompt are sent; no credential is read here.
import type {
  MediaModelEntry,
  VideoCapability,
} from '../../services/rayuAuth/mediaModels.js'
import { resolveReferenceImage } from '../../utils/hostedReferenceImage.js'

export type { VideoCapability }

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

// ── Rayu-hosted (DashScope video) ────────────────────────────────────────────

/** Ratios the gateway/model accepts, in catalogue order. */
const DASHSCOPE_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const
type DashscopeRatio = (typeof DASHSCOPE_VIDEO_RATIOS)[number]
/** `adaptive` has no numeric ratio to compare against, but the wire accepts it. */
type DashscopeVideoRatio = DashscopeRatio | 'adaptive'

/**
 * The hosted clip-length window used when the catalog entry does NOT publish
 * its own. wan3.0-video renders 2–30 s and refuses 1 s, so the floor is 2
 * rather than the 1 the frame-count maths could produce. A model with a
 * different cap publishes `max_duration_seconds` (see MediaModelEntry) and the
 * requested duration is clamped to THAT instead — otherwise a 5 s model would
 * receive a 30 s request the gateway rejects.
 */
const DASHSCOPE_VIDEO_MIN_SECONDS = 2
const DASHSCOPE_VIDEO_MAX_SECONDS = 30

/** Clip-length window a catalog entry declares (both bounds optional). */
export type VideoDurationLimits = {
  minDurationSeconds?: number
  maxDurationSeconds?: number
}

function ratioValue(r: DashscopeRatio): number {
  const [a, b] = r.split(':').map(Number) as [number, number]
  return a / b
}

/**
 * Duration in seconds from the CLI's frame-count/fps pair, clamped to the
 * model's window: its published `min/max_duration_seconds` when the catalog
 * carries them, else 2–30 s. Either frame input missing means "let the
 * gateway/model default apply" — not zero.
 */
export function dashscopeVideoDuration(
  p: VideoParams,
  limits?: VideoDurationLimits,
): number | undefined {
  if (p.num_frames == null || p.fps == null || p.fps <= 0) return undefined
  const hi = Math.max(
    1,
    limits?.maxDurationSeconds ?? DASHSCOPE_VIDEO_MAX_SECONDS,
  )
  // A declared floor can never exceed the declared ceiling (a 1 s-capped model
  // must not be forced up to the 2 s family floor).
  const lo = Math.min(
    Math.max(1, limits?.minDurationSeconds ?? DASHSCOPE_VIDEO_MIN_SECONDS),
    hi,
  )
  return Math.min(hi, Math.max(lo, Math.round(p.num_frames / p.fps)))
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
  limits?: VideoDurationLimits,
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
  const duration = dashscopeVideoDuration(p, limits)
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
  (
    p: VideoParams,
    d: VideoDefaults,
    limits?: VideoDurationLimits,
  ) => Record<string, unknown>
> = {
  // Rayu-hosted models (backend 'rayu') proxy through the gateway, which holds
  // the upstream provider key and speaks DashScope video to it.
  dashscope_video: dashscopeVideoBody,
}

/**
 * Keep a model id only if the catalog still carries it — see
 * retainKnownImageModel for the full rationale. A selection remembered from
 * `/model_video_generation` that has left the catalog is dropped (the caller then
 * gets the current default) rather than failing every later generation.
 *
 * There is no hand-written-id escape hatch any more: video has no BYO backend
 * whose client would honour an id the catalog does not list, so an unknown id is
 * always stale.
 */
export function retainKnownVideoModel(
  models: MediaModelEntry[],
  id: string | undefined,
): string | undefined {
  if (!id) return undefined
  return models.some((m) => m.id === id) ? id : undefined
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
  // The entry's own published clip window travels with the builder, so a model
  // capped below the family default is honoured instead of 400ing at the gateway.
  const limits: VideoDurationLimits = {
    ...(entry.minDurationSeconds !== undefined
      ? { minDurationSeconds: entry.minDurationSeconds }
      : {}),
    ...(entry.maxDurationSeconds !== undefined
      ? { maxDurationSeconds: entry.maxDurationSeconds }
      : {}),
  }
  return {
    ...entry,
    buildBody: (p: VideoParams) => builder(p, defaults, limits),
  }
}

