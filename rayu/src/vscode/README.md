# Rayucode

**Rayucode** brings the full power of the **Rayu AI coding agent** into Visual Studio Code.

Powered by the same engine, tool platform, and slash commands as the Rayu CLI, Rayucode runs as a dedicated assistant in your sidebar, allowing you to build, debug, and review code changes seamlessly inside your editor.

---

## Features

- **Multi-Provider AI**: Use Claude (Anthropic), OpenAI, DeepSeek, Google Gemini, AWS Bedrock, or custom OpenAI-compatible models.
- **Interactive Review Card**: Review files changed by Rayu turn-by-turn with side-by-side git diffs, and keep or undo changes individually or in bulk.
- **Slash Commands & Palettes**: Type `/` to trigger the slash command palette (`/help`, `/compact`, `/cost`, `/model`, `/clear`, `/review`), and `@` to mention workspace files.
- **Permission Modes**: Control execution safety by cycling modes in the composer (Ask, Auto-edit, Plan, Full Manage, Orchestrator).
- **Context Usage**: Live context window tracking in the panel header.
- **MCP Server Integration**: Manage and reconnect Model Context Protocol servers directly from the extension.
- **Single Credential**: Shares configuration and credentials with the Rayu CLI (`~/.rayu/`).

---

## Getting Started

1. Install the Rayucode extension in VS Code.
2. Open the Rayucode icon in the Activity Bar.
3. Sign in to Rayu or connect with an API key (`/connect` in the terminal).
4. Start chatting and coding!

---

## How it runs

Rayucode ships the same engine the terminal CLI runs, in one of two forms:

- **Platform packages** (`rayucode-<version>-<platform>.vsix`) carry a compiled
  executable at `bin/rayucode-engine` (`.exe` on Windows), plus a bundled `rg`.
  This is the recommended install: it starts instantly and needs no Node.js.
- **The universal package** (`rayucode-<version>.vsix`) runs `engine.mjs` with the
  Node.js that ships inside VS Code. Use it only when no build exists for your platform.

To install a platform package by hand, download the matching `.vsix` and run
`code --install-extension rayucode-<version>-<platform>.vsix` (or use
**Extensions → … → Install from VSIX…**).

**Search** uses the bundled `rg` (`bin/rg`), so it does not depend on your `PATH`.

**Memory**: each conversation runs as its own engine process with a limit based on
this machine's RAM. If an engine reaches the limit it is stopped and replaced; the
next message continues the same conversation instead of losing it. Change the limit
with `rayucode.engine.maxMemoryMB`, or point at a different binary with
`rayucode.engine.path`. Both are machine-scoped, so a workspace cannot redirect them.

---

## Settings

The gear in the sidebar title bar (or **Rayucode: Open Settings** in the Command
Palette) opens the Settings tab, with four sections:

- **General** — settings **shared with the Rayu CLI** carry that badge and are saved
  to the files the terminal reads, through the engine, so both see the same value.
  Two rows are Rayucode-only and live in Rayucode's own profile: **permission mode**
  (which the chat also remembers) and **prompt suggestions** (off means no extra
  model request after a turn).
- **Account** — your profile, plan, credits, usage limits, this month's feature usage
  and your devices. Signing out here clears the same caches as `/logout` in the
  terminal; it keeps a configured API key.
- **Integrations** — connect **Telegram** (the shared Rayu bot by QR, or your own bot
  token), turn on **Studio Remote** to drive this window from
  `studio.rayucode.com/remote` (or pair it with a QR), and install Rayu's **GitHub
  Actions** workflows in the current repository.
- **About** — which engine, ripgrep and memory limit this window is using.

The command is also in the **Accounts** menu, and a signed-in account shows a
**credits** item in the status bar; click it to open Settings → Account.

---

## Remote-SSH Limitation

Account sign-in via OAuth loopback requires an interactive local browser and is not currently supported in Remote-SSH sessions. For Remote-SSH workspaces, configure an API key via `/connect` in your remote terminal: Rayucode detects and loads shared credentials automatically.

---

## Credits

Panel icons use [VS Code Codicons](https://github.com/microsoft/vscode-codicons),
Copyright (c) Microsoft Corporation, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The font and its licence
notice are bundled under `media/` (`codicon.ttf`, `codicon.css`, `codicon-NOTICE.txt`).
