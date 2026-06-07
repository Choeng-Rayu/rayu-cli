import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/messages.mjs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, isAbsolute, relative } from 'path'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import {
  DEFAULT_VERTEX_EDIT_MODEL,
  DEFAULT_VERTEX_IMAGE_MODEL,
  IMAGE_MODELS,
  isVertexImageModel,
  resolveModel,
} from './models.js'
import { generateImage, getNvidiaApiKey } from './nvidiaImageClient.js'
import {
  generateVertexImage,
  isGeminiVertexImageAvailable,
} from './vertexImageClient.js'
import { DESCRIPTION, getImageGenPrompt, IMAGE_GEN_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

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
      .enum(Object.keys(IMAGE_MODELS) as [string, ...string[]])
      .optional()
      .describe('Image model id; defaults to flux.1-schnell (or the edit model when input_image is set)'),
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
      .describe('Path to an existing image to edit (routes to an editing model)'),
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
    return getNvidiaApiKey() != null || isGeminiVertexImageAvailable()
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
    return DESCRIPTION
  },
  userFacingName() {
    return 'Generate Image'
  },
  getActivityDescription(input) {
    return input?.prompt ? `Generating image: ${input.prompt}` : 'Generating image'
  },
  async prompt() {
    return getImageGenPrompt()
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
    // Fail fast if the caller's explicit path escapes the working directory.
    if (input.output_path && !resolveOutputPath(input.output_path).ok) {
      throw new Error('output_path must be a file inside the working directory.')
    }

    const isEdit = !!input.input_image
    let image: string | undefined
    if (input.input_image) {
      const imgPath = expandPath(input.input_image)
      try {
        image = (await readFile(imgPath)).toString('base64')
      } catch {
        throw new Error(`input_image not found or unreadable: ${input.input_image}`)
      }
    }
    // Route to Vertex Imagen when an imagen model is selected, or when Vertex
    // is the only configured image backend. Otherwise use the NVIDIA client.
    const useVertex =
      isVertexImageModel(input.model) ||
      (isGeminiVertexImageAvailable() && getNvidiaApiKey() == null)

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
    }

    let buffer: Buffer
    let mediaType: string
    let usedModelId: string
    if (useVertex) {
      const r = await generateVertexImage({
        modelId: input.model,
        isEdit,
        params: genParams,
        signal: context.abortController.signal,
      })
      buffer = r.buffer
      mediaType = r.mediaType
      usedModelId =
        input.model && isVertexImageModel(input.model)
          ? input.model
          : isEdit
            ? DEFAULT_VERTEX_EDIT_MODEL
            : DEFAULT_VERTEX_IMAGE_MODEL
    } else {
      const r = await generateImage({
        modelId: input.model,
        isEdit,
        params: genParams,
        signal: context.abortController.signal,
      })
      buffer = r.buffer
      mediaType = r.mediaType
      usedModelId = resolveModel(input.model, isEdit).id
    }

    // Resolve the output path; the default filename uses the real extension.
    const { path } = resolveOutputPath(
      input.output_path ?? defaultOutputPath(extForMedia(mediaType)),
    )

    // Save the full-resolution image to disk (inside the working directory).
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buffer)

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
