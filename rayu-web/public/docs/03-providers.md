# 3. Providers

A **provider** is an API endpoint plus your credentials. Rayu supports these kinds:

- **`anthropic`** — the Anthropic API (Claude models), via the Anthropic SDK.
- **`openai-compatible`** — any endpoint that implements OpenAI's `/v1/chat/completions` (NVIDIA, DeepSeek, Kimi/Moonshot, Doubleword, OpenAI, OpenRouter, Google Gemini API, vLLM/Ollama/local, …). Requests are translated between the Anthropic message shape used internally and the OpenAI shape.
- **`bedrock`** — AWS Bedrock. Three API surfaces: `converse` (default, model-agnostic AWS Converse API), `openai` (bedrock-mantle OpenAI-compatible endpoint), `anthropic` (Claude via `@anthropic-ai/bedrock-sdk`).
- **`vertex`** — Google **Gemini on Vertex AI**, authenticated with Google OAuth / Application Default Credentials. Served through the OpenAI-compatible adapter with a per-request OAuth bearer token.
- **`genai`** — Login with Gemini (Google account / Code Assist). Interactive OAuth, no GCP project required.
- **`kiro`** — Claude via Kiro's AWS CodeWhisperer backend. Authenticated with a `ksk_` API key or via `kiro-cli` OAuth.
- **`copilot`** — GitHub Copilot. Authenticated with a GitHub OAuth device-flow token (no API key to paste).
- **`rayu-hosted`** — Rayu's own hosted gateway. Activated automatically when you log in with Rayu OAuth (`USE_RAYU_OAUTH=true`).

## Built-in provider presets

| Preset id | Label | Base URL | Auto-import env var |
|-----------|-------|----------|---------------------|
| `anthropic` | Anthropic (Claude) | _(Anthropic SDK default)_ | `ANTHROPIC_API_KEY` |
| `nvidia` | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `doubleword` | Doubleword | `https://api.doubleword.ai/v1` | `DOUBLE_WORD_API_KEY` / `DOUBLEWORD_API_KEY` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `glm` | GLM — Z.ai | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` / `ZHIPUAI_API_KEY` / `GLM_API_KEY` |
| `minimax` | MiniMax | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` |
| `kimi-moonshot` | Kimi / Moonshot | `https://api.moonshot.ai/v1` | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |
| `kimi-for-code` | Kimi for Code | `https://api.kimi.com/coding/v1` | `KIMI_FOR_CODE_API_KEY` |
| `fugu` | Fugu — Sakana AI | `https://api.sakana.ai/v1` | `SAKANA_API_KEY` |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `gemini` | Google Gemini — API key | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `gemini-vertex` | Google Gemini — Vertex AI (OAuth) | _(per project/region)_ | _(OAuth / ADC)_ |
| `gemini-login` | Login with Gemini (Google account) | _(Code Assist — free, no project)_ | _(interactive OAuth)_ |
| `copilot` | GitHub Copilot | _(api.githubcopilot.com)_ | _(GitHub OAuth device flow)_ |
| `xai` | xAI / Grok | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| `togetherai` | Together AI | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` / `TOGETHERAI_API_KEY` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| `baseten` | Baseten | `https://inference.baseten.co/v1` | `BASETEN_API_KEY` |
| `deepinfra` | DeepInfra | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_KEY` |
| `huggingface` | Hugging Face — Inference Providers | `https://router.huggingface.co/v1` | `HF_TOKEN` / `HUGGINGFACE_API_KEY` |
| `kiro` | Kiro — Claude via AWS | _(AWS CodeWhisperer)_ | `KIRO_API_KEY` |
| `bedrock` | AWS Bedrock — Converse API (all models) | _(AWS SDK, region-scoped)_ | `AWS_BEARER_TOKEN_BEDROCK` |
| `bedrock-openai` | AWS Bedrock — OpenAI-compatible (bedrock-mantle) | _(bedrock-mantle, region-scoped)_ | — |
| `bedrock-anthropic` | AWS Bedrock — Claude (Anthropic Messages API) | _(region-scoped)_ | — |
| `ollama` | Ollama (local · auto-detect) | `http://localhost:11434/v1` | _(none required)_ |
| `local` | Custom Endpoint | _(you enter it)_ | — |

---

## AWS Bedrock

Rayu supports three Bedrock presets, each using a different API surface:

| Preset | API surface | Best for |
|--------|-------------|----------|
| `bedrock` | AWS **Converse** API (via AWS SDK) | All Bedrock models — Claude, Kimi, DeepSeek, Llama, etc. Model-agnostic; natively separates reasoning + tool use. |
| `bedrock-openai` | **bedrock-mantle** OpenAI-compatible endpoint | Open-weight models (`gpt-oss`, `qwen`, …). Standard `/v1/chat/completions`. |
| `bedrock-anthropic` | **Anthropic Messages API** (`@anthropic-ai/bedrock-sdk`) | Claude models via cross-region inference profiles. |

### Authentication

All three presets use a **Bedrock Bearer token** (`AWS_BEARER_TOKEN_BEDROCK`). Run `/connect` → pick the desired Bedrock preset, enter your token and AWS region (defaults to `us-east-1`).

Supported regions: `us-east-1`, `us-east-2`, `us-west-2`, `ap-south-1`, `ap-southeast-1`, `ap-southeast-2`, `ap-northeast-1`, `eu-central-1`, `eu-west-1`, `eu-west-3`.

### Model Discovery

- `bedrock` (Converse): calls `GET /foundation-models` and `GET /inference-profiles` on the Bedrock control plane, filtered to ACTIVE models.
- `bedrock-openai`: calls `GET /foundation-models`, filtered to models where `openAiChatCompletions: true`.
- `bedrock-anthropic`: fetches cross-region Claude inference profiles (`/inference-profiles`) plus on-demand Anthropic foundation models.

Results are cached in `~/.rayu/providers.json` and refreshed at startup.

---

## Kiro

The `kiro` preset connects to Claude models through Kiro's AWS CodeWhisperer backend. Two auth methods:

- **API key** (`apikey`): paste a `ksk_…` key from Kiro's dashboard. Set `KIRO_API_KEY` for auto-import.
- **OAuth** (`oauth`): if you have `kiro-cli` installed and logged in, Rayu reads the token from `~/.local/share/kiro-cli/data.sqlite3` automatically — no key to paste.

Default model: `claude-sonnet-4.6`. Small/fast model: `claude-haiku-4.5`.

---

## GitHub Copilot

The `copilot` preset uses your existing GitHub Copilot subscription. No API key: Rayu performs a GitHub OAuth device-flow login (opens a browser code page), exchanges the GitHub token for a short-lived Copilot token, and auto-refreshes it. Models are fetched live from `api.githubcopilot.com/models` (Claude, GPT, Gemini, and more, depending on your subscription).

---

## GLM — Z.ai

The `glm` preset connects to Zhipu AI's GLM family via `https://api.z.ai/api/paas/v4`. GLM-5.2 is the flagship coding/agent model with a 1M-token context; GLM-4.6 is 200K; GLM-4.5 family is 128K. All GLM-4.5+ models emit native chain-of-thought via `reasoning_content`. Set `ZAI_API_KEY`, `ZHIPUAI_API_KEY`, or `GLM_API_KEY`.

---

## MiniMax

The `minimax` preset connects to `https://api.minimax.io/v1`. MiniMax-M3 is the frontier model (1M context); MiniMax-M2.x models are 204,800 tokens. All M-series models think natively by default (reasoning returned as `reasoning_content` or inline `<think>…</think>`). Set `MINIMAX_API_KEY`.

---

## Fugu — Sakana AI

The `fugu` preset connects to Sakana AI's multi-agent system at `https://api.sakana.ai/v1`. Two models: `fugu` (default, routes across providers) and `fugu-ultra` (premium). Both have a 1M-token context window. Set `SAKANA_API_KEY`.

---

## Google Gemini

Rayu supports Gemini two ways — pick whichever matches how you access Google's models.

### Gemini API key (`gemini`)

The simplest path. Google's Gemini API exposes an **OpenAI-compatible** surface at
`https://generativelanguage.googleapis.com/v1beta/openai`, so Rayu reuses its
OpenAI-compatible adapter and live `/models` catalog.

- Run `/connect` → **Google Gemini — API key**, paste your key (from Google AI Studio).
- Or set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and let auto-import pick it up.
- `/model` lists the live Gemini catalog (e.g. `gemini-2.5-flash`, `gemini-2.5-pro`, newer `gemini-3.x` models as they ship).

### Gemini on Vertex AI (`gemini-vertex`, OAuth / ADC)

For Google Cloud users. Authenticated with a Google Cloud OAuth bearer token
(cloud-platform scope) rather than a static key, scoped to a **project + region**.
The token is minted per request and refreshed automatically (~1h lifetime).

> **Recommended for heavy use.** Unlike the consumer "Login with Gemini" path
> (which has a tight per-request rate window), Vertex uses **quota-based limits
> on your own GCP project**, so large codebase reads / many requests don't trip
> the ~40–60s consumer throttle. It's also the durable option given the consumer
> endpoint's planned deprecation.

**Project prerequisites** (one-time): the project must have the **Vertex AI API
enabled** (console.cloud.google.com/apis/library/aiplatform.googleapis.com) with
**billing active**, and your account needs the **Vertex AI User** role
(`roles/aiplatform.user`). If these are missing you'll get a `403
PERMISSION_DENIED` ("Vertex AI API has not been used in project …") — Rayu
surfaces these exact steps when that happens.

Run `/connect` → **Google Gemini — Vertex AI (OAuth / ADC)**:

1. Rayu checks for **Application Default Credentials** (e.g. from
   `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`).
2. If none are found, it offers an in-terminal **"Sign in with Google"** loopback
   OAuth flow (opens your browser, captures the redirect on `localhost`, and
   stores a refresh token in `~/.rayu/gemini-oauth.json`, mode `0600`).
3. It pre-fills and confirms the **GCP project** and **region** (detected from
   env / ADC where possible), then fetches the Gemini model catalog from the
   Vertex publisher API.

Relevant environment variables:

| Variable | Meaning |
|----------|---------|
| `GOOGLE_CLOUD_PROJECT` / `ANTHROPIC_VERTEX_PROJECT_ID` | GCP project id for Vertex |
| `GOOGLE_CLOUD_LOCATION` / `CLOUD_ML_REGION` | Vertex region (default `global`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account key (ADC) |
| `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` | Override the OAuth client used for the loopback login (defaults to the public Google Cloud SDK desktop client) |

Vertex chat requests are sent to
`https://{region}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{region}/endpoints/openapi/chat/completions`
with the model id namespaced as `google/<model>` automatically.

The same OAuth/ADC credentials also power **Imagen 4** image generation and
**Veo 3.1** video generation — see [Image Generation](./12-image-generation.md).

### Login with Gemini (`gemini-login`, Google account)

The simplest path, with **gemini-cli parity**: sign in with a Google account in
your browser and use Gemini 3.x for **free — no GCP project, no billing, no
`gcloud`**. It uses the **Gemini Code Assist** backend
(`cloudcode-pa.googleapis.com`, the same one the Gemini CLI uses), which gives a
free tier tied to your Google account (a Google-managed project is onboarded
automatically on first use).

Setup — nothing to configure:

1. Run `/connect` → **Login with Gemini (Google account)** → *Sign in with
   Google*. The browser opens; approve access; control returns to the terminal.
   Rayu onboards the Code Assist free tier and lists Gemini models (defaulting
   to the newest flash).

That's it — **no Google Cloud project, API enablement, billing, OAuth client, or
consent test users.** Rayu uses gemini-cli's built-in public installed-app OAuth
client (the secret is intentionally non-confidential for installed apps), whose
Google project already has the Code Assist API enabled.

Advanced (optional): to use your **own** OAuth client instead, set
`GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` in `.env` (or drop a
Desktop `client_secret.json` at the project root). Your client's project must
then have the **Cloud Code / Cloud AI Companion API enabled**, and your account
added as a **Test user** on its consent screen — otherwise you'll get a 403
("Cloud Code Private API has not been used in project …"). For most users, the
default (no config) is the right choice.

Tokens are cached at `~/.rayu/gemini-login.json` (mode `0600`) and refreshed
automatically. **Note:** the Code Assist endpoint is a semi-internal API (not an
officially published REST surface); it powers the free Gemini CLI experience and
may change.

**Rate limits & heavy use.** Consumer Gemini plans (free / AI Pro / Ultra) meter
by *request complexity* — a single heavy agentic turn (large file reads, image
generation, long context) can consume a whole ~40–60s rate-limit window, after
which you get `RESOURCE_EXHAUSTED (429)`. Rayu waits out and retries that window
automatically (like the Gemini CLI), so heavy tasks still complete — just more
slowly. Tune with `RAYU_GEMINI_MAX_WAIT_S` (seconds to wait before surfacing a
429; set `0` to fail fast). The default model is **`gemini-2.5-flash`** (lowest
per-request cost); pick a pro/preview model via `/model` when needed.

> **For sustained heavy use, prefer the Vertex AI provider** (next section) —
> it uses quota-based limits on your own GCP project instead of the consumer
> rate window. Google has migrated the consumer Code Assist endpoint for
> free/Pro/Ultra accounts to "Antigravity" (as of ~June 2026), so Vertex
> is the more durable and reliable choice.

---

## Ollama & Local Models

Rayu seamlessly connects to your local instances and cloud Ollama environments.

- **Localhost:** Run `/connect` → **Localhost**. Ollama auto-detects whatever models you have downloaded and connects automatically. It supports models of any size (there is no forcing you to use massive models if you don't want to).
- **Ollama Cloud:** Works through the exact same localhost flow. After running `ollama signin` in your terminal, cloud models (e.g., `qwen3-coder:480b-cloud`, `gpt-oss:120b-cloud`) automatically appear in your local Ollama's model list and fully support tools within Rayu.
- *(Alternative for Ollama Cloud)*: You can also choose the "Custom OpenAI-compatible endpoint" option in `/connect` and point it at `https://ollama.com/v1` with your API key.

---

## Image / video generation models

The built-in image/video tools default to NVIDIA but can be pointed at Vertex
Imagen / Veo (or any registered model):

- `/model_image_generation` — choose the model for `/generate-image` and
  `/image-editor` (NVIDIA FLUX/SD or Vertex `imagen-*`).
- `/model_video_generation` — choose the model for `/image-video` (NVIDIA
  Cosmos / fal.ai or Vertex `veo-*`).

Selecting "Default" reverts to NVIDIA (or Vertex when it's the only configured
backend). Selections are stored in `~/.rayu/providers.json`.

---

## Connecting a provider with `/connect`

In an interactive session:

```
/connect
```

1. **Pick a provider type** from the list.
2. **Enter the credentials**:
   - For **AWS Bedrock**: enter Bearer token (or enter nothing to use local AWS credentials) and target region.
   - For **OpenAI-compatible**: enter API key. For `local`/custom you also enter a base URL and a default model.
3. Rayu **fetches the model catalog** and opens the searchable model picker so you can choose a model immediately.

The provider (id, key, base URL, default model, fetched model list) is saved to `~/.rayu/providers.json` and becomes the active provider.

---

## Auto-import from `.env`

On startup, Rayu reads a project-local `.env` (and the environment) and imports any known provider keys into `~/.rayu/providers.json`, so providers you already have keys for are ready without running `/connect`.

Example `.env`:

```env
NVIDIA_API_KEY=nvapi-xxxxx
DEEPSEEK_API_KEY=sk-xxxxx
KIMI_FOR_CODE_API_KEY=sk-xxxxx
DOUBLE_WORD_API_KEY=xxxxx
AWS_BEARER_TOKEN_BEDROCK=aws-xxxxx
```

Imported providers use their preset base URL and default model. The first imported provider becomes active if none is set yet.

---

## Headless provider selection (env overrides)

For scripts/CI, you can bypass the saved config entirely using environment variables:

| Variable | Meaning |
|----------|---------|
| `RAYU_OPENAI_COMPATIBLE=1` | Force the OpenAI-compatible client path |
| `RAYU_OPENAI_BASE_URL` | Base URL for the OpenAI-compatible endpoint |
| `RAYU_OPENAI_API_KEY` | API key for the OpenAI-compatible endpoint |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS Bedrock Bearer token override |
| `BEDROCK_BASE_URL` | Custom Bedrock base URL endpoint |
| `AWS_DEFAULT_REGION` / `AWS_REGION` | AWS Region (default: `us-east-1`) |
| `ANTHROPIC_API_KEY` | Anthropic key (first-party path) |

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://api.deepseek.com/v1 \
RAYU_OPENAI_API_KEY=$DEEPSEEK_API_KEY \
rayu --print --model deepseek-chat "hello"
```

These env vars take precedence over the active provider in `providers.json`.

---

## Switching providers

- `/connect` — add/select a provider, then choose a model.
- `/model` — switch models across **all** connected providers; selecting a model from a different provider also switches the active provider automatically.

---

## How translation works (OpenAI-compatible)

For OpenAI-compatible providers, Rayu translates:

- **Request:** Anthropic `system`/`messages`/`tools`/`tool_use`/`tool_result`/`tool_choice` → OpenAI `chat/completions` (`tools`, `tool_calls`, `tool` role, `tool_choice`). `tool` messages are ordered to immediately follow the assistant `tool_calls` they answer (required by OpenAI/NVIDIA).
- **Images / vision:** Anthropic image blocks (base64 or URL) → OpenAI `image_url` parts (a `data:` URI for base64). Works for images you paste and for images returned by tools (re-emitted as a follow-up user message, since the `tool` role can't carry images). Use a vision model (see [Models](./04-models.md)).
- **Model-aware params:** reasoning models (`o1`/`o3`/`o4`/`gpt-5`) get `max_completion_tokens` instead of `max_tokens` and no `temperature` (sending them 400s); other models are unchanged.
- **Reasoning display:** providers that return `reasoning_content` (DeepSeek) or `reasoning` (Qwen/Doubleword/OpenRouter) surface as a **thinking** block in both streaming and non-streaming responses.
- **Response/stream:** OpenAI completion / SSE deltas → Anthropic stream events (`message_start` → `content_block_*` → `message_delta` → `message_stop`), including streamed tool calls and thinking.
- **Reliability:** transient errors (429 / 5xx / connection) are normalized to the Anthropic SDK error shape so the standard retry/backoff applies; if a provider rejects `stream_options`, Rayu retries the stream once without it.

Translation problems are recorded to diagnostics (see [Diagnostics](./09-diagnostics-privacy.md)).

---

## Security

- API keys are stored in `~/.rayu/providers.json` with file mode `0600` (owner-only). Rayu warns (a `vulnerability` diagnostic) if the file is group/world-readable.
- Keys are sent only to the provider's configured base URL and are never logged.

Next: [Models →](./04-models.md)
