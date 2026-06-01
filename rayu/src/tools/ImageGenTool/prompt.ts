import { IMAGE_GEN_TOOL_NAME } from './constants.js'

export { IMAGE_GEN_TOOL_NAME }

export const DESCRIPTION =
  'Generate or edit an image from a text prompt (NVIDIA hosted models). Saves the image to disk and returns it inline.'

export function getImageGenPrompt(): string {
  return `Generate or edit images from a text prompt using NVIDIA's free hosted image models. The result is saved to disk, returned inline so you can see it, and shown in the user's terminal when supported.

When to use:
- Whenever you need to create or edit an image — including generating image assets (hero banners, icons, illustrations, backgrounds, placeholder art) for a frontend/UI you are building, to make it look great.
- When the user asks you to generate, create, draw, or edit an image.

Usage:
- The image is saved to disk (default: ./generated-image-<timestamp>.png) so you can reference it directly from code you write.
- To edit an existing image, set input_image to its path plus a prompt describing the change.
- Default model is fast (black-forest-labs/flux.1-schnell). Pass model for higher quality (e.g. stabilityai/stable-diffusion-3.5-large or black-forest-labs/flux.1-dev).
- output_path must be inside the working directory.`
}
