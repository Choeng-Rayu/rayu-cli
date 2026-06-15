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
| `providers.json` | Rayu providers: id, kind, apiKey, baseURL, default/fetched models, context overrides | mode `0600` (secrets) |
| `settings.json` | User settings, incl. the selected `model` | |
| `diagnostics.jsonl` | Recorded bugs/issues/vulnerabilities | append-only JSONL |
| `projects/` | Per-project session transcripts | |
| `skills/`, `agents/`, … | Skills/agents/etc. | |

When `RAYU_CONFIG_DIR` is set, all config files live inside that directory
instead of the default `~/.rayu`.

## `providers.json` schema

```json
{
  "activeProvider": "nvidia",
  "providers": [
    {
      "id": "nvidia",
      "kind": "openai-compatible",
      "apiKey": "nvapi-xxxxx",
      "baseURL": "https://integrate.api.nvidia.com/v1",
      "defaultModel": "meta/llama-3.3-70b-instruct",
      "smallFastModel": "meta/llama-3.3-70b-instruct",
      "models": ["my/custom-model"],
      "fetchedModels": ["...catalog from /v1/models..."],
      "contextWindow": 131072,
      "modelContextWindows": { "deepseek-ai/deepseek-v4-flash": 1000000 }
    },
    { "id": "anthropic", "kind": "anthropic", "apiKey": "sk-ant-xxxxx" }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `activeProvider` | id of the provider currently in use |
| `kind` | `anthropic` or `openai-compatible` |
| `apiKey` | provider API key (secret) |
| `baseURL` | endpoint base (openai-compatible) |
| `defaultModel` | model used until you switch / fallback |
| `smallFastModel` | model for cheap requests (titles, etc.); defaults to `defaultModel` |
| `models` | user-pinned model ids (shown in `/model`) |
| `fetchedModels` | cached catalog from `GET {baseURL}/models` |
| `contextWindow` | provider-wide context default (tokens) |
| `modelContextWindows` | per-model context overrides (tokens) |

You can edit this file by hand; restart Rayu to pick up changes.

## Environment variables

### Config & providers
| Variable | Effect |
|----------|--------|
| `RAYU_CONFIG_DIR` | Override config home dir |
| `RAYU_OPENAI_COMPATIBLE=1` | Force the OpenAI-compatible client path |
| `RAYU_OPENAI_BASE_URL` | Base URL for the OpenAI-compatible endpoint |
| `RAYU_OPENAI_API_KEY` | API key for the OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `NVIDIA_API_KEY`, `DEEPSEEK_API_KEY`, `KIMI_FOR_CODE_API_KEY`, `DOUBLE_WORD_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | Auto-imported into `providers.json` on startup |

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
