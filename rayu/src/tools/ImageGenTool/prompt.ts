import { IMAGE_GEN_TOOL_NAME } from './constants.js'

export { IMAGE_GEN_TOOL_NAME }

export const DESCRIPTION =
  'Generate an image from a text prompt. Rayu-hosted models are the default when signed in (no API key needed); Vertex Imagen is used when one of its models is picked or the user is not signed in.'

export function getImageGenPrompt(): string {
  return `Generate images from a text prompt with server-owned image models. The result is saved to disk, returned inline so you can see it, and shown in the user's terminal when supported.

Backends:
- Rayu-hosted (the DEFAULT when signed in to Rayu): the request goes through the Rayu gateway under the user's account — no provider API key — and is billed per generated IMAGE in Rayu credits. Editing is capability-gated: a hosted model accepts input_image only when its catalog entry advertises edit (e.g. Wan 2.7 Image); generate-only hosted entries refuse it with an actionable message.
- Vertex Imagen (the user's own Google Cloud project): used when you pass model=<id> of an Imagen model, when the user picked one with /model_image_generation, when the user is not signed in, or when the catalog has no hosted model for the operation.

Available models are owned by the Rayu catalog, not hardcoded here — the user can open /model_image_generation to list and pick one, or you can pass model=<id> from that list. When nothing is named, the hosted catalog default for the operation is used (an edit-capable hosted model when input_image is given).

When to use:
- Whenever you need to create an image — including image assets (hero banners, icons, illustrations, backgrounds, placeholder art) for a frontend/UI you are building.
- When the user asks you to generate, create, or draw an image.

Usage:
- No key is required for hosted generation or hosted edits on edit-capable models; a signed-out user without Vertex AI cannot generate images.
- To EDIT an existing image, set input_image to its path (or an https:// URL for edit-capable hosted models) plus a prompt describing the change.
- width/height or aspect_ratio set the size. Hosted models render at least 768x768 total pixels, so a smaller or very wide size is scaled up keeping its aspect ratio.
- The image is saved to disk (default: ./generated-image-<timestamp>.<ext>, extension matches the real format).
- output_path must be inside the working directory.`
}
