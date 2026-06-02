import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { IMAGE_GEN_TOOL_NAME } from '../tools/ImageGenTool/constants.js'
import { getNvidiaApiKey } from '../tools/ImageGenTool/nvidiaImageClient.js'

const imageEditor: Command = {
  type: 'prompt',
  name: 'image-editor',
  description: 'Edit an existing image with a text prompt (NVIDIA)',
  progressMessage: 'editing image',
  contentLength: 0,
  source: 'builtin',
  isEnabled: () => getNvidiaApiKey() != null,
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const text = args.trim()
    return [
      {
        type: 'text',
        text: text
          ? `Use the ${IMAGE_GEN_TOOL_NAME} tool to edit an image. The user said: ${text}\n\nAsk for the image path if not provided, then call ${IMAGE_GEN_TOOL_NAME} with input_image set to that path and prompt set to the edit description.`
          : `The user wants to edit an image. Ask them which image file to edit and what changes to make, then use the ${IMAGE_GEN_TOOL_NAME} tool with input_image and prompt.`,
      },
    ]
  },
}

export default imageEditor
