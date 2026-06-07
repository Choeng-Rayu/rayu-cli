# 3. Providers

A **provider** is an API endpoint plus your credentials. Rayu supports these kinds:

- **`anthropic`** — the Anthropic API (Claude models), via the Anthropic SDK.
- **`openai-compatible`** — any endpoint that implements OpenAI's `/v1/chat/completions` (NVIDIA, DeepSeek, Kimi/Moonshot, Doubleword, OpenAI, OpenRouter, Google Gemini API, vLLM/Ollama/local, …). Requests are translated between the Anthropic message shape used internally and the OpenAI shape.
- **`bedrock`** — the AWS Bedrock API, via the `@anthropic-ai/bedrock-sdk` client.
- **`vertex`** — Google **Gemini on Vertex AI**, authenticated with Google OAuth / Application Default Credentials. Served through the OpenAI-compatible adapter with a per-request OAuth bearer token.

## Built-in provider presets

| Preset id | Label | Base URL | Auto-import env var |
|-----------|-------|----------|---------------------|
| `anthropic` | Anthropic (Claude) | _(default API)_ | `ANTHROPIC_API_KEY` |
| `nvidia` | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `doubleword` | Doubleword | `https://api.doubleword.ai/v1` | `DOUBLE_WORD_API_KEY` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `kimi-moonshot` | Kimi / Moonshot | `https://api.moonshot.ai/v1` | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |
| `kimi-for-code` | Kimi for Code | `https://api.kimi.com/coding/v1` | `KIMI_FOR_CODE_API_KEY` |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `gemini` | Google Gemini — API key | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `gemini-vertex` | Google Gemini — Vertex AI (OAuth) | _(per project/region)_ | _(OAuth / ADC)_ |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `local` | Local / custom | _(you enter it)_ | — |
| `bedrock` | AWS Bedrock | _(on-demand AWS Bedrock)_ | `AWS_BEARER_TOKEN_BEDROCK` |

---

## AWS Bedrock (`bedrock`)

Rayu-CLI natively supports AWS Bedrock. When the active provider is `bedrock`, Rayu uses the `@anthropic-ai/bedrock-sdk` to connect directly to Bedrock.

### Authentication

There are two ways to authenticate with AWS Bedrock:

1. **Bearer Token (Recommended for `/connect`):**
   Run `/connect` and pick **AWS Bedrock**. You will be prompted to enter:
   - **AWS Bedrock API Key:** Stored as `apiKey` or `bearerToken` inside `~/.rayu/providers.json`.
   - **AWS Region:** The AWS region where Bedrock is enabled (defaults to `us-east-1`).

2. **Standard AWS Credentials (Fallback):**
   If you leave the API key blank in `/connect`, Rayu will fall back to using default AWS credentials from your environment or standard AWS credentials file (`~/.aws/credentials`):
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_SESSION_TOKEN` (optional)
   - `AWS_DEFAULT_REGION` or `AWS_REGION`

### Model Discovery

When you connect to AWS Bedrock, Rayu queries your AWS account for available models:
1. **Foundation Models:** Calls `ListFoundationModels` (returns on-demand foundation models available in your region, including Claude, DeepSeek, Llama, Mistral, etc.).
2. **Inference Profiles:** Calls `ListInferenceProfiles` (returns cross-region Claude inference profiles).

These are merged and cached in `~/.rayu/providers.json`. This allows the `/model` command to list and switch between all available Bedrock models in your account.

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
| `GOOGLE_CLOUD_LOCATION` / `CLOUD_ML_REGION` | Vertex region (default `us-central1`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account key (ADC) |
| `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` | Override the OAuth client used for the loopback login (defaults to the public Google Cloud SDK desktop client) |

Vertex chat requests are sent to
`https://{region}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{region}/endpoints/openapi/chat/completions`
with the model id namespaced as `google/<model>` automatically.

The same OAuth/ADC credentials also power **Imagen 4** image generation and
**Veo 3.1** video generation — see [Image Generation](./12-image-generation.md).

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
| `CLAUDE_CODE_USE_BEDROCK=1` | Force the AWS Bedrock client path |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS Bedrock Bearer token override |
| `BEDROCK_BASE_URL` | Custom Bedrock base URL endpoint |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1` | Skip standard AWS authentication header |
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
