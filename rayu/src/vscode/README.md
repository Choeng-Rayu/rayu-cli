# Rayucode

**Rayucode** brings the full power of the **Rayu AI coding agent** into Visual Studio Code.

Powered by the same engine, tool platform, and slash commands as the Rayu CLI, Rayucode runs as a dedicated assistant in your sidebar, allowing you to build, debug, and review code changes seamlessly inside your editor.

---

## Features

- **Multi-Provider AI**: Use Claude (Anthropic), OpenAI, DeepSeek, Google Gemini, AWS Bedrock, or custom OpenAI-compatible models.
- **Interactive Review Card**: Review files changed by Rayu turn-by-turn with side-by-side git diffs, and keep or undo changes individually or in bulk.
- **Slash Commands & Palettes**: Type `/` to trigger the slash command palette (`/help`, `/compact`, `/cost`, `/model`, `/clear`, `/review`), and `@` to mention workspace files.
- **Permission Modes**: Control execution safety with one-click permission cycling (`Shift+Tab`) across Plan, Default, Accept Edits, and Full Access.
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

## Remote-SSH Limitation

Account sign-in via OAuth loopback requires an interactive local browser and is not currently supported in Remote-SSH sessions. For Remote-SSH workspaces, configure an API key via `/connect` in your remote terminal: Rayucode detects and loads shared credentials automatically.
