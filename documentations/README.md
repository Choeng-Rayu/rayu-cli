# Rayu-CLI Documentation

> **Browse online:** https://rayucode.com/docs

Rayu-CLI is a terminal-based AI coding agent. It lets you **bring your own API key** and use
**any OpenAI-compatible provider** (NVIDIA, DeepSeek, Kimi/Moonshot, Doubleword,
OpenAI, OpenRouter, local servers) as well as Anthropic — with free model
switching, MCP support, and the full built-in tool suite.

> Educational/research. Not affiliated with or endorsed.

## Documentation map

| # | Document | What's inside |
|---|----------|---------------|
| 1 | [Installation](./01-installation.md) | The one-line installer, npm, packages, updating, uninstalling |
| 2 | [Quickstart](./02-quickstart.md) | First run, your first conversation |
| 3 | [Providers](./03-providers.md) | Connecting providers, `/connect`, API keys, `.env` import |
| 4 | [Models](./04-models.md) | Searchable `/model` picker, context windows |
| 5 | [Configuration](./05-configuration.md) | Config directories, files, all environment variables |
| 6 | [CLI Reference](./06-cli-reference.md) | Commands, flags, interactive vs print mode |
| 7 | [Slash Commands](./07-slash-commands.md) | In-session commands (`/connect`, `/model`, …) |
| 8 | [MCP](./08-mcp.md) | Model Context Protocol server management |
| 9 | [Diagnostics & Privacy](./09-diagnostics-privacy.md) | Bug/issue logging, telemetry, network posture |
| 10 | [Troubleshooting](./10-troubleshooting.md) | Common errors and fixes |
| 11 | [Codebase Knowledge Graph](./11-knowledge-graph.md) | Local indexing, querying, and tracing using `/graphify` |
| 12 | [Specialist Swarm](./12-specialist-swarm.md) | Orchestrating parallel specialist agents (`/collaborator_swarm`) |
| 13 | [Image Generation](./12-image-generation.md) | Built-in `GenerateImage` tool (NVIDIA), save/inline/terminal display |
| 14 | [Building binaries](./13-binaries.md) | Cross-platform standalone executables, versioning, install |
| 15 | [Telegram Bot](./15-telegram-bot.md) | Linking a Telegram bot to drive the CLI remotely |
| 16 | [Credits & limits](./credits-and-limits.md) | Plans, credits, per-model charges, and where each admin control is enforced |
| 17 | [Deploying on Coolify](./deploy-coolify.md) | Production runbook: env vars, domains, migrations, provider-key cutover, backups |
| 18 | [Endpoints & model fetch](./rayu-endpoints-and-model-fetch.md) | How Rayu discovers, filters, and refreshes models for both Auth and API key |
| 19 | [How to use Rayu API key](./how-to-use-rayu-api-key.md) | Step-by-step guide for using a Rayu API key in the CLI or your own code |

## 30-second tour

Install (nothing else required — not Node, not npm, not `sudo`):

```bash
curl -fsSL https://rayucode.com/install | bash     # macOS / Linux
```

```powershell
irm https://rayucode.com/install.ps1 | iex         # Windows
```

```bash
# run (interactive) — on first launch, pick a provider + paste your API key
rayu

# or headless, against NVIDIA
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
rayu --print --model meta/llama-3.3-70b-instruct "summarize this repo"
```

From source instead:

```bash
cd rayu && export PATH="$HOME/.bun/bin:$PATH"
bun install && bun run build
node dist/rayu.js
```

In a session:
- `/connect` — add a provider (pick type → enter key → choose a model)
- `/model` — searchable model picker across all connected providers
- `/help` — list all slash commands

## Key concepts

- **Provider** — an API endpoint + key. Two kinds: `anthropic` (Anthropic API)
  and `openai-compatible` (everything else, via an OpenAI ↔ Anthropic translation layer).
- **Config home** — `~/.rayu` by default. See [Configuration](./05-configuration.md).
- **Diagnostics** — runtime bugs/issues/vulnerabilities are logged to
  `~/.rayu/diagnostics.jsonl`. See [Diagnostics](./09-diagnostics-privacy.md).
