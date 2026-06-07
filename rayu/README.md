# Rayu CLI

Rayu CLI is a terminal-based AI coding agent. Bring your own API key and connect
to any provider — Anthropic, OpenAI, NVIDIA, DeepSeek, Kimi/Moonshot, OpenRouter,
local servers, or any OpenAI-compatible endpoint — with free model switching,
full MCP support, and a complete built-in tool suite.

> Educational / research use. Not affiliated with any AI provider.

---

## Installation

```bash
npm install -g @rayu-dev/rayu-cli
```

Then start:

```bash
rayu
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

---

## Uninstall

```bash
rayu uninstall
```

---

## Quick start

On first launch, Rayu will ask you to connect a provider and enter your API key.

```bash
rayu                      # start an interactive session
rayu "fix the bug in X"   # one-shot prompt, no interaction
rayu --help               # all CLI flags and subcommands
```

Inside a session:

| Command    | What it does                                      |
|------------|---------------------------------------------------|
| `/connect` | Add a provider (type → key → model)               |
| `/model`   | Searchable model picker across all providers      |
| `/help`    | List all slash commands                           |

---

## Providers

Rayu supports four provider types:

- **`anthropic`** — Anthropic API (`ANTHROPIC_API_KEY`)
- **`openai-compatible`** — Any OpenAI-style endpoint (NVIDIA, DeepSeek, Kimi, OpenRouter, Google Gemini API, Ollama, LM Studio, etc.)
- **`bedrock`** — AWS Bedrock API (`AWS_BEARER_TOKEN_BEDROCK` or default AWS credentials)
- **`vertex`** — Google Gemini on Vertex AI (Google OAuth / Application Default Credentials)

Google Gemini is available two ways: a **Gemini API key** (`GEMINI_API_KEY`, via the OpenAI-compatible endpoint) or **Vertex AI with OAuth/ADC** (project + region scoped). The Vertex credentials also power Imagen 4 image generation and Veo 3.1 video generation.

Example — NVIDIA NIM headless run:

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
rayu --print --model meta/llama-3.3-70b-instruct "summarize this repo"
```

---

## Configuration

Config is stored in `~/.rayu` by default.
All settings are preserved across updates and uninstalls.

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
| 12 | [Image Generation](./documentations/12-image-generation.md) | Built-in `GenerateImage` tool (NVIDIA), save/inline/terminal display |
| 13 | [Building binaries](./documentations/13-binaries.md) | Cross-platform standalone executables, versioning, install |

---

## Issues & feedback

https://github.com/Choeng-Rayu/rayu-cli/issues
