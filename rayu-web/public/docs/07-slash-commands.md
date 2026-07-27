# 7. Slash Commands

Slash commands run **inside an interactive session**. Type `/` to open the
command menu; start typing to filter. Press Enter to run.

> The exact set of commands depends on enabled features and plugins. `/help`
> is authoritative for your build. Type commands one keystroke at a time —
> pasting a whole command string can be treated as pasted text.

---

## Provider & model

| Command | Aliases | Description |
|---------|---------|-------------|
| `/connect` | — | Connect an LLM provider: pick provider, enter API key, choose a model. See [Providers](./03-providers.md). |
| `/model [model]` | — | Set the AI model (searchable picker across all connected providers). `/model <id>` sets directly. See [Models](./04-models.md). |
| `/collaborator_model [collaborator] [default\|show]` | — | Set the model for collaborators (frontend/backend/mobile/security/deploy). With no name, applies to all; default is inherit from the main agent. |
| `/model_subagent [AGENT] [default\|show]` | — | Set the model used by subagents (currently the main provider's instant model). |
| `/model_image_generation` | — | Set the image generation/editing model (default: NVIDIA). |
| `/model_video_generation` | — | Set the video generation model (default: NVIDIA/fal). |

---

## Session & context

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | — | Show help and available commands. |
| `/context` | — | Visualize current context usage as a colored grid. |
| `/compact [instructions for summarization]` | — | Clear conversation history but keep a summary in context. Optional: `/compact [instructions for summarization]`. |
| `/clear` | `reset`, `new` | Clear conversation history and free up context. |
| `/export [filename]` | — | Export the current conversation to a file or clipboard. |
| `/copy [N]` | — | Copy Rayu's last response to clipboard (or `/copy N` for the Nth-latest). |
| `/resume [conversation id or search term]` | `continue` | Resume a previous conversation. |
| `/rename [name]` | — | Rename the current conversation. |
| `/tag <tag-name>` | — | Toggle a searchable tag on the current session. |
| `/session` | `remote` | Show remote session URL and QR code. |
| `/branch [name]` | `fork` | Create a branch of the current conversation at this point. |
| `/rewind` | `checkpoint` | Restore the code and/or conversation to a previous point. |
| `/undo [file\|all]` | — | Undo pending Rayu file changes (use "all" to undo everything). |
| `/keep [file]` | — | Keep pending Rayu file changes. |
| `/exit` | `quit` | Exit the REPL. |

---

## Collaboration & planning

| Command | Aliases | Description |
|---------|---------|-------------|
| `/collaborator_swarm [task description]` | — | Enter collaborator_swarm mode: orchestrate a complex build via the 3-phase flow (scope & research → aligned plan → delegate to specialist collaborators). `/normal` exits. |
| `/normal` | — | Exit collaborator_swarm mode (return to normal mode). |
| `/ultraplan [task description]` | — | Deep multi-agent planning: explore in parallel, weigh approaches, produce a step-by-step plan for approval — runs locally on your provider. |
| `/ultrareview [PR number, or empty for current branch]` | — | Deep bug-hunt on your branch: parallel review subagents find and verify bugs — runs locally on your provider. |
| `/plan [open\|<description>]` | — | Enable plan mode or view the current session plan. |
| `/review` | — | Review a pull request. |
| `/security-review` | — | Complete a security review of the pending changes on the current branch. |
| `/pr-comments` | — | Get comments from a GitHub pull request. |

---

## Configuration & tools

| Command | Aliases | Description |
|---------|---------|-------------|
| `/config` | `settings` | Open config panel. |
| `/theme` | — | Change the theme. |
| `/brandmark` | — | Customize Rayu's brand mark glyph and loading-spinner style. |
| `/color <color\|default>` | — | Set the prompt bar color for this session. |
| `/vim` | — | Toggle between Vim and Normal editing modes. |
| `/effort [low\|medium\|high\|max\|auto]` | — | Set effort level for model usage. |
| `/permissions` | `allowed-tools` | Manage allow & deny tool permission rules. |
| `/sandbox exclude "command pattern"` | — | Configure sandboxing for Bash tool execution (hidden when platform not supported). |
| `/statusline` | — | Set up RAYU's status line UI. |

---

## Files, memory & project

| Command | Aliases | Description |
|---------|---------|-------------|
| `/init` | — | Initialize a new RAYU.md file with codebase documentation. |
| `/memory` | — | Edit Rayu memory files. |
| `/files` | — | List all files currently in context. |
| `/diff` | — | View uncommitted changes and per-turn diffs. |
| `/review_detail [file]` | — | Show detailed pending Rayu file change diffs. |
| `/add-dir <path>` | — | Add a new working directory. |

---

## MCP, plugins & skills

| Command | Aliases | Description |
|---------|---------|-------------|
| `/mcp [enable\|disable [server-name]]` | — | Manage MCP servers (also available as the `rayu mcp` subcommand). |
| `/plugin` | `plugins`, `marketplace` | Manage RAYU plugins. |
| `/reload-plugins` | — | Activate pending plugin changes in the current session. |
| `/install-skill <github owner/repo \| url \| path> [--overwrite]` | — | Install a skill into Rayu from a GitHub repo, a SKILL.md URL, or a local path. |
| `/skills` | — | List available skills. |

---

## Account & usage (Rayu hosted)

| Command | Aliases | Description |
|---------|---------|-------------|
| `/login` | — | Sign in to your Rayu account (only when `USE_RAYU_OAUTH=true`). |
| `/logout` | — | Sign out of your Rayu account (only when `USE_RAYU_OAUTH=true`). |
| `/usage` | — | Show your Rayu plan + hosted-model usage (credits & tokens). |
| `/stats` | — | Show your RAYU usage statistics and activity. |
| `/insights` | — | Generate a report analyzing your RAYU sessions. |

---

## Background tasks & agents

| Command | Aliases | Description |
|---------|---------|-------------|
| `/tasks` | `bashes` | List and manage background tasks. |
| `/agents` | — | Manage agent configurations. |

---

## System & diagnostics

| Command | Aliases | Description |
|---------|---------|-------------|
| `/doctor` | — | Diagnose and verify your RAYU installation and settings. |
| `/status` | — | Show RAYU status including version, model, account, API connectivity, and tool statuses. |
| `/hooks` | — | View hook configurations for tool events. |
| `/keybindings` | — | Open or create your keybindings configuration file. |
| `/ide [open]` | — | Manage IDE integrations and show status. |
| `/terminal-setup` | — | Install Shift+Enter / Option+Enter key binding (hidden when the terminal already supports it natively). |

---

## Generative media

| Command | Aliases | Description |
|---------|---------|-------------|
| `/generate-image [prompt]` | — | Generate an image from a text prompt (NVIDIA / Vertex Imagen). Requires NVIDIA API key or Vertex AI. |
| `/image-editor [prompt]` | — | Edit an existing image with a text prompt (NVIDIA / Vertex Imagen). |
| `/image-video [prompt]` | — | Generate a video from a text prompt (fal.ai / NVIDIA / Vertex Veo). |

---

## Miscellaneous

| Command | Aliases | Description |
|---------|---------|-------------|
| `/btw <question>` | — | Ask a quick side question without interrupting the main conversation. |
| `/feedback [report]` | `bug` | Submit feedback about RAYU. |
| `/advisor [<model>\|off]` | — | Configure the advisor model. Pass a model id to set it, or `off` to disable. |
| `/contact_me` | — | Contact developer. |
| `/think-back` | — | Your 2025 RAYU Year in Review (feature-gated). |
| `/telegram-bot` | — | Link a Telegram bot to drive this CLI remotely (gated by `telegram` feature). |
| `/disconnect-telegram` | — | Unlink the Telegram bot from this CLI session. |

---

Next: [MCP →](./08-mcp.md)
