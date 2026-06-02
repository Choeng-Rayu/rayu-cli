import { VIDEO_GEN_TOOL_NAME } from './constants.js'

export { VIDEO_GEN_TOOL_NAME }

export const DESCRIPTION =
  'Generate a video from a text prompt (NVIDIA Cosmos Physical AI models, free with your NVIDIA API key).'

export function getVideoGenPrompt(): string {
  return `Generate a short video from a text prompt using NVIDIA's free Physical AI (Cosmos) models.

Available models (all free, 20 requests each, same NVIDIA_API_KEY from build.nvidia.com):
- nvidia/cosmos-predict1-5b — text-to-video or image-to-video, ~1280×704, 24fps (DEFAULT)
- nvidia/cosmos3-nano — lightweight text-to-video, faster generation
- nvidia/cosmos-transfer1-7b — video style transfer
- stabilityai/stable-video-diffusion — image-to-video, 25 frames at 576×1024

When to use:
- When the user asks to generate, create, or make a video / clip / animation.
- When building a UI that needs a short generated video asset.

Usage:
- Requires NVIDIA_API_KEY (free from build.nvidia.com — same key as image generation).
- Generation takes ~1-2 minutes; the tool waits and polls automatically.
- The MP4 is saved to disk (default: ./generated-video-<timestamp>.mp4).
- output_path must be inside the working directory.`
}
