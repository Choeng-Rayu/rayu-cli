# 3. Providers

A **provider** is an API endpoint plus your API key. Rayu supports two kinds:

- **`anthropic`** — the Anthropic API (Claude models), via the Anthropic SDK.
- **`openai-compatible`** — any endpoint that implements OpenAI's
  `/v1/chat/completions` (NVIDIA, DeepSeek, Kimi/Moonshot, Doubleword, OpenAI,
  OpenRouter, vLLM/Ollama/local, …). Requests are translated between the
  Anthropic message shape used internally and the OpenAI shape.

## Built-in provider presets

| Preset id | Label | Base URL | Auto-import env var |
|-----------|-------|----------|---------------------|
| `anthropic` | Anthropic (Claude) | _(default API)_ | `ANTHROPIC_API_KEY` |
| `nvidia` | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `doubleword` | Doubleword | `https://api.doubleword.ai/v1` | `DOUBLE_WORD_API_KEY` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `kimi` | Kimi / Moonshot | `https://api.moonshot.ai/v1` | `KIMI_FOR_CODE_API_KEY` |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `local` | Local / custom | _(you enter it)_ | — |

All OpenAI-compatible presets support tool calling and a live model list
(`GET {baseURL}/models`).

## Connecting a provider with `/connect`

In an interactive session:

```
/connect
```

1. **Pick a provider type** from the list.
2. **Enter the API key** (input is masked). For `local`/custom you also enter a
   base URL and a default model.
3. Rayu **fetches the model catalog** and opens the searchable model picker so
   you can choose a model immediately.

The provider (id, key, base URL, default model, fetched model list) is saved to
`~/.rayu/providers.json` and becomes the active provider.

## Auto-import from `.env`

On startup Rayu reads a project-local `.env` (and the environment) and imports
any known provider keys into `~/.rayu/providers.json`, so providers you already
have keys for are ready without running `/connect`.

Example `.env`:

```
NVIDIA_API_KEY=nvapi-xxxxx
DEEPSEEK_API_KEY=sk-xxxxx
KIMI_FOR_CODE_API_KEY=sk-xxxxx
DOUBLE_WORD_API_KEY=xxxxx
```

Imported providers use their preset base URL and default model. The first
imported provider becomes active if none is set yet.

## Headless provider selection (env overrides)

For scripts/CI you can bypass the saved config entirely:

| Variable | Meaning |
|----------|---------|
| `RAYU_OPENAI_COMPATIBLE=1` | Force the OpenAI-compatible client path |
| `RAYU_OPENAI_BASE_URL` | Base URL for the endpoint |
| `RAYU_OPENAI_API_KEY` | API key for the endpoint |
| `ANTHROPIC_API_KEY` | Anthropic key (first-party path) |

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://api.deepseek.com/v1 \
RAYU_OPENAI_API_KEY=$DEEPSEEK_API_KEY \
rayu --print --model deepseek-chat "hello"
```

These env vars take precedence over the active provider in `providers.json`.

## Switching providers

- `/connect` — add/select a provider, then choose a model.
- `/model` — switch models across **all** connected providers; selecting a model
  from a different provider also switches the active provider automatically.

## How translation works (OpenAI-compatible)

For openai-compatible providers, Rayu translates:

- **Request:** Anthropic `system`/`messages`/`tools`/`tool_use`/`tool_result`
  → OpenAI `chat/completions` (`tools`, `tool_calls`, `tool` role).
- **Response/stream:** OpenAI completion / SSE deltas → Anthropic stream events
  (`message_start` → `content_block_*` → `message_delta` → `message_stop`),
  including streamed tool calls.

Translation problems are recorded to diagnostics (see
[Diagnostics](./09-diagnostics-privacy.md)).

## Security

- API keys are stored in `~/.rayu/providers.json` with file mode `0600`
  (owner-only). Rayu warns (a `vulnerability` diagnostic) if the file is
  group/world-readable.
- Keys are sent only to the provider's configured base URL and are never logged.

Next: [Models →](./04-models.md)
