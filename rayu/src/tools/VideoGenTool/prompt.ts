import { VIDEO_GEN_TOOL_NAME } from './constants.js'

export { VIDEO_GEN_TOOL_NAME }

export const DESCRIPTION =
  'Generate a video from a text prompt (NVIDIA hosted Cosmos models). Saves the MP4 to disk and returns a preview frame inline.'

export function getVideoGenPrompt(): string {
  return `Generate a short video from a text prompt using NVIDIA's free hosted Cosmos video models. The result is saved to disk as an MP4, and a preview frame is returned inline so you can see it.

When to use:
- When the user asks you to generate, create, or make a video / clip / animation.
- When a UI or asset you are building would benefit from a short generated video.

Usage:
- Generation is asynchronous and takes ~1-2 minutes; the tool waits and tells the user to please wait while the video is generated.
- The MP4 is saved to disk (default: ./generated-video-<timestamp>.mp4) so you can reference it directly from code you write.
- To animate an existing image, set input_image to its path plus a prompt describing the motion.
- Default model is nvidia/cosmos-predict2.5-2b/text2world.
- output_path must be inside the working directory.`
}
