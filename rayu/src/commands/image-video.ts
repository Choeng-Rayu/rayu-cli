import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { VIDEO_GEN_TOOL_NAME } from '../tools/VideoGenTool/constants.js'
import { getNvidiaApiKey } from '../tools/VideoGenTool/nvidiaVideoClient.js'

const generateVideo: Command = {
  type: 'prompt',
  name: 'image-video',
  description: 'Generate a video from a text prompt (NVIDIA)',
  progressMessage: 'generating video',
  contentLength: 0,
  source: 'builtin',
  isEnabled: () => getNvidiaApiKey() != null,
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
