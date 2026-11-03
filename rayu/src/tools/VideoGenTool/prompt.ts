import { VIDEO_GEN_TOOL_NAME } from './constants.js'

export { VIDEO_GEN_TOOL_NAME }

export const DESCRIPTION =
  'Generate a video from a text prompt (or animate a reference image). Rayu-hosted models are the default when signed in (no API key needed); fal.ai/Vertex keys are used when one of their models is picked.'

export function getVideoGenPrompt(): string {
  return `Generate a short video from a text prompt, or animate an existing image, with server-owned video models.

Backends:
- Rayu-hosted (the DEFAULT when signed in to Rayu): the request goes through the Rayu gateway under the user's account — no provider API key — and is billed per SECOND of generated video in Rayu credits, so the result reports the ACTUAL billed duration, which can differ from the request. A reference image (input_image) is accepted only by hosted models whose catalog entry carries the image2video capability.
- BYO keys: fal.ai (Kling) or Vertex Veo (GOOGLE_CLOUD_PROJECT / ADC). Used when you pass model=<id> of one of their models, when the user picked one with /model_video_generation, when the user is not signed in, or when the catalog has no hosted model for the operation.

Available models are owned by the Rayu catalog, not hardcoded here — the user can open /model_video_generation to list and pick one, or you can pass model=<id> from that list. When nothing is named, the hosted catalog default for the operation is used (an image2video-capable hosted model when input_image is given).

Usage:
- No key is required for hosted generation; a signed-out user with no BYO key cannot generate video.
- input_image: a local PNG/JPEG/WebP path or an https:// URL, for image2video-capable models (a text-to-video-only model refuses it).
- num_frames/fps map to the hosted duration (clamped to 2-30s); width/height/aspect_ratio map to the ratio.
- Each hosted model is ONE resolution tier with its own price (e.g. separate 480P, 720P and 1080P entries). To get another resolution, pass that tier's model id; width/height do not change a hosted model's resolution.
- Generation takes ~1-2 minutes; the tool waits and polls automatically.
- The MP4 is saved to disk (default: ./generated-video-<timestamp>.mp4).
- output_path must be inside the working directory.`
}
