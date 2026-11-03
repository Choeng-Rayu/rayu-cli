import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { VIDEO_GEN_TOOL_NAME } from '../tools/VideoGenTool/constants.js'
import { isRayuVideoAvailable } from '../tools/VideoGenTool/VideoGenTool.js'
import { isFalVideoAvailable } from '../tools/VideoGenTool/falVideoClient.js'
import { isGeminiVertexVideoAvailable } from '../tools/VideoGenTool/vertexVideoClient.js'

const generateVideo: Command = {
  type: 'prompt',
  name: 'image-video',
  description:
    'Generate a video from a text prompt (Rayu-hosted, fal.ai, or Vertex Veo)',
  progressMessage: 'generating video',
  contentLength: 0,
  source: 'builtin',
  // Capability gate only; paid entitlement is a soft gate (paidFeature). A
  // signed-in Rayu user can use hosted video models with no BYO key.
  isEnabled: () =>
    isRayuVideoAvailable() || isFalVideoAvailable() || isGeminiVertexVideoAvailable(),
  paidFeature: 'video_generation',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const prompt = args.trim()
    return [
      {
        type: 'text',
        text: prompt
          ? `Use the ${VIDEO_GEN_TOOL_NAME} tool to generate a video of: ${prompt}`
          : `Ask me what video to create, then use the ${VIDEO_GEN_TOOL_NAME} tool to generate it.`,
      },
    ]
  },
}

export default generateVideo
