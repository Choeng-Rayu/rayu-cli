import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { IMAGE_GEN_TOOL_NAME } from '../tools/ImageGenTool/constants.js'
import { isRayuImageAvailable } from '../tools/ImageGenTool/ImageGenTool.js'
import { isGeminiVertexImageAvailable } from '../tools/ImageGenTool/vertexImageClient.js'

const imageEditor: Command = {
  type: 'prompt',
  name: 'image-editor',
  description: 'Edit an existing image with a text prompt (Rayu-hosted or Vertex Imagen)',
  progressMessage: 'editing image',
  contentLength: 0,
  source: 'builtin',
  // Capability gate only; paid entitlement is a soft gate (paidFeature). Signed-in
  // Rayu users can edit with an edit-capable hosted model (e.g. Wan 2.7 Image).
  isEnabled: () => isRayuImageAvailable() || isGeminiVertexImageAvailable(),
  paidFeature: 'image_generation',
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
