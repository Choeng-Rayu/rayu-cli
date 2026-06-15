# 2. Quickstart

## First run (interactive)

```bash
rayu
```

On first launch you'll go through a short setup:

1. **Theme** — pick a color theme.
2. **Provider setup** — choose a provider (Anthropic, NVIDIA, DeepSeek,
   Kimi/Moonshot, Doubleword, OpenAI, OpenRouter, or a local endpoint) and paste
   your **API key**. For local/custom endpoints you also enter a base URL and a
   default model.
3. **Trust** — confirm you trust the current working directory (Rayu can read,
   edit, and run files there).

Rayu then fetches the provider's model list and drops you into the chat REPL.

> Already have your key in a `.env` file? Rayu auto-imports known keys on
> startup — see [Providers](./03-providers.md#auto-import-from-env).

## Your first conversation

Type a prompt and press Enter:

```
> explain what this project does and list its main modules
```

Useful in-session commands (type `/` to see all):

| Command | Action |
|---------|--------|
| `/connect` | Add or switch to another provider |
| `/model` | Search & switch model (across all connected providers) |
| `/help` | List all slash commands |
| `/context` | Show context-window usage |
| `/cost` | Show token usage / cost for the session |
| `/clear` | Start a fresh conversation |
| `/exit` | Quit |

Press `Esc` to cancel a running turn; `Ctrl+C` twice to exit.

## Headless / scripted use (print mode)

Run a single prompt and print the result (no TUI):

```bash
rayu --print "write a one-line summary of package.json"
```

With explicit provider + model (no saved config needed):

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
rayu --print --model meta/llama-3.3-70b-instruct "summarize this repo"
```

JSON output for scripts:

```bash
rayu --print --output-format json "list top-level modules"
```

Auto-approve tool use (sandboxes/CI only — see security note in
[CLI Reference](./06-cli-reference.md)):

```bash
rayu --print --permission-mode bypassPermissions "read README and summarize"
```

## Pick a *chat* model

When choosing a model, prefer instruction/chat models
(e.g. `meta/llama-3.3-70b-instruct`, `deepseek-chat`, `deepseek-ai/deepseek-v4-pro`).
Base/code/embedding/OCR models (`codegemma`, `*-embedding`, `*-ocr`, `starcoder`)
are not chat models and will return `404` on the chat endpoint. See
[Troubleshooting](./10-troubleshooting.md#api-error-404).

Next: [Providers →](./03-providers.md)
