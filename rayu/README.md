# Rayu CLI

Rayu CLI is a terminal-based AI coding agent. Bring your own API key and connect
to any provider — Anthropic, OpenAI, NVIDIA, DeepSeek, Kimi/Moonshot, OpenRouter,
Google Gemini, AWS Bedrock, local servers, or any OpenAI-compatible endpoint —
with free model switching, full MCP support, and a complete built-in tool suite.

**Website:** https://rayucode.com  
**Docs:** https://rayucode.com/docs  
**Changelog:** https://rayucode.com/changelog

---

## Installation

```bash
npm install -g @rayu-dev/rayu-cli
```

Or run instantly without installing:

```bash
npx @rayu-dev/rayu-cli
```

Then start:

```bash
rayu
```

### Package managers

```bash
bun install -g @rayu-dev/rayu-cli
pnpm add -g @rayu-dev/rayu-cli
yarn global add @rayu-dev/rayu-cli
```

---

## Update

```bash
rayu update
```

Or reinstall the latest directly:

```bash
npm install -g @rayu-dev/rayu-cli
```

Prefer `rayu update`: it resolves the latest version once, installs that **exact**
version, and then verifies what actually landed on disk. A plain
`npm install -g @rayu-dev/rayu-cli@latest` resolves the mutable `latest` tag a
second time and can silently reinstall the version you already have when npm
serves cached registry metadata (packuments are cached for 5 minutes), which
looks like a successful update that changed nothing.

When a newer version is published, Rayu shows a one-line notice above the prompt
and in the welcome box at launch, with a link to
[the changelog](https://rayucode.com/changelog). Nothing is installed until you
run `rayu update` yourself.

### Automatic updates (opt-in)

Auto-updates are **off by default**. Rayu tells you an update exists but never
replaces your install behind your back. To turn them on, set `autoUpdates` in
`~/.rayu/config.json`:

```json
{
  "autoUpdates": true
}
```

To silence update checks and notices entirely:

```bash
export DISABLE_AUTOUPDATER=1
```

Two things to know before enabling automatic updates:

- **Node version.** Rayu requires **Node.js 18 or newer**. npm only *warns* when
  a package's `engines` requirement isn't met, so if a future release raises that
  floor, an automatic update could replace a working install with one that
  refuses to start until you upgrade Node. `rayu update` has the same
  constraint, but you choose when it happens.
- **Duplicate installs.** If Rayu is installed under two different npm prefixes
  (for example once with `sudo`, landing in `/usr/local`, and once without,
  landing in `~/.npm-global`), an update writes to whichever prefix npm is
  configured for — which may not be the copy your shell actually runs. The result
  is a "successful" update where `rayu --version` never changes. `rayu update`
  detects this and tells you which copy is shadowing which; the automatic updater
  does not. Run `which -a rayu` to check, and remove the copy you don't want.

---

## Uninstall

```bash
rayu uninstall
```

---

## Quick start

On first launch, Rayu will ask you to connect a provider and enter your API key.

```bash
rayu                      # start an interactive TUI session
rayu --print "fix the bug in X"   # one-shot prompt, non-interactive
rayu --help               # all CLI flags, subcommands, and options
```

### Interactive session

Inside a session, type `/` to see all slash commands:

| Command | What it does |
|---------|--------------|
| `/connect` | Add or switch providers (type → key → model) |
| `/model` | Search and switch models across all providers |
| `/model_subagent` | Set a separate model for sub-agents |
| `/help` | List all slash commands with descriptions |
| `/config` | View and edit configuration |
| `/brandmark` | Customize the brand glyph and spinner style |
| `/effort` | Set the effort level for responses |
| `/fast` | Toggle fast mode for quicker responses |
| `/plugin` | Manage plugins and browse the marketplace |
| `/mcp` | Manage MCP server connections |
| `/skill` | Manage and run installed skills |
| `/context` | Monitor context window usage and token count |
| `/cost` | Display cumulative token usage and costs |
| `/compact` | Manually compact conversation history |
| `/clear` | Clear conversation and start fresh |
| `/diff` | Review file changes made this session |
| `/plan` | Create and execute implementation plans |
| `/swarm` | Orchestrate multi-agent teams |
| `/memory` | View and manage persistent memory |
| `/think` | Toggle extended thinking mode |
| `/doctor` | Run diagnostics and health checks |
| `/exit` | Exit the session |

### Headless mode

For automation and CI/CD pipelines:

```bash
rayu --print --model meta/llama-3.3-70b-instruct "summarize this repo"
```

Pass credentials via environment variables (no saved config needed):

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
rayu --print "list top-level folders"
```

JSON output for pipelines:

```bash
rayu --print --output-format json "list top-level folders" | jq .result
```

---

## Providers

Rayu speaks **four wire formats**, so one provider entry can serve models that use
different protocols. Which format a request uses is decided per **model**, not per
provider:

| Provider | Models it serves | Wire format(s) | Auth |
|----------|------------------|----------------|------|
| **Anthropic** | Claude | Anthropic Messages | `ANTHROPIC_API_KEY` |
| **AWS Bedrock** | Claude **and** gpt-oss / qwen / deepseek / mistral / … | Anthropic Messages for Claude, OpenAI Chat for the rest | `AWS_BEARER_TOKEN_BEDROCK` (Bedrock API key) |
| **Microsoft Azure** | Claude **and** GPT deployments | Anthropic Messages for Claude, OpenAI Responses for the rest | `ANTHROPIC_FOUNDRY_API_KEY` / `AZURE_OPENAI_API_KEY` |
| **Google Vertex AI** | Gemini, Claude, **and** Llama / Mistral / Qwen (MaaS) | GenAI, Anthropic Messages, OpenAI Chat | Google OAuth / ADC |
| **OpenAI-compatible** | NVIDIA, DeepSeek, Kimi, OpenRouter, GLM, Ollama, LM Studio, … | OpenAI Chat | `RAYU_OPENAI_API_KEY` or per-provider key |
| **Anthropic-compatible** | LongCat, Ollama Cloud | Anthropic Messages | Bearer key |
| **GitHub Copilot** | Copilot models | OpenAI Chat | GitHub OAuth device flow |
| **Kiro** | Claude via AWS CodeWhisperer | CodeWhisperer event-stream | API key or `kiro-cli` login |
| **Rayu (hosted)** | Curated hosted models | Anthropic Messages | Your Rayu account (JWT) |
| **Custom** | Anything you declare | **you pick**: OpenAI Chat, OpenAI Responses, or Anthropic Messages | your key |

**Custom providers need no code change.** Run `/connect` → *Custom provider*, give
it a name, pick the API format its endpoint speaks, enter the base URL, the model
ids and your key. Declare whether it supports reasoning and images so Rayu never
sends a parameter your endpoint would reject.

**Google Gemini** is available three ways:
1. **Gemini API key** (`GEMINI_API_KEY`) via the OpenAI-compatible endpoint
2. **Vertex AI with OAuth/ADC** — project + region scoped
3. **Login with Gemini** — interactive Google sign-in, free, no GCP project

The Vertex/OAuth credentials also power **Imagen 4** image generation and **Veo 3.1** video generation.

Example — headless run with NVIDIA:

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
rayu --print --model meta/llama-3.3-70b-instruct "summarize this repo"
```

---

## Tools

Rayu ships with a comprehensive built-in tool suite:

| Category | Tools |
|----------|-------|
| **File ops** | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `NotebookEdit` |
| **Execution** | `Bash`, `PowerShell`, `Agent` (sub-agents) |
| **Web** | `WebFetch`, `WebSearch` |
| **Media** | `GenerateImage`, `GenerateVideo` |
| **MCP** | `MCPTool`, `ListMcpResources`, `ReadMcpResource` |
| **Tasks** | `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TaskStop`, `TaskOutput` |
| **Planning** | `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `Brief` |
| **Code** | `LSP` (language server queries), `Config`, `ToolSearch` |
| **Skills** | `SkillTool`, `InstallSkillTool` |
| **Communication** | `AskUserQuestion`, `SendMessage` (teammates) |
| **Todo** | `TodoWrite` |

---

## MCP (Model Context Protocol)

Rayu supports the Model Context Protocol for connecting to external tools and data sources:

```bash
# Configure MCP servers interactively
/mcp

# Or add an MCP server in settings
```

MCP servers are configured in `~/.rayu/settings.json` and can expose tools, resources,
and prompts to the AI agent during sessions.

---

## Skills

Rayu has a skill system for packaged, reusable procedures:

```bash
/install-skill <source>   # Install a skill from GitHub/URL/path
/skill <name> <args>      # Run an installed skill
```

Skills can be shared as GitHub repos and installed from URLs.

---

## Autonomous mode

Rayu supports running autonomously with automatic approval of operations:

```bash
rayu --print --permission-mode bypassPermissions "Refactor the project"
```

Permission modes: `default`, `bypassPermissions`, `acceptEdits`, `bypassReadonly`,
`bypassReadonlyAndApis`, and `planMode`.

---

## Configuration

Config is stored in `~/.rayu` by default. Key files:

| File | Purpose |
|------|---------|
| `~/.rayu/settings.json` | All user settings, themes, MCP configs |
| `~/.rayu/rayu-auth.json` | RAYU-hosted auth tokens |
| `~/.rayu/diagnostics.jsonl` | Runtime diagnostics log |
| `~/.rayu/sessions/` | Session transcripts and state |
| `~/.rayu/skills/` | Installed skills |

All settings are preserved across updates and uninstalls.

---

## Architecture overview

```
User input → Ink TUI (React renderer)
  → Slash command dispatch (/connect, /model, etc.)
  → Query engine (message history, context, tool dispatch)
  → Provider adapter (Anthropic/Bedrock/OpenAI/Vertex/Rayu-hosted)
  → Streaming response → Tool execution → Response rendered in TUI
```

The terminal UI uses a **custom React renderer** (`src/ink/`) built on `react-reconciler`
with efficient frame diffing — cells are packed as `Int32` pairs in an `ArrayBuffer`
for zero-GC rendering of 200×120 terminals.

---

## Documentation

| # | Document | Contents |
|---|----------|----------|
| 1 | [Installation](./documentations/01-installation.md) | Requirements, install, the `rayu` binary |
| 2 | [Quickstart](./documentations/02-quickstart.md) | First run, first conversation |
| 3 | [Providers](./documentations/03-providers.md) | Connecting providers, `/connect`, API keys |
| 4 | [Models](./documentations/04-models.md) | Model picker, context windows |
| 5 | [Configuration](./documentations/05-configuration.md) | Config files, environment variables |
| 6 | [CLI Reference](./documentations/06-cli-reference.md) | Commands, flags, interactive vs print mode |
| 7 | [Slash Commands](./documentations/07-slash-commands.md) | In-session commands |
| 8 | [MCP](./documentations/08-mcp.md) | Model Context Protocol server management |
| 9 | [Diagnostics & Privacy](./documentations/09-diagnostics-privacy.md) | Logging, telemetry, network posture |
| 10 | [Troubleshooting](./documentations/10-troubleshooting.md) | Common errors and fixes |
| 11 | [Codebase Knowledge Graph](./documentations/11-knowledge-graph.md) | Local indexing, querying, and tracing using `/graphify` |
| 12 | [Image & Video Generation](./documentations/12-image-generation.md) | Built-in media generation tools |
| 13 | [Building binaries](./documentations/13-binaries.md) | Cross-platform standalone executables |

---

## Issues & feedback

https://github.com/Choeng-Rayu/rayu-cli/issues

---

## Development

```bash
git clone https://github.com/Choeng-Rayu/rayu-cli.git
cd rayu-cli/rayu
bun install
bun run dev          # run from source
bun run build        # bundle to dist/rayu.js
bun test             # run tests
bun run typecheck    # TypeScript type checking
```

Built with [Bun](https://bun.sh), TypeScript, React/Ink, and a custom terminal renderer.
