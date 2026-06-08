import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/messages.mjs'
import { mkdir, readFile, writeFile } from 'fs/promises'
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
  DEFAULT_VERTEX_VIDEO_MODEL,
  isVertexVideoModel,
  resolveVideoModel,
  VIDEO_MODELS,
} from './models.js'
import { generateVideo, isVideoEnabled } from './nvidiaVideoClient.js'
import {
  generateVertexVideo,
  isGeminiVertexVideoAvailable,
} from './vertexVideoClient.js'
import { DESCRIPTION, getVideoGenPrompt, VIDEO_GEN_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

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
      .enum(Object.keys(VIDEO_MODELS) as [string, ...string[]])
      .optional()
      .describe('Video model id; defaults to the Cosmos text2world model'),
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
      .describe('Path to an existing image to animate (routes to an image-to-video model)'),
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
    return isVideoEnabled() || isGeminiVertexVideoAvailable()
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
    return getVideoGenPrompt()
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
    const { ok, path } = resolveOutputPath(input.output_path)
    if (!ok) {
      throw new Error('output_path must be a file inside the working directory.')
    }

    const isImage2Video = !!input.input_image
    let image: string | undefined
    if (input.input_image) {
      const imgPath = expandPath(input.input_image)
      try {
        image = (await readFile(imgPath)).toString('base64')
      } catch {
        throw new Error(`input_image not found or unreadable: ${input.input_image}`)
      }
    }

    // Resolve the model: explicit input wins, else the configured default from
    // /model_video_generation, else the backend default (NVIDIA/fal/Vertex).
    const selectedModel = input.model ?? getVideoModelSelection()
    const model = resolveVideoModel(selectedModel, isImage2Video)

    // Route to Vertex Veo when a veo model is selected, or when Vertex is the
    // only configured video backend. Otherwise use the NVIDIA/fal client.
    const useVertex =
      isVertexVideoModel(selectedModel) ||
      (isGeminiVertexVideoAvailable() && !isVideoEnabled())

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
    }

    let buffer: Buffer
    let usedModelId: string
    if (useVertex) {
      const r = await generateVertexVideo({
        modelId: selectedModel,
        params: vparams,
        signal: context.abortController.signal,
      })
      buffer = r.buffer
      usedModelId =
        selectedModel && isVertexVideoModel(selectedModel)
          ? selectedModel
          : DEFAULT_VERTEX_VIDEO_MODEL
    } else {
      const r = await generateVideo({
        modelId: selectedModel,
        isImage2Video,
        params: vparams,
        signal: context.abortController.signal,
      })
      buffer = r.buffer
      usedModelId = model.id
    }

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buffer)

    // Best-effort first-frame preview so the model can see a still.
    const preview = await extractPreviewFrame(path)

    return {
      data: {
        path,
        model: usedModelId,
        frames: input.num_frames ?? 57,
        fps: input.fps ?? 24,
        mediaType: 'video/mp4',
        previewBase64: preview?.base64,
        previewMediaType: preview?.mediaType,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: Base64ImageSource }
    > = [
      {
        type: 'text',
        text: `Video saved to ${output.path} (${output.frames} frames @ ${output.fps}fps, model ${output.model})${
          output.previewBase64 ? ' — preview frame below' : ''
        }`,
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
