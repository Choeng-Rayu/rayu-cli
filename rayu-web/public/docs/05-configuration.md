# 5. Configuration

## Config home directory

Rayu resolves a single **config home directory** used for settings, providers,
sessions, skills, projects, etc. Resolution order:

1. **`RAYU_CONFIG_DIR`** — explicit override.
2. **`~/.rayu`** — if it exists (Rayu's own config).
3. **`~/.rayu`** — default for fresh installs.

Force a different directory with the env var:

```bash
RAYU_CONFIG_DIR=/tmp/rayu-test rayu  # isolated/throwaway config
```

## Files & locations

Within the config home (e.g. `~/.rayu/`):

| Path | Purpose | Notes |
|------|---------|-------|
| `providers.json` | Rayu providers: id, kind, apiKey, baseURL, default/fetched models, context overrides, subagent/image/video selections | mode `0600` (secrets) |
| `settings.json` | User settings, incl. the selected `model` | |
| `diagnostics.jsonl` | Recorded bugs/issues/vulnerabilities | append-only JSONL |
| `rayu-auth.json` | Rayu OAuth session token (when using Rayu hosted login) | mode `0600` |
| `rayu-entitlements.json` | Cached plan entitlements for the signed-in user | mode `0600`; refreshed every 30s |
| `gemini-oauth.json` | Vertex AI OAuth refresh token | mode `0600` |
| `gemini-login.json` | Login-with-Gemini (Code Assist) OAuth token | mode `0600` |
| `projects/` | Per-project session transcripts | |
| `skills/`, `agents/`, … | Skills/agents/etc. | |

When `RAYU_CONFIG_DIR` is set, all config files live inside that directory
instead of the default `~/.rayu`.

## `providers.json` schema

```json
{
  "activeProvider": "nvidia",
  "subagent": { "providerId": "nvidia", "model": "meta/llama-3.3-70b-instruct" },
  "subagentByAgent": { "backend": { "providerId": "deepseek", "model": "deepseek-chat" } },
  "imageModel": "imagen-4.0-generate-001",
  "videoModel": "veo-3.1-generate-001",
  "projectProfile": "default",
  "providers": [
    {
      "id": "nvidia",
      "kind": "openai-compatible",
      "apiKey": "nvapi-xxxxx",
      "baseURL": "https://integrate.api.nvidia.com/v1",
      "defaultModel": "meta/llama-3.3-70b-instruct",
      "smallFastModel": "nvidia/llama-3.1-nemotron-nano-8b-v1",
      "models": ["my/custom-model"],
      "fetchedModels": ["...catalog from /v1/models..."],
      "contextWindow": 131072,
      "modelContextWindows": { "deepseek-ai/deepseek-v4-flash": 1000000 }
    },
    { "id": "anthropic", "kind": "anthropic", "apiKey": "sk-ant-xxxxx" },
    { "id": "bedrock", "kind": "bedrock", "bedrockApi": "converse", "apiKey": "aws-xxxxx", "awsRegion": "us-east-1" },
    { "id": "gemini-vertex", "kind": "vertex", "gcpProject": "my-project", "gcpRegion": "global" },
    { "id": "kiro", "kind": "kiro", "kiroAuthType": "oauth" }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `activeProvider` | id of the provider currently in use |
| `kind` | `anthropic`, `openai-compatible`, `bedrock`, `vertex`, `genai`, `kiro`, `copilot`, or `rayu-hosted` |
| `apiKey` | provider API key (secret) |
| `baseURL` | endpoint base (openai-compatible) |
| `defaultModel` | model used until you switch / fallback |
| `smallFastModel` | model for cheap requests (titles, etc.); defaults to `defaultModel` |
| `models` | user-pinned model ids (shown in `/model`) |
| `fetchedModels` | cached catalog from `GET {baseURL}/models` |
| `contextWindow` | provider-wide context default (tokens) |
| `modelContextWindows` | per-model context overrides (tokens) |
| `awsRegion` | AWS region for Bedrock (default `us-east-1`) |
| `bedrockApi` | `converse`, `openai`, or `anthropic` for Bedrock presets |
| `gcpProject` | GCP project id for Vertex AI |
| `gcpRegion` | GCP region for Vertex AI (default `global`) |
| `kiroAuthType` | `apikey` or `oauth` for Kiro providers |

You can edit this file by hand; restart Rayu to pick up changes.

## Environment variables

### Config & providers
| Variable | Effect |
|----------|--------|
| `RAYU_CONFIG_DIR` | Override config home dir |
| `RAYU_OPENAI_COMPATIBLE=1` | Force the OpenAI-compatible client path |
| `RAYU_OPENAI_BASE_URL` | Base URL for the OpenAI-compatible endpoint |
| `RAYU_OPENAI_API_KEY` | API key for the OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | Anthropic API key (auto-imported) |
| `NVIDIA_API_KEY` | NVIDIA NIM (auto-imported) |
| `DEEPSEEK_API_KEY` | DeepSeek (auto-imported) |
| `DOUBLE_WORD_API_KEY` / `DOUBLEWORD_API_KEY` | Doubleword (auto-imported) |
| `ZAI_API_KEY` / `ZHIPUAI_API_KEY` / `GLM_API_KEY` | GLM — Z.ai (auto-imported) |
| `MINIMAX_API_KEY` | MiniMax (auto-imported) |
| `KIMI_API_KEY` / `MOONSHOT_API_KEY` | Kimi / Moonshot (auto-imported) |
| `KIMI_FOR_CODE_API_KEY` | Kimi for Code (auto-imported) |
| `SAKANA_API_KEY` | Fugu — Sakana AI (auto-imported) |
| `OPENAI_API_KEY` | OpenAI (auto-imported) |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Gemini API key (auto-imported) |
| `OPENROUTER_API_KEY` | OpenRouter (auto-imported) |
| `XAI_API_KEY` | xAI / Grok (auto-imported) |
| `GROQ_API_KEY` | Groq (auto-imported) |
| `FIREWORKS_API_KEY` | Fireworks AI (auto-imported) |
| `TOGETHER_API_KEY` / `TOGETHERAI_API_KEY` | Together AI (auto-imported) |
| `CEREBRAS_API_KEY` | Cerebras (auto-imported) |
| `BASETEN_API_KEY` | Baseten (auto-imported) |
| `DEEPINFRA_API_KEY` | DeepInfra (auto-imported) |
| `HF_TOKEN` / `HUGGINGFACE_API_KEY` / `HUGGING_FACE_HUB_TOKEN` | Hugging Face (auto-imported) |
| `KIRO_API_KEY` | Kiro (auto-imported) |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS Bedrock bearer token (auto-imported into `bedrock` preset) |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS region for Bedrock (default `us-east-1`) |
| `OLLAMA_HOST` | Override Ollama server address (bare port, `host:port`, or full URL) |

### Models & context
| Variable | Effect |
|----------|--------|
| `RAYU_CONTEXT_TOKENS` | Force the context window (tokens) for the active model |
| `ANTHROPIC_MODEL` | Default model id (Anthropic-style precedence) |
| `ANTHROPIC_SMALL_FAST_MODEL` | Override the small/fast model |

### Diagnostics & privacy
| Variable | Effect |
|----------|--------|
| `RAYU_DIAGNOSTICS=1` | Also echo diagnostics to stderr |
| `RAYU_DIAGNOSTICS_NO_FILE=1` | Don't persist diagnostics to disk |
| `RAYU_TELEMETRY=1` | Opt back into telemetry (off by default) |
| `DISABLE_TELEMETRY` | Force telemetry off (`no-telemetry`) |

See [Diagnostics & Privacy](./09-diagnostics-privacy.md) for the privacy model.

## Project settings & memory

Rayu reads project files when present:

- `RAYU.md`, `.rayu/RAYU.md`, `.rayu/rules/*.md` — project memory/instructions.
- `.rayu/settings.json`, `.rayu/settings.local.json` — project/local settings.
- `.mcp.json` — project MCP servers.

Next: [CLI Reference →](./06-cli-reference.md)
