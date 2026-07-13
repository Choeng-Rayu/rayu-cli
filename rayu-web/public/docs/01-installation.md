# 1. Installation

Install Rayu globally with npm:

```bash
npm install -g @rayu-dev/rayu-cli
rayu
```

Or run it instantly without installing:

```bash
npx @rayu-dev/rayu-cli
```

## Requirements

- **Node.js ≥ 18** (or Bun ≥ 1.3)
- A terminal — the interactive UI is a full-screen TUI
- Optional but recommended: `git` and `ripgrep` (`rg`) for full search/git features

## First launch

On first launch, Rayu walks you through a short setup:

1. **Theme** — pick a color theme.
2. **Provider setup** — choose a provider (Anthropic, NVIDIA, DeepSeek,
   Kimi/Moonshot, OpenAI, OpenRouter, Google Gemini, AWS Bedrock, or a local
   endpoint) and paste your **API key**. For local/custom endpoints you also
   enter a base URL and a default model.
3. **Trust** — confirm you trust the current working directory (Rayu can read,
   edit, and run files there).

Rayu then fetches the provider's model list and drops you into the chat REPL.
Your provider config is saved to `~/.rayu/providers.json` so future launches
skip setup.

> Already have keys in a `.env` file? Rayu auto-imports known keys on startup
> — see [Providers](./03-providers.md#auto-import-from-env).

## After install — your first conversation

Run `rayu` from any project directory, then type a prompt and press Enter:

```
> explain what this project does and list its main modules
```

Useful in-session commands (type `/` to see all):

| Command | Action |
|---------|--------|
| `/connect` | Add or switch to another provider (this is how auth works in Rayu) |
| `/model` | Search & switch model across all connected providers |
| `/help` | List all slash commands |
| `/config` | View/edit settings |
| `/context` | Show context-window usage |
| `/cost` | Show token usage / cost for the session |
| `/clear` | Start a fresh conversation |
| `/exit` | Quit |

Press `Esc` to cancel a running turn; `Ctrl+C` twice to exit.

## A note on `/login` and `/logout`

Rayu does **not** use OAuth login. The `/login` and `/logout` commands are
present but inert — running either prints a message redirecting you to
`/connect`. Provider credentials are managed with `/connect` (or by editing
`~/.rayu/providers.json` directly), not with a login flow.

## Headless / scripted use (print mode)

Run a single prompt and print the result (no TUI):

```bash
rayu --print "write a one-line summary of package.json"
```

JSON output for scripts:

```bash
rayu --print --output-format json "list top-level modules"
```

## Uninstall

```bash
npm uninstall -g @rayu-dev/rayu-cli
rm -rf ~/.rayu          # optional: remove config, providers, and session data
```

Next: [Quickstart →](./02-quickstart.md)