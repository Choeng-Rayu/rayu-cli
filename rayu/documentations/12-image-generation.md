# Image Generation

Rayu-CLI ships a built-in `GenerateImage` tool that lets the agent **create and
edit images** from a text prompt using NVIDIA's free hosted image models. The
agent uses it automatically when it needs an image (for example, generating
assets for a frontend it is building) or when you ask for one.

## Requirements

- A configured **NVIDIA** provider (the tool reuses the `nvidia` API key from
  `~/.rayu/providers.json`, or the `NVIDIA_API_KEY` environment variable).
  Run `/connect` and pick NVIDIA, or set `NVIDIA_API_KEY`.

The tool is hidden when no NVIDIA key is configured.

## What it does

1. Calls the NVIDIA genai endpoint (`https://ai.api.nvidia.com/v1/genai/<model>`).
2. **Saves** the PNG to disk (default `./generated-image-<timestamp>.png`, always
   inside the working directory) so generated assets can be referenced from code.
3. Returns the image **inline** so the model can see the result.
4. **Displays** it in your terminal when supported (iTerm2, WezTerm, Kitty,
   Ghostty); otherwise it prints the saved path.

## Parameters

| Param | Description |
|-------|-------------|
| `prompt` (required) | Text description of the image, or the edit to make. |
| `output_path` | Where to save the PNG (inside the working directory). |
| `model` | Image model id (see below). |
| `width` / `height` | Dimensions (FLUX models). |
| `aspect_ratio` | e.g. `1:1`, `16:9` (Stable Diffusion models). |
| `steps`, `cfg_scale`, `seed`, `negative_prompt` | Sampling controls. |
| `input_image` | Path to an existing image to **edit** (routes to an editing model). |

## Models

| Model id | Use |
|----------|-----|
| `black-forest-labs/flux.1-schnell` | **Default** — fast text→image |
| `black-forest-labs/flux.1-dev` | Higher-quality text→image |
| `stabilityai/stable-diffusion-3.5-large` | High-quality, `aspect_ratio`/`negative_prompt` |
| `black-forest-labs/flux.1-kontext-dev` | Image **editing** (used automatically with `input_image`) |
