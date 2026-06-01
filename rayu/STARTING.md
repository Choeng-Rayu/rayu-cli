# Starting Rayu-CLI

## 1. Build

```bash
cd claude-code
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run build                         # → dist/rayu.js
node dist/rayu.js --version           # 0.1.0 (Rayu-CLI)
```

Optional alias: `alias rayu="node $PWD/dist/rayu.js"`

## 2. Run

```bash
node dist/rayu.js
```

First run walks you through theme → provider → API key. Keys are saved to
`~/.rayu/providers.json` (mode 0600).

## 3. Providers

Built-in OpenAI-compatible providers (all support tool calling + live model list):

| Provider | Base URL | Env var (auto-imported from .env) |
|---|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| Doubleword | `https://api.doubleword.ai/v1` | `DOUBLE_WORD_API_KEY` |
| DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| Kimi / Moonshot | `https://api.moonshot.ai/v1` | `KIMI_FOR_CODE_API_KEY` |
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Anthropic | (default API) | `ANTHROPIC_API_KEY` |

Keys found in a project-local `.env` (or the environment) under those names are
auto-imported into `~/.rayu/providers.json` at startup.

## 4. Add / switch providers: `/connect`

Inside the session, run `/connect`:

1. Pick a provider type.
2. Enter the API key (masked). Local/custom endpoints also ask for base URL + model.
3. Rayu fetches the provider's live model catalog and opens the model picker.

## 5. Switch models: `/model`

Lists the active provider's live models (default first); you can also type any
model id the endpoint supports.

## 6. Headless (no wizard)

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://api.deepseek.com/v1 \
RAYU_OPENAI_API_KEY=$DEEPSEEK_API_KEY \
node dist/rayu.js --print --model deepseek-chat "summarize this repo"
```

## 7. Env vars

| Variable | Purpose |
|---|---|
| `RAYU_CONFIG_DIR` | Config dir (default `~/.rayu`) |
| `RAYU_OPENAI_COMPATIBLE=1` | Force the OpenAI-compatible path |
| `RAYU_OPENAI_BASE_URL` / `RAYU_OPENAI_API_KEY` | Headless provider creds |
| `RAYU_DIAGNOSTICS=1` | Echo diagnostics to stderr |
| `RAYU_TELEMETRY=1` | Opt back into telemetry (off by default) |

## 8. Tests

```bash
bun test          # hermetic unit tests (translation, config, models, providers, network guard)

# opt-in live end-to-end tests against your configured providers (uses credits):
RAYU_LIVE=1 bun test test/liveSmoke.test.ts
```

The live smoke suite exercises chat, tool round-trips, vision, streaming, and
reasoning against the providers in `~/.rayu/providers.json` (it skips cleanly
when `RAYU_LIVE` is unset or no provider is configured).
