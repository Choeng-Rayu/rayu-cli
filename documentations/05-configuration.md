# 5. Configuration

## Config home directory

Rayu resolves a single **config home directory** used for settings, providers,
sessions, skills, projects, etc. Resolution order:

1. **`RAYU_CONFIG_DIR`** — explicit override (highest priority).
2. **`CLAUDE_CONFIG_DIR`** — legacy/Claude Code override.
3. **`~/.rayu`** — if it exists (Rayu's own config).
4. **`~/.claude`** — if it exists (an existing **Claude Code** install is used
   automatically).
5. **`~/.rayu`** — default for fresh installs.

This means **both `~/.rayu` and `~/.claude` layouts are supported**: a fresh
install uses `~/.rayu`; an existing Claude Code user (with `~/.claude`) works out
of the box. If both exist, `~/.rayu` is preferred. Force either with the env var:

```bash
CLAUDE_CONFIG_DIR=~/.claude rayu     # use the Claude Code config dir
RAYU_CONFIG_DIR=/tmp/rayu-test rayu  # isolated/throwaway config
```

> Note: this selects **one** active config home; it does not merge the two.

## Files & locations

Within the config home (e.g. `~/.rayu/`):

| Path | Purpose | Notes |
|------|---------|-------|
| `providers.json` | Rayu providers: id, kind, apiKey, baseURL, default/fetched models, context overrides | mode `0600` (secrets) |
| `settings.json` | User settings, incl. the selected `model` | shared schema with Claude Code |
| `diagnostics.jsonl` | Recorded bugs/issues/vulnerabilities | append-only JSONL |
| `projects/` | Per-project session transcripts | |
| `skills/`, `agents/`, … | Skills/agents/etc. | Claude Code-compatible layout |

At the home root (shared with Claude Code, **not** inside the config dir):

| Path | Purpose |
|------|---------|
| `~/.claude.json` | Global config incl. **MCP server list** (project-scoped entries) |

When `RAYU_CONFIG_DIR`/`CLAUDE_CONFIG_DIR` is set, the global `.claude.json`
lives inside that directory instead of the home root.

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
| `CLAUDE_CONFIG_DIR` | Legacy override for config home dir |
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
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Force `essential-traffic` (no nonessential network) |

See [Diagnostics & Privacy](./09-diagnostics-privacy.md) for the privacy model.

## Project settings & memory

Rayu reads project files when present:

- **`RAYU.md`** or **`AGENTS.md`** — project memory/instructions.
- **`.rayu/rules/*.md`** — conditional and unconditional instruction rules.
- **`.rayu/settings.json`** — shared project settings (permissions, model mappings, etc.).
- **`.rayu/settings.local.json`** — gitignored local settings (user override for this project).
- **`RAYU.local.md`** — private project memory/instructions (gitignored).
- **`.mcp.json`** — project MCP servers.

*Note: For backwards compatibility, the legacy files `CLAUDE.md`, `.agents/CLAUDE.md`, and `.agents/rules/*.md` are also loaded if present.*

Next: [CLI Reference →](./06-cli-reference.md)
