# 7. Slash Commands

Slash commands run **inside an interactive session**. Type `/` to open the command menu; start typing to filter. Press Enter to run.

---

## 🔑 Rayu Provider & Model Configuration

| Command | Description |
|:---|:---|
| `/connect` | Connect a provider: pick type → enter API key → choose a model. See [Providers](./03-providers.md). |
| `/model` | Searchable model picker across all connected providers. `/model <id>` sets a model directly. See [Models](./04-models.md). |
| `/model-subagent` | Set a default model specifically for spawned subagents and helper tasks. |
| `/model-image-generation` | Choose which model is used for image generation (NVIDIA Flux vs Vertex Imagen). |
| `/model-video-generation` | Choose which model is used for video generation (Fal.ai, NVIDIA, or Vertex Veo). |
| `/effort` | Set the active model's reasoning/effort level: `low`, `medium`, `high`, or `max`. |

---

## 🎨 Creative & Media Generation

Rayu-CLI includes first-class media generation commands powered by NVIDIA, Fal.ai, and Vertex.

| Command | Description |
|:---|:---|
| `/generate-image <prompt>` | Generate a high-quality PNG image from a text description. Displays inline in supported terminals and saves to disk. |
| `/image-editor <prompt>` | Edit an existing image. Prompts you for the image file path, then applies modifications. |
| `/image-video <prompt>` | Generate a short high-quality MP4 video from a text description. |

---

## 🤖 Advanced Swarm & Task Management

| Command | Description |
|:---|:---|
| `/collaborator-swarm` | Launch a coordinate swarm of multiple subagents to solve a complex multi-step task. |
| `/ultraplan-local` | Build a localized, highly detailed implementation blueprint before writing code. |
| `/ultrareview-local` | Trigger a thorough local-code verification sweep against coding standards and requirements. |
| `/tasks` | View, add, or update task checkpoints in the ongoing conversation to keep track of progress. |
| `/agents` | List, details, and configure custom agents. |
| `/skills` | Display, manage, or reload installed Rayu skills. |
| `/install-skill` | Install an external skill from a GitHub repo, local directory, or URL. |

---

## 📲 Telegram Bot Integration

Rayu-CLI can be linked directly to Telegram, allowing you to interface with your running coding sessions on the go.

| Command | Description |
|:---|:---|
| `/telegram-bot` | Connect and initialize a Telegram bot instance to manage and query Rayu remotely. |
| `/disconnect-telegram` | Terminate the active Telegram bot connection and unregister credentials. |

---

## 📈 Stats, Diagnostics & Performance

| Command | Description |
|:---|:---|
| `/insights` | Generate a detailed markdown report analyzing your cumulative Rayu sessions and activity metrics. |
| `/stats` | Display real-time token usage, billing rates, and performance statistics. |
| `/cost` | Show token usage and cumulative session costs. |
| `/context` | Display an interactive visualization of your active context window usage. |
| `/doctor` | Run an in-depth environment health check (Node, Bun, Git, file permissions, APIs). |
| `/heap-dump` | Take a V8 heap snapshot of the running session to troubleshoot memory leaks. |

---

## ⚙️ Interactive TUI Adjustments

| Command | Description |
|:---|:---|
| `/theme` | Open a dialog to change the color theme of the TUI interface. |
| `/color` | Change the display color of the AI agent messages. |
| `/vim` | Toggle Vim mode keybindings for editing your input prompts in the chat. |
| `/statusline` | Toggle the bottom status bar on or off. |
| `/btw` | Add a quick, brief note or bookmark to the session history. |
| `/undo` | Attempt to revert the last filesystem change or Git action. |
| `/rewind` | Rewind conversation turns to a previous checkpoint. |

---

## 📂 Session & Conversation Control

| Command | Description |
|:---|:---|
| `/help` | List all available slash commands. |
| `/compact` | Summarize and compress past turns in the conversation to save context window tokens. |
| `/clear` | Start a fresh conversation (also `/reset`, `/new`). |
| `/export` | Export the current conversation transcript to a file. |
| `/copy` | Copy the last model response to your system clipboard. |
| `/resume` | Search and resume previous terminal sessions. |
| `/exit` | Safely quit Rayu-CLI. |

---

## 🧠 Memory & Workspace Management

| Command | Description |
|:---|:---|
| `/memory` | Manage, edit, or create workspace instructions (`RAYU.md`, `RAYU.local.md`, etc.). |
| `/files` | List all files currently tracked or indexed in the active workspace. |
| `/add-dir <path>` | Allow Rayu tool access to additional directories outside the project root. |
| `/permissions` | View and edit temporary and saved filesystem and execution permissions. |
| `/hooks` | Configure pre-tool, post-tool, and lifecycle hooks in your settings. |
| `/plan` | Toggle **Plan Mode** to draft changes and view blueprints without executing them. |

---

## Notes

* **Authoritative List:** The exact set of commands available in your session is subject to active plugins and features. Type `/help` to see what is loaded on your system.
* **Typing Shortcut:** When typing commands, typing the `/` key activates the autocomplete filter instantly.

Next: [MCP →](./08-mcp.md)
