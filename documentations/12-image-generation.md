# Image Generation

Rayu-CLI ships a built-in `GenerateImage` tool that lets the agent **create and
edit images** from a text prompt, using either NVIDIA's free hosted image models
or Google **Imagen 4** on Vertex AI. The agent uses it automatically when it
needs an image (for example, generating assets for a frontend it is building) or
when you ask for one.

## Requirements

Either backend enables the tool:

- **NVIDIA** — reuses the `nvidia` API key from `~/.rayu/providers.json`, or the
  `NVIDIA_API_KEY` environment variable. Run `/connect` and pick NVIDIA, or set
  `NVIDIA_API_KEY`.
- **Google Vertex AI (Imagen 4)** — uses a configured **Gemini / Vertex AI**
  provider (OAuth / ADC). Run `/connect` → *Google Gemini — Vertex AI*, or have
  Application Default Credentials + `GOOGLE_CLOUD_PROJECT` set. See
  [Providers](./03-providers.md#google-gemini).

The tool is hidden when neither backend is configured. When both are available,
selecting an `imagen-*` model routes to Vertex; otherwise NVIDIA is used (Vertex
is used automatically when it is the only configured backend).

## What it does

1. Calls the NVIDIA genai endpoint (`https://ai.api.nvidia.com/v1/genai/<model>`).
2. **Saves** the PNG to disk (default `./generated-image-<timestamp>.png`, always
   inside the working directory) so generated assets can be referenced from code.
3. Returns the image **inline** so the model can see the result.
4. **Displays** it in your terminal: native inline image on iTerm2/WezTerm, or
   truecolor ANSI half-blocks on any 24-bit/256-color terminal (xterm-256color,
   Kitty, Ghostty, most Linux terminals). Falls back to printing the path.

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

### Vertex AI (Imagen)

Available when a Gemini / Vertex AI provider is configured.

| Model id | Use |
|----------|-----|
| `imagen-4.0-generate-001` | **Default (Vertex)** — text→image |
| `imagen-4.0-fast-generate-001` | Faster, lower-cost text→image |
| `imagen-4.0-ultra-generate-001` | Highest-quality text→image |
| `imagen-3.0-capability-001` | Image **editing** (used automatically with `input_image` on Vertex) |

## Video generation (`GenerateVideo`)

The companion `GenerateVideo` tool generates short videos from a text prompt. It
is enabled by NVIDIA/fal.ai keys or by a Gemini / Vertex AI provider. On Vertex
it uses **Veo 3.1** (`veo-3.1-generate-001`, `veo-3.1-fast-generate-001`)
via the long-running prediction API (Rayu polls until the video is ready, then
saves the MP4 inside the working directory).

