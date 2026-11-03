import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/messages.mjs'
import { mkdir, readFile } from 'fs/promises'
import { writeFileAtomically } from '../../utils/fsOperations.js'
import { dirname, isAbsolute, relative } from 'path'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { getImageModelSelection } from '../../utils/rayuConfig.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import {
  ensureMediaModels,
  isEditCapable,
  MEDIA_CATALOG_UNAVAILABLE_MESSAGE,
  type MediaModelEntry,
} from '../../services/rayuAuth/mediaModels.js'
import {
  hasRayuSession,
  isUseRayuOAuthEnabled,
} from '../../services/rayuAuth/rayuSession.js'
import {
  isVertexImageModel,
  retainKnownImageModel,
  withBuilder,
} from './models.js'
import { generateRayuImage } from './rayuImageClient.js'
import {
  generateVertexImage,
  isGeminiVertexImageAvailable,
} from './vertexImageClient.js'
import { DESCRIPTION, getImageGenPrompt, IMAGE_GEN_TOOL_NAME } from './prompt.js'
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
import { IMAGE_GEN_FEATURE, IMAGE_GEN_LABEL } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .min(1)
      .describe('Text description of the image to generate, or the edit to make'),
    output_path: z
      .string()
      .optional()
      .describe(
        'Where to save the PNG (inside the working directory). Default: ./generated-image-<timestamp>.png',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Image model id from the Rayu media catalog (see /model_image_generation). ' +
          'Defaults to the catalog default for the operation (generate vs edit).',
      ),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    aspect_ratio: z
      .string()
      .optional()
      .describe('e.g. "1:1", "16:9" (Stable Diffusion models)'),
    steps: z.number().int().optional(),
    cfg_scale: z.number().optional(),
    seed: z.number().int().optional(),
    negative_prompt: z.string().optional(),
    input_image: z
      .string()
      .optional()
      .describe(
        'Path to an existing image to edit (routes to an editing model). ' +
          'An https:// URL is accepted by edit-capable hosted models verbatim ' +
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
    width: z.number(),
    height: z.number(),
    mediaType: z.string(),
    base64: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/** Default output path: a timestamped image in the working directory. */
export function defaultOutputPath(ext = 'png'): string {
  return `./generated-image-${Date.now()}.${ext}`
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

/** Parse width/height from a PNG (IHDR) or JPEG (SOF) header — dependency-free. */
export function imageDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) {
        o++
        continue
      }
      const m = buf[o + 1]
      // SOF markers carry the frame size (skip non-SOF C4/C8/CC and others).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) }
      }
      o += 2 + buf.readUInt16BE(o + 2)
    }
  }
  return null
}

/** File extension for an image media type (image/jpeg -> jpg). */
function extForMedia(mediaType: string): string {
  const ext = mediaType.split('/')[1] || 'png'
  return ext === 'jpeg' ? 'jpg' : ext
}

/**
 * True when Rayu-HOSTED image models are usable: OAuth mode on and a Rayu
 * session stored. Together they mean the gateway will accept the request with
 * the user's JWT and hold the upstream provider key — no BYO key required.
 *
 * Synchronous and memoized briefly: isEnabled() runs while the tool registry is
 * assembled and whenever a picker renders, which must not hit the disk each
 * time. The TTL is short so /login and /logout take effect promptly.
 */
const RAYU_AVAILABILITY_TTL_MS = 5_000
let rayuAvailability: { value: boolean; at: number } | null = null

export function isRayuImageAvailable(): boolean {
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
export function _resetRayuImageAvailabilityForTesting(): void {
  rayuAvailability = null
}

/**
 * The hosted model a request falls back to when nothing was named.
 *
 * Capability-aware: a generate request may only land on a `generate` entry and an
 * edit (`input_image`) request only on an `edit` entry — anything else would
 * produce a request the gateway rejects. Within the eligible set the catalog's
 * `default` flag wins; otherwise server (sort) order decides, which is how the
 * picker is already presented and how an admin chooses the default.
 */
export function selectHostedImageModel(
  models: MediaModelEntry[],
  isEdit = false,
): MediaModelEntry | undefined {
  const capability = isEdit ? 'edit' : 'generate'
  const hosted = models.filter(
    (m) => m.backend === 'rayu' && m.capabilities.includes(capability),
  )
  return hosted.find((m) => m.isDefault) ?? hosted[0]
}

/** The hosted GENERATE default. See {@link selectHostedImageModel}. */
export function selectHostedGenerateModel(
  models: MediaModelEntry[],
): MediaModelEntry | undefined {
  return selectHostedImageModel(models, false)
}

/**
 * True when this CLI can serve an image model of `backend` right now. Hosted and
 * Vertex are the only image backends; anything else (a fal row, a backend newer
 * than this build) has no image client here.
 */
function isImageBackendUsable(backend: string): boolean {
  if (backend === 'rayu') return isRayuImageAvailable()
  if (backend === 'vertex') return isGeminiVertexImageAvailable()
  return false
}

/** The refusal when no image backend can take the request. */
function noImageBackendMessage(entry: MediaModelEntry | undefined): string {
  if (entry) {
    return (
      `Image model "${entry.id}" is served by "${entry.backend}", which this version ` +
      'of Rayu cannot call for images. Pick another model with /model_image_generation.'
    )
  }
  if (isRayuImageAvailable()) return MEDIA_CATALOG_UNAVAILABLE_MESSAGE
  return (
    'Image generation needs a Rayu sign-in (/login) for hosted models, or Vertex AI ' +
    '(/connect → Gemini / Vertex AI) for Imagen.'
  )
}

export const ImageGenTool = buildTool({
  name: IMAGE_GEN_TOOL_NAME,
  searchHint: 'generate or edit images from a text prompt',
  // Image base64 must never be persisted-to-disk-and-replaced-with-a-path:
  // that would strip the inline image block we return to the model.
  maxResultSizeChars: Infinity,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Visibility is capability-only: show the tool whenever an image backend is
    // usable. That is Vertex Imagen (the user's Google credentials) OR a
    // signed-in Rayu account, which needs no key at all. Plan entitlement is
    // still enforced SOFTLY (see prompt()/call()), so a Free signed-in user SEES
    // the tool and gets an upgrade prompt instead of it silently vanishing.
    return isGeminiVertexImageAvailable() || isRayuImageAvailable()
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  toAutoClassifierInput(input) {
    return `GenerateImage: ${input.prompt}`
  },
  async description() {
    if (isPaidFeatureLocked(IMAGE_GEN_FEATURE)) {
      return DESCRIPTION + paidFeatureDescriptionSuffix()
    }
    if (featureLimitReached(IMAGE_GEN_FEATURE)) {
      return DESCRIPTION + featureLimitDescriptionSuffix(IMAGE_GEN_FEATURE)
    }
    return DESCRIPTION
  },
  userFacingName() {
    return 'Generate Image'
  },
  getActivityDescription(input) {
    return input?.prompt ? `Generating image: ${input.prompt}` : 'Generating image'
  },
  async prompt() {
    const base = getImageGenPrompt()
    if (isPaidFeatureLocked(IMAGE_GEN_FEATURE)) {
      return base + paidFeatureUpgradeNote(IMAGE_GEN_LABEL)
    }
    if (featureLimitReached(IMAGE_GEN_FEATURE)) {
      return base + featureLimitReachedNote(IMAGE_GEN_FEATURE, IMAGE_GEN_LABEL)
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
    // input schema. Validate against the live catalog instead, and name the
    // available ids — the model asked for something that does not exist.
    if (input.model) {
      const catalog = await ensureMediaModels()
      if (!retainKnownImageModel(catalog.image, input.model)) {
        return {
          result: false,
          message:
            `Unknown image model "${input.model}". Available: ` +
            `${catalog.image.map((m) => m.id).join(', ') || '(none configured)'}`,
          errorCode: 2,
        }
      }
    }
    return { result: true }
  },
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: `${IMAGE_GEN_TOOL_NAME} requires permission.`,
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: IMAGE_GEN_TOOL_NAME }],
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
    if (isPaidFeatureLocked(IMAGE_GEN_FEATURE)) {
      throw new Error(paidFeatureBlockedMessage(IMAGE_GEN_LABEL))
    }
    // Enabled, but the admin-configured monthly numeric limit is reached.
    if (featureLimitReached(IMAGE_GEN_FEATURE)) {
      throw new Error(featureLimitReachedMessage(IMAGE_GEN_FEATURE, IMAGE_GEN_LABEL))
    }
    // Fail fast if the caller's explicit path escapes the working directory.
    if (input.output_path && !resolveOutputPath(input.output_path).ok) {
      throw new Error('output_path must be a file inside the working directory.')
    }

    const isEdit = !!input.input_image
    // The input image is resolved once the backend is known (below): Vertex
    // gets base64 bytes read here, the hosted gateway gets the caller's raw
    // value — an https URL passes through, a local path is read and encoded by
    // the gateway body builder.
    let image: string | undefined
    let hostedImage: string | undefined
    // The catalog is fetched lazily HERE (first tool use), not at import time, so
    // CLI startup never waits on the gateway. Cached + TTL'd afterwards.
    const catalog = await ensureMediaModels()

    // Resolve the model: explicit input wins, else the configured default from
    // /model_image_generation, else — for a signed-in user — the hosted catalog
    // default, else Vertex Imagen when it is configured.
    //
    // The remembered preference is dropped when it is no longer in the catalog (an
    // admin removed it, a plan withdrew it, or we are offline on built-ins), so a
    // choice made weeks ago cannot fail every generation. An EXPLICIT input.model
    // was already rejected loudly by validateInput if unknown.
    const explicitModel = !!input.model
    const selectedModel = retainKnownImageModel(
      catalog.image,
      input.model ?? getImageModelSelection(),
    )

    let selectedEntry = selectedModel
      ? catalog.image.find((m) => m.id === selectedModel)
      : undefined

    // Rayu-hosted is the DEFAULT for a signed-in user. An explicit input.model was
    // validated above and is never swapped here.
    if (!explicitModel && isRayuImageAvailable()) {
      if (!selectedModel) {
        // Nothing named and nothing remembered: use the hosted catalog default for
        // this operation, routed through the gateway and billed to Rayu credits —
        // even when Vertex is also configured. A Vertex model is used when the user
        // picks one (tool argument or /model_image_generation), or when the catalog
        // has no hosted model that can do this operation.
        const hosted = selectHostedImageModel(catalog.image, isEdit)
        if (hosted) {
          selectedEntry = hosted
        } else if (!isGeminiVertexImageAvailable()) {
          // No hosted model for the operation and no Vertex either. For an edit,
          // select the hosted GENERATE model so the refusal below names it;
          // otherwise the catalog itself is the problem (the gateway fetch failed,
          // or it lists no hosted model).
          const generateOnly = isEdit
            ? selectHostedGenerateModel(catalog.image)
            : undefined
          if (!generateOnly) throw new Error(MEDIA_CATALOG_UNAVAILABLE_MESSAGE)
          selectedEntry = generateOnly
        }
      } else if (!isImageBackendUsable(selectedEntry?.backend ?? 'vertex')) {
        // A remembered model this machine cannot serve — a Vertex entry after the
        // GCP project went away, or a backend this CLI has no image client for —
        // falls back to the hosted model instead of an unactionable error. (An id
        // with no catalog entry survived retainKnownImageModel only because it is
        // an imagen-* id, hence the 'vertex' default.) When its backend IS usable,
        // the user's choice stands.
        const hosted =
          selectHostedImageModel(catalog.image, isEdit) ??
          selectHostedGenerateModel(catalog.image)
        if (!hosted) throw new Error(MEDIA_CATALOG_UNAVAILABLE_MESSAGE)
        selectedEntry = hosted
      }
    }

    // Route to Vertex Imagen when the SELECTED model is Vertex-served, or — when
    // nothing is selected — when Vertex is configured, since it is the only
    // bring-your-own image backend. Anything else has no client here and is
    // refused with a message that says why.
    const useVertex = selectedEntry
      ? selectedEntry.backend === 'vertex'
      : isVertexImageModel(selectedModel, catalog.image) ||
        isGeminiVertexImageAvailable()
    const route: 'rayu' | 'vertex' | null =
      selectedEntry?.backend === 'rayu' ? 'rayu' : useVertex ? 'vertex' : null
    if (!route) throw new Error(noImageBackendMessage(selectedEntry))

    // Resolve the input image now that the backend is known. Hosted models
    // with the edit capability accept the caller's raw value (URL or local
    // path — the body builder encodes it); a generate-only hosted entry is
    // refused with an actionable message instead of sending a body the gateway
    // will 400. A REMEMBERED generate-only hosted model is NOT silently
    // swapped for an edit-capable one — unlike the video tool, most image
    // requests are text-to-image, so auto-selection keeps preferring a
    // generate model and the caller chooses explicitly. Vertex keeps the
    // base64 read.
    if (input.input_image) {
      if (route === 'rayu' && selectedEntry) {
        if (!isEditCapable(selectedEntry)) {
          throw new Error(
            `Hosted image model "${selectedEntry.id}" is generate-only — ` +
              'pick a model that supports edit, or remove input_image.',
          )
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

    const genParams = {
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      aspect_ratio: input.aspect_ratio,
      steps: input.steps,
      cfg_scale: input.cfg_scale,
      seed: input.seed,
      negative_prompt: input.negative_prompt,
      image,
      ...(hostedImage !== undefined ? { input_image: hostedImage } : {}),
    }

    // Every client reports the model it actually used, resolved from the same
    // catalog — the tool no longer keeps its own copy of the defaults.
    let generated: { buffer: Buffer; mediaType: string; modelId: string }
    if (route === 'rayu' && selectedEntry) {
      // Edit-capability was verified when the input image was resolved above;
      // generate-only hosted models never reach here with an `image`.
      generated = await generateRayuImage({
        model: withBuilder(selectedEntry),
        params: genParams,
        signal: context.abortController.signal,
      })
    } else {
      generated = await generateVertexImage({
        modelId: selectedModel,
        isEdit,
        params: genParams,
        signal: context.abortController.signal,
      })
    }
    const { buffer, mediaType, modelId: usedModelId } = generated

    // Resolve the output path; the default filename uses the real extension.
    const { path } = resolveOutputPath(
      input.output_path ?? defaultOutputPath(extForMedia(mediaType)),
    )

    // Save the full-resolution image to disk (inside the working directory),
    // atomically — a half-written PNG/JPEG would fail the dimension sniff and
    // the inline block below, yet still leave a corrupt file as "the result".
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomically(path, buffer)

    // Downsample a copy for the inline (model-facing) block to respect the
    // token budget; fall back to the original image when the processor
    // (sharp/native) isn't available in this build.
    let inlineB64 = buffer.toString('base64')
    let inlineMedia: string = mediaType
    try {
      const r = await maybeResizeAndDownsampleImageBuffer(
        buffer,
        buffer.length,
        extForMedia(mediaType),
      )
      inlineB64 = r.buffer.toString('base64')
      inlineMedia = `image/${r.mediaType}`
    } catch {
      // Image processor unavailable — keep the original image.
    }

    const dims = imageDimensions(buffer)

    // Count this successful generation toward the monthly soft cap immediately
    // (the durable usage_events row is written by the per-tool usage ping).
    //
    // UX ONLY — for Rayu-hosted models the GATEWAY is the authoritative billed
    // meter: it reserves and settles per image (images × creditsPerImage) and
    // writes the ledger. This counter can drift (offline, other devices, the
    // gateway counting fewer images than requested) and must never be treated
    // as the billing record.
    bumpFeatureUsage(IMAGE_GEN_FEATURE)

    return {
      data: {
        path,
        model: usedModelId,
        width: dims?.width ?? input.width ?? 0,
        height: dims?.height ?? input.height ?? 0,
        mediaType: inlineMedia,
        base64: inlineB64,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'text',
          text: `Image saved to ${output.path} (${output.width}x${output.height}, model ${output.model})`,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            data: output.base64,
            media_type: output.mediaType as Base64ImageSource['media_type'],
          },
        },
      ],
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
