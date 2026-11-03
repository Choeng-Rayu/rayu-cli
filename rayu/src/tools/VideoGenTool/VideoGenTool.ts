import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/messages.mjs'
import { mkdir, readFile } from 'fs/promises'
import { writeFileAtomically } from '../../utils/fsOperations.js'
import { dirname, isAbsolute, relative } from 'path'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { getVideoModelSelection } from '../../utils/rayuConfig.js'
import { extractPreviewFrame } from './framePreview.js'
import {
  ensureMediaModels,
  isReferenceCapable,
  MEDIA_CATALOG_UNAVAILABLE_MESSAGE,
  type MediaModelEntry,
  type VideoCapability,
} from '../../services/rayuAuth/mediaModels.js'
import {
  withBuilder,
  isVertexVideoModel,
  retainKnownVideoModel,
} from './models.js'
import {
  generateFalVideo,
  getFalApiKey,
  isFalVideoAvailable,
} from './falVideoClient.js'
import { generateRayuVideo } from './rayuVideoClient.js'
import {
  generateVertexVideo,
  isGeminiVertexVideoAvailable,
} from './vertexVideoClient.js'
import {
  hasRayuSession,
  isUseRayuOAuthEnabled,
} from '../../services/rayuAuth/rayuSession.js'
import { DESCRIPTION, getVideoGenPrompt, VIDEO_GEN_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
import {
  featureLimitDescriptionSuffix,
  featureLimitReached,
  featureLimitReachedMessage,
  featureLimitReachedNote,
  isPaidFeatureLocked,
  paidFeatureBlockedMessage,
  paidFeatureDescriptionSuffix,
  paidFeatureUpgradeNote,
} from '../../services/rayuAuth/paidFeatureGate.js'
import { bumpFeatureUsage } from '../../services/rayuAuth/rayuFeatureUsage.js'
import { VIDEO_GEN_FEATURE, VIDEO_GEN_LABEL } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .min(1)
      .describe('Text description of the video to generate, or the motion to apply'),
    output_path: z
      .string()
      .optional()
      .describe(
        'Where to save the MP4 (inside the working directory). Default: ./generated-video-<timestamp>.mp4',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Video model id from the Rayu media catalog (see /model_video_generation). ' +
          'Defaults to the catalog default for the operation (text2video vs image2video).',
      ),
    num_frames: z.number().int().optional(),
    fps: z.number().int().optional(),
    height: z.number().int().optional(),
    width: z.number().int().optional(),
    aspect_ratio: z.string().optional().describe('e.g. "16:9"'),
    seed: z.number().int().optional(),
    negative_prompt: z.string().optional(),
    input_image: z
      .string()
      .optional()
      .describe(
        'Path to an existing image to animate (routes to an image-to-video model). ' +
          'An https:// URL is accepted by hosted image2video models verbatim ' +
          '(plain http:// is refused); a local path is encoded for the gateway.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    path: z.string(),
    model: z.string(),
    frames: z.number(),
    fps: z.number(),
    mediaType: z.string(),
    /**
     * ACTUAL seconds of the generated video, when the backend reported one
     * (the hosted gateway bills real duration, which can differ from the
     * request). Absent for BYO backends, which return the requested shape.
     */
    durationSeconds: z.number().optional(),
    /** Actual resolution tier / ratio the gateway served, when returned. */
    resolution: z.string().optional(),
    ratio: z.string().optional(),
    previewBase64: z.string().optional(),
    previewMediaType: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/** Default output path: a timestamped MP4 in the working directory. */
export function defaultOutputPath(): string {
  return `./generated-video-${Date.now()}.mp4`
}

/** Resolve + verify the output path stays inside the working directory. */
export function resolveOutputPath(output_path: string | undefined): {
  ok: boolean
  path: string
} {
  const path = expandPath(output_path ?? defaultOutputPath())
  const rel = relative(getCwd(), path)
  const ok = rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  return { ok, path }
}

/**
 * True when Rayu-HOSTED video models are usable: OAuth mode on and a Rayu
 * session stored. Together they mean the gateway will accept the request with
 * the user's JWT and hold the upstream provider key — no BYO key required.
 *
 * Synchronous and memoized briefly for the same reason as the image tool:
 * isEnabled() runs while the tool registry is assembled and whenever a picker
 * renders, which must not hit the disk each time. The TTL is short so /login and
 * /logout take effect promptly.
 */
const RAYU_AVAILABILITY_TTL_MS = 5_000
let rayuAvailability: { value: boolean; at: number } | null = null

export function isRayuVideoAvailable(): boolean {
  const now = Date.now()
  if (
    rayuAvailability &&
    now - rayuAvailability.at < RAYU_AVAILABILITY_TTL_MS
  ) {
    return rayuAvailability.value
  }
  const value = isUseRayuOAuthEnabled() && hasRayuSession()
  rayuAvailability = { value, at: now }
  return value
}

/** Test hook: forget the memoized availability verdict. */
export function _resetRayuVideoAvailabilityForTesting(): void {
  rayuAvailability = null
}

/**
 * True when a video backend can actually serve a request right now. The
 * catalog's backends are the source of truth.
 */
function isVideoBackendConfigured(backend: string): boolean {
  switch (backend) {
    case 'fal':
      return getFalApiKey() != null
    case 'vertex':
      return isGeminiVertexVideoAvailable()
    // Hosted is "configured" whenever the user can reach it; a signed-out user
    // never reaches the hosted fallback anyway.
    case 'rayu':
      return isRayuVideoAvailable()
    default:
      return false
  }
}

/** The refusal when no video backend can take the request. */
function noVideoBackendMessage(): string {
  if (isRayuVideoAvailable()) return MEDIA_CATALOG_UNAVAILABLE_MESSAGE
  return (
    'Video generation needs a Rayu sign-in (/login) for hosted models, a fal.ai key ' +
    '(FAL_KEY or /connect), or Vertex AI (/connect → Gemini / Vertex AI) for Veo.'
  )
}

/**
 * Which client serves the request, or null when none can: the selected entry's
 * own backend, else — with nothing selected — fal.ai when its key is configured
 * (Vertex was already decided by `useVertex`).
 */
function videoRoute(
  entry: MediaModelEntry | undefined,
  useVertex: boolean,
): 'rayu' | 'vertex' | 'fal' | null {
  if (entry?.backend === 'rayu') return 'rayu'
  if (useVertex) return 'vertex'
  if (entry?.backend === 'fal') return 'fal'
  return !entry && isFalVideoAvailable() ? 'fal' : null
}

/**
 * The hosted model a request falls back to when nothing usable was named.
 * Capability-aware: a text-to-video request may only land on a `text2video`
 * entry, an `input_image` request only on an `image2video` one — picking the
 * wrong capability would send a request the gateway refuses
 * (`400 model_does_not_accept_image`). Within the eligible set the catalog's
 * `default` flag wins; otherwise server (sort) order decides.
 */
export function selectHostedVideoModel(
  models: MediaModelEntry[],
  isImage2Video = false,
): MediaModelEntry | undefined {
  const capability: VideoCapability = isImage2Video ? 'image2video' : 'text2video'
  const hosted = models.filter(
    (m) => m.backend === 'rayu' && m.capabilities.includes(capability),
  )
  return hosted.find((m) => m.isDefault) ?? hosted[0]
}

export const VideoGenTool = buildTool({
  name: VIDEO_GEN_TOOL_NAME,
  searchHint: 'generate a video from a text prompt',
  maxResultSizeChars: Infinity,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Visibility is capability-only: a BYO backend (fal.ai / Vertex) OR a
    // signed-in Rayu account, which needs no key at all. Plan entitlement is
    // still enforced SOFTLY in prompt()/call() so a Free user SEES the tool and
    // gets an upgrade prompt instead of it silently vanishing.
    return (
      isFalVideoAvailable() ||
      isGeminiVertexVideoAvailable() ||
      isRayuVideoAvailable()
    )
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  toAutoClassifierInput(input) {
    return `GenerateVideo: ${input.prompt}`
  },
  async description() {
    if (isPaidFeatureLocked(VIDEO_GEN_FEATURE)) {
      return DESCRIPTION + paidFeatureDescriptionSuffix()
    }
    if (featureLimitReached(VIDEO_GEN_FEATURE)) {
      return DESCRIPTION + featureLimitDescriptionSuffix(VIDEO_GEN_FEATURE)
    }
    return DESCRIPTION
  },
  userFacingName() {
    return 'Generate Video'
  },
  getActivityDescription(input) {
    return input?.prompt
      ? `Generating video (please wait ~1-2 min): ${input.prompt}`
      : 'Generating video — please wait, this takes ~1-2 minutes'
  },
  async prompt() {
    const base = getVideoGenPrompt()
    if (isPaidFeatureLocked(VIDEO_GEN_FEATURE)) {
      return base + paidFeatureUpgradeNote(VIDEO_GEN_LABEL)
    }
    if (featureLimitReached(VIDEO_GEN_FEATURE)) {
      return base + featureLimitReachedNote(VIDEO_GEN_FEATURE, VIDEO_GEN_LABEL)
    }
    return base
  },
  async validateInput(input) {
    const { ok } = resolveOutputPath(input.output_path)
    if (!ok) {
      return {
        result: false,
        message: 'output_path must be a file inside the working directory.',
        errorCode: 1,
      }
    }
    // The model list is server-owned, so it cannot be a compile-time enum in the
    // input schema. Validate against the live catalog and name what's available.
    if (input.model) {
      const catalog = await ensureMediaModels()
      if (!retainKnownVideoModel(catalog.video, input.model)) {
        return {
          result: false,
          message:
            `Unknown video model "${input.model}". Available: ` +
            `${catalog.video.map((m) => m.id).join(', ') || '(none configured)'}`,
          errorCode: 2,
        }
      }
    }
    return { result: true }
  },
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: `${VIDEO_GEN_TOOL_NAME} requires permission.`,
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: VIDEO_GEN_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },
  async call(input, context: ToolUseContext) {
    // Soft paid-gate: a Free user can SEE and attempt this tool, but execution
    // is refused with an upgrade ask. Paid users (and the OAuth-off BYOK path)
    // are not locked and pass straight through.
    if (isPaidFeatureLocked(VIDEO_GEN_FEATURE)) {
      throw new Error(paidFeatureBlockedMessage(VIDEO_GEN_LABEL))
    }
    // Enabled, but the admin-configured monthly numeric limit is reached.
    if (featureLimitReached(VIDEO_GEN_FEATURE)) {
      throw new Error(featureLimitReachedMessage(VIDEO_GEN_FEATURE, VIDEO_GEN_LABEL))
    }
    const { ok, path } = resolveOutputPath(input.output_path)
    if (!ok) {
      throw new Error('output_path must be a file inside the working directory.')
    }

    const isImage2Video = !!input.input_image
    // The reference image is resolved once the backend is known (below): BYO
    // backends get base64 bytes read here, the hosted gateway gets the caller's
    // raw value — an https URL passes through, a local path is read and encoded
    // by the dashscope builder.
    let image: string | undefined
    let hostedImage: string | undefined

    // The catalog is fetched lazily HERE (first tool use), not at import time, so
    // CLI startup never waits on the gateway. Cached + TTL'd afterwards.
    const catalog = await ensureMediaModels()

    // Resolve the model: explicit input wins, else the configured default from
    // /model_video_generation, else — for a signed-in user — the hosted catalog
    // default, else the BYO catalog default for the configured backend.
    //
    // The remembered preference is dropped when it is no longer in the catalog (an
    // admin removed it, a plan withdrew it, or we are offline on built-ins), so a
    // choice made weeks ago cannot fail every generation. An EXPLICIT input.model
    // was already rejected loudly by validateInput if unknown.
    const explicitModel = !!input.model
    const selectedModel = retainKnownVideoModel(
      catalog.video,
      input.model ?? getVideoModelSelection(),
    )

    let selectedEntry = selectedModel
      ? catalog.video.find((m) => m.id === selectedModel)
      : undefined

    // Rayu-hosted is the DEFAULT for a signed-in user. An explicit input.model was
    // validated above and is never swapped here.
    if (!explicitModel && isRayuVideoAvailable()) {
      if (!selectedModel) {
        // Nothing named and nothing remembered: use the hosted catalog default for
        // this operation (image2video when a reference image is given), routed
        // through the gateway and billed to Rayu credits — even when a fal or
        // Vertex key is also configured. A BYO model is used when the user picks
        // one (tool argument or /model_video_generation), or when the catalog has
        // no hosted model that can do this operation.
        const hosted = selectHostedVideoModel(catalog.video, isImage2Video)
        if (hosted) {
          selectedEntry = hosted
        } else if (!(isFalVideoAvailable() || isGeminiVertexVideoAvailable())) {
          // No hosted model for the operation and no BYO backend either. For a
          // reference-image request, select the hosted text-to-video model so the
          // refusal below gives its precise "text-to-video only" message;
          // otherwise the catalog itself is the problem (the gateway fetch failed,
          // or it lists no hosted model). Sending this to the fal client would
          // report "API key not configured" — a misleading dead end.
          const textOnly = isImage2Video
            ? selectHostedVideoModel(catalog.video, false)
            : undefined
          if (!textOnly) throw new Error(MEDIA_CATALOG_UNAVAILABLE_MESSAGE)
          selectedEntry = textOnly
        }
      } else {
        // A remembered model whose backend has NO usable credentials (a stale fal
        // id, or the user removed their key) falls back to the hosted model
        // instead of an unactionable "API key not configured". When its backend IS
        // configured, the user's choice stands. (An id with no catalog entry
        // survived retainKnownVideoModel only because it is a veo-* id.)
        const backendConfigured = isVideoBackendConfigured(
          selectedEntry ? selectedEntry.backend : 'vertex',
        )
        if (!backendConfigured) {
          // Capability-aware, with the text-to-video entry as the fallback so a
          // catalog without an image2video model still reaches the precise
          // refusal below instead of the generic catalog error.
          const hosted =
            selectHostedVideoModel(catalog.video, isImage2Video) ??
            selectHostedVideoModel(catalog.video, false)
          if (!hosted) throw new Error(MEDIA_CATALOG_UNAVAILABLE_MESSAGE)
          selectedEntry = hosted
        }
      }
    }

    // Route to Vertex Veo when the SELECTED model is Vertex-served, or — when
    // nothing is selected — when Vertex is the only configured video backend.
    // Routing by the selected model's own backend keeps an explicitly requested
    // fal model from being silently swapped for Veo on a Vertex-only machine; the
    // fal client then reports the missing key instead.
    const useVertex = selectedEntry
      ? selectedEntry.backend === 'vertex'
      : isVertexVideoModel(selectedModel, catalog.video) ||
        (isGeminiVertexVideoAvailable() && !isFalVideoAvailable())
    const route = videoRoute(selectedEntry, useVertex)
    if (!route) throw new Error(noVideoBackendMessage())

    // Resolve the reference image now that the backend is known. Hosted models
    // with the image2video capability accept the caller's raw value (URL or
    // local path — the builder encodes it); a text-to-video-only hosted entry
    // is refused with an actionable message instead of sending a body the
    // gateway will 400. BYO backends keep the base64 read, exactly as before.
    if (input.input_image) {
      if (selectedEntry?.backend === 'rayu') {
        if (!isReferenceCapable(selectedEntry)) {
          // A REMEMBERED/default hosted text-to-video model does not freeze the
          // request: if the catalog carries a hosted image2video entry, swap to
          // it — the same deliberate fall-through resolveVideoModel applies to
          // BYO models. An EXPLICIT model is never swapped silently.
          const i2v = explicitModel
            ? undefined
            : selectHostedVideoModel(catalog.video, true)
          if (i2v) {
            selectedEntry = i2v
          } else {
            throw new Error(
              `Hosted video model "${selectedEntry.id}" is text-to-video only — ` +
                'choose a model with image2video to use a reference image.',
            )
          }
        }
        hostedImage = /^https?:\/\//i.test(input.input_image)
          ? input.input_image
          : expandPath(input.input_image)
      } else {
        const imgPath = expandPath(input.input_image)
        try {
          image = (await readFile(imgPath)).toString('base64')
        } catch {
          throw new Error(
            `input_image not found or unreadable: ${input.input_image}`,
          )
        }
      }
    }

    const vparams = {
      prompt: input.prompt,
      negative_prompt: input.negative_prompt,
      num_frames: input.num_frames,
      fps: input.fps,
      height: input.height,
      width: input.width,
      aspect_ratio: input.aspect_ratio,
      seed: input.seed,
      image,
      ...(hostedImage !== undefined ? { input_image: hostedImage } : {}),
    }

    // Every client reports the model it actually used, resolved from the same
    // catalog — the tool no longer keeps its own copy of the defaults.
    let generated: {
      buffer: Buffer
      mediaType: string
      modelId: string
      durationSeconds?: number
      resolution?: string
      ratio?: string
    }
    if (route === 'rayu' && selectedEntry) {
      generated = await generateRayuVideo({
        model: withBuilder(selectedEntry),
        params: vparams,
        signal: context.abortController.signal,
      })
    } else if (route === 'vertex') {
      generated = await generateVertexVideo({
        modelId: selectedModel,
        params: vparams,
        signal: context.abortController.signal,
      })
    } else {
      generated = await generateFalVideo({
        modelId: selectedModel,
        isImage2Video,
        params: vparams,
        signal: context.abortController.signal,
      })
    }
    const {
      buffer,
      modelId: usedModelId,
      durationSeconds: usedDuration,
      resolution: usedResolution,
      ratio: usedRatio,
    } = generated

    await mkdir(dirname(path), { recursive: true })
    // Atomic: a partial MP4 at the final path would poison the preview
    // extraction below and any later reader of `path`.
    await writeFileAtomically(path, buffer)

    // Best-effort first-frame preview so the model can see a still.
    const preview = await extractPreviewFrame(path)

    // Count this successful generation toward the monthly soft cap immediately
    // (the durable usage_events row is written by the per-tool usage ping).
    bumpFeatureUsage(VIDEO_GEN_FEATURE)

    return {
      data: {
        path,
        model: usedModelId,
        frames: input.num_frames ?? 57,
        fps: input.fps ?? 24,
        mediaType: 'video/mp4',
        durationSeconds: usedDuration,
        resolution: usedResolution,
        ratio: usedRatio,
        previewBase64: preview?.base64,
        previewMediaType: preview?.mediaType,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    // When the backend billed and reported ACTUAL seconds (hosted gateway),
    // report the real length — not the requested frames/fps, which the gateway
    // may have rounded away from.
    const detail = [output.resolution, output.ratio]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(', ')
    const headline =
      output.durationSeconds != null
        ? `Generated ${output.durationSeconds.toFixed(1)}s video` +
          (detail ? ` (${detail})` : '') +
          `, saved to ${output.path} (model ${output.model})`
        : `Video saved to ${output.path} (${output.frames} frames @ ${output.fps}fps, model ${output.model})`
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: Base64ImageSource }
    > = [
      {
        type: 'text',
        text: `${headline}${output.previewBase64 ? ' — preview frame below' : ''}`,
      },
    ]
    if (output.previewBase64) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          data: output.previewBase64,
          media_type:
            (output.previewMediaType as Base64ImageSource['media_type']) ??
            'image/png',
        },
      })
    }
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
