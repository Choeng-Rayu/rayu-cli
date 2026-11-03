# Image Generation

Rayu-CLI ships a built-in `GenerateImage` tool that lets the agent **create and
edit images** from a text prompt. Two backends are supported:

- **Rayu-hosted** — billed to your Rayu account in credits, **no provider key needed**.
- **Google Imagen 4** on Vertex AI — your own GCP project.

NVIDIA image and video generation (FLUX, Stable Diffusion, Kontext, Cosmos, SVD)
was removed. An `NVIDIA_API_KEY` no longer enables either tool; NVIDIA remains
available as a **chat** provider.

The agent uses the tool automatically when it needs an image (for example,
generating assets for a frontend it is building) or when you ask for one.

## Requirements

Either of these enables the tool:

- **Rayu account (recommended)** — run `/login`. Hosted image models are then
  available immediately; there is no provider key to configure. Usage is billed
  per generated image against your plan/credits, exactly like hosted chat models.
  Free plans see the tool but get an upgrade prompt when they use it.
- **Google Vertex AI (Imagen 4)** — uses a configured **Gemini / Vertex AI**
  provider (OAuth / ADC). Run `/connect` → *Google Gemini — Vertex AI*, or have
  Application Default Credentials + `GOOGLE_CLOUD_PROJECT` set. See
  [Providers](./03-providers.md#google-gemini).

The tool is hidden when neither is configured. Model routing follows the
model you selected (or `input.model`):

- a **`backend: "rayu"`** catalog entry goes to the Rayu gateway;
- an `imagen-*` (or Vertex-backed) model goes to Vertex.

When you are signed in, the default is the **Rayu-hosted** model, even if Vertex
is also configured. Vertex is used when you pick one of its models in
`/model_image_generation` (or pass `model`), when you are signed out, or when the
catalog has no hosted model for the operation.

### Rayu-hosted models

Hosted models run on the Rayu gateway (`POST /v1/images/generations`) with your
Rayu session token; the gateway holds the upstream provider key. The provider is
**Qwen Cloud** (`wan2.7-image`, `wan2.7-image-pro`), and the catalog is
admin-owned, so a newly added provider or model appears without a CLI update.
The lowest **Sort Order** in Admin → Media Catalogs is the default.

**Editing is capability-driven.** Each hosted catalog entry advertises what it
can do; a model with `edit` accepts `input_image` (a local PNG/JPEG/WebP, or an
`https://` URL) and the gateway maps it to the upstream image-to-image call.
A model advertising only `generate` refuses the request up front with
*"Hosted image model \"<id>\" is generate-only — pick a model that supports edit,
or remove input_image."* Wan 2.7 and Qwen Image on `dashscope_multimodal` support
both; generic `openai_images` providers are generate-only. An edit is billed as
one image, exactly like a generation.

Hosted Qwen models render at least 768×768 total pixels. A smaller size, or a
very wide one such as `1024x512`, is scaled up by the gateway keeping its aspect
ratio (`1024x512` becomes `1088x544`).

Reference images travel as a `data:` URL: local files are read, mime-checked,
and capped at 12 MiB decoded (the gateway's request ceiling is 16 MiB, and
base64 inflates by ~4/3).

The gateway is the authoritative billed meter: it reserves and settles
`images × creditsPerImage` per request and the CLI's monthly feature counter is
only local UX.

## What it does

1. Calls the selected backend:
   - Rayu-hosted: `POST {gateway}/v1/images/generations` (with `image` for
    edit-capable models);
   - Vertex: the Imagen `:predict` endpoint.
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
| `width` / `height` | Output size (hosted models; scaled up to at least 768×768 total pixels). |
| `aspect_ratio` | e.g. `1:1`, `16:9`. |
| `seed`, `negative_prompt` | Sampling controls. |
| `input_image` | Path to an existing image to **edit** (routes to an editing model). |

## Models

The model list is **not** built into the CLI. It comes from the Rayu media-model
catalog at runtime (`GET /v1/models?media=all` on the gateway), backed by:

- the admin-managed `media_models` table for bring-your-own Vertex and fal.ai
  models (rows for the removed NVIDIA backends are ignored), and
- the admin-managed `image_models` table for **Rayu-hosted** models, which the
  gateway returns as `backend: "rayu"` entries.

`/model_image_generation` fetches the catalog again every time it opens, the way
`/model` refreshes the chat models, so a model the admin adds, renames, reorders
or disables shows up immediately. Hosted models are listed first, in the admin's
Sort Order. The same command works in the VS Code extension (Rayucode), which
shows the same list in the same order.

When you are signed out (or `USE_RAYU_OAUTH=false`), the CLI falls back to a
built-in Vertex list so direct-key image generation keeps working offline.
Hosted models are server-owned and never invented offline.

### Vertex AI (Imagen)

Available when a Gemini / Vertex AI provider is configured.

| Model id | Use |
|----------|-----|
| `imagen-4.0-generate-001` | **Default (Vertex)** — text→image |
| `imagen-4.0-fast-generate-001` | Faster, lower-cost text→image |
| `imagen-4.0-ultra-generate-001` | Highest-quality text→image |
| `imagen-3.0-capability-001` | Image **editing** (used automatically with `input_image` on Vertex) |

`VERTEX_IMAGE_MODEL` / `VERTEX_EDIT_MODEL` pin a Vertex default for a one-off run.

### Rayu-hosted (Qwen Wan 2.7)

Available to any signed-in Rayu user — no provider key. Model ids come from the
dashboard's `image_models` catalog, so the exact codes are whatever the admin
created, for example:

| Model id | Use |
|----------|-----|
| `rayu-wan2.7-image` | Hosted text→image and editing — **default**, no key required |
| `rayu-wan2.7-image-pro` | Higher-quality hosted text→image and editing |

## Video generation (`GenerateVideo`)

The companion `GenerateVideo` tool generates short videos from a text prompt. It
is enabled by **any one** of:

- a **signed-in Rayu account** — hosted video models, no provider key needed;
- a **fal.ai** key (`FAL_KEY`, or `/connect`);
- a configured **Gemini / Vertex AI** provider (Veo 3.1).

Use it from the agent or with `/image-video <prompt>`. `/model_video_generation`
lists the live catalog the same way `/model_image_generation` does.

### Rayu-hosted video (Qwen Wan 3.0)

Hosted video runs on the Rayu gateway (`POST /v1/videos/generations`) with your
Rayu session token; the gateway holds the upstream provider key. The provider is
**Qwen Cloud** serving **`wan3.0-video`**.

- **No provider key required** — just `/login`. When you are signed in this is
  the default, even if a fal or Vertex key is also configured.
- **Billed per second** of generated video (`billingUnit: "video_second"`), like
  hosted chat tokens. **The admin sets the price**; the CLI only reports what the
  gateway bills. A failed render is not charged. A Free plan sees the tool and
  gets an upgrade prompt.
- **Text-to-video and image-to-video.** `input_image` (a local PNG/JPEG/WebP or
  an `https://` URL) is accepted by catalog entries that advertise `image2video`.
- **One catalog entry per resolution tier** (for example 480P, 720P and 1080P
  entries, each with its own price). Pick the entry for the resolution you want;
  the gateway refuses a request for a different tier than the entry's own.
- Duration 2–30 seconds, ratios `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `adaptive`.
- Provider limits: **5 concurrent** generations and **300 requests/minute** per
  account; the gateway queues or rejects beyond that.

Parameter mapping for hosted models:

| Tool param | Sent as |
|------------|---------|
| `num_frames` + `fps` | `duration` = round(frames / fps), clamped 2–30 |
| `aspect_ratio` (one of the five, or `adaptive`) | `ratio` verbatim |
| `width` + `height` | `ratio` = nearest of the five |
| `input_image` | `image` (the gateway sends it as a reference image) |
| `negative_prompt`, `seed` | forwarded |

Model ids and defaults come from the dashboard's hosted video catalog, so more
may appear without a CLI update.

### Model selection and fallback

The default is chosen in this order (images follow the same rules):

1. an explicitly requested `model` (validated; never silently swapped);
2. the model remembered from `/model_video_generation`;
3. for a signed-in user, the first **Rayu-hosted** model in the admin's order
   that can do the operation (image-to-video when a reference image is given);
4. otherwise the default of a configured BYO backend (fal.ai, then Vertex).

If a remembered model belongs to a backend you no longer have credentials for (a
stale fal id, a Vertex model after your GCP project is gone, or an NVIDIA id saved
by an older CLI), the CLI **falls back to the hosted model** instead of failing
with "API key not configured".

### fal.ai (Kling) and Vertex (Veo)

fal.ai serves Kling 2.1 text-to-video and image-to-video through its queue API
with your `FAL_KEY`. On Vertex it uses **Veo 3.1** (`veo-3.1-generate-001`,
`veo-3.1-fast-generate-001`) via the long-running prediction API (Rayu polls
until the video is ready, then saves the MP4 inside the working directory).
