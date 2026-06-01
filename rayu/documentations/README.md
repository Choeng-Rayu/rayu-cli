# Rayu-CLI Documentation

Rayu-CLI is a terminal-based AI coding agent. It is a self-branded, multi-provider
fork of the Claude Code CLI that lets you **bring your own API key** and use
**any OpenAI-compatible provider** (NVIDIA, DeepSeek, Kimi/Moonshot, Doubleword,
OpenAI, OpenRouter, local servers) as well as Anthropic — with free model
switching, MCP support, and the full built-in tool suite.

> Educational/research. Not affiliated with or endorsed.

## Documentation map

| # | Document | What's inside |
|---|----------|---------------|
| 1 | [Installation](./01-installation.md) | Requirements, build, the `rayu` binary |
| 2 | [Quickstart](./02-quickstart.md) | First run, your first conversation |
| 3 | [Providers](./03-providers.md) | Connecting providers, `/connect`, API keys, `.env` import |
| 4 | [Models](./04-models.md) | Searchable `/model` picker, context windows |
| 5 | [Configuration](./05-configuration.md) | Config directories, files, all environment variables |
| 6 | [CLI Reference](./06-cli-reference.md) | Commands, flags, interactive vs print mode |
| 7 | [Slash Commands](./07-slash-commands.md) | In-session commands (`/connect`, `/model`, …) |
| 8 | [MCP](./08-mcp.md) | Model Context Protocol server management |
| 9 | [Diagnostics & Privacy](./09-diagnostics-privacy.md) | Bug/issue logging, telemetry, network posture |
| 10 | [Troubleshooting](./10-troubleshooting.md) | Common errors and fixes |
| 11 | [Building binaries](./11-binaries.md) | Cross-platform standalone executables, versioning, install |
| 12 | [Image Generation](./12-image-generation.md) | Built-in `GenerateImage` tool (NVIDIA), save/inline/terminal display |

## 30-second tour

```bash
# build
cd claude-code && export PATH="$HOME/.bun/bin:$PATH"
bun install && bun run build

# run (interactive) — on first launch, pick a provider + paste your API key
node dist/rayu.js

# or headless, against NVIDIA
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
node dist/rayu.js --print --model meta/llama-3.3-70b-instruct "summarize this repo"
```

In a session:
- `/connect` — add a provider (pick type → enter key → choose a model)
- `/model` — searchable model picker across all connected providers
- `/help` — list all slash commands

## Key concepts

- **Provider** — an API endpoint + key. Two kinds: `anthropic` (Anthropic API)
  and `openai-compatible` (everything else, via an OpenAI ↔ Anthropic translation layer).
- **Config home** — `~/.rayu` by default; an existing `~/.claude` (Claude Code)
  is used automatically if `~/.rayu` is absent. See [Configuration](./05-configuration.md).
- **Diagnostics** — runtime bugs/issues/vulnerabilities are logged to
  `~/.rayu/diagnostics.jsonl`. See [Diagnostics](./09-diagnostics-privacy.md).
