import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { IMAGE_GEN_TOOL_NAME } from '../tools/ImageGenTool/constants.js'
import { getNvidiaApiKey } from '../tools/ImageGenTool/nvidiaImageClient.js'

const generateImage: Command = {
  type: 'prompt',
  name: 'generate-image',
  description: 'Generate an image from a text prompt (NVIDIA)',
  progressMessage: 'generating image',
  contentLength: 0,
  source: 'builtin',
  isEnabled: () => getNvidiaApiKey() != null,
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const prompt = args.trim()
    return [
      {
        type: 'text',
        text: prompt
          ? `Use the ${IMAGE_GEN_TOOL_NAME} tool to generate an image of: ${prompt}`
          : `Ask me what image to create, then use the ${IMAGE_GEN_TOOL_NAME} tool to generate it.`,
      },
    ]
  },
}

export default generateImage
