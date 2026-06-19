# 7. Slash Commands

Slash commands run **inside an interactive session**. Type `/` to open the
command menu; start typing to filter. Press Enter to run.

## Rayu provider/model commands

| Command | Description |
|---------|-------------|
| `/connect` | Add or switch a provider: pick type → enter API key → choose a model. See [Providers](./03-providers.md). |
| `/model` | Searchable model picker across all connected providers. `/model <id>` sets a model directly. See [Models](./04-models.md). |
| `/collaborator_model` | Pick the model used for collaborator agents during swarm builds. |
| `/model_subagent` | Pick the model used for one-shot subagents. |
| `/model_image_generation` | Pick the model used for image generation. |
| `/model_video_generation` | Pick the model used for video generation. |

## Session & context

| Command | Description |
|---------|-------------|
| `/help` | List all available slash commands |
| `/context` | Show context-window usage for the session |
| `/cost` | Show token usage and cost for the session |
| `/compact` | Summarize and compact the conversation to free context |
| `/clear` | Start a fresh conversation (also `/reset`, `/new`) |
| `/export` | Export the conversation |
| `/copy` | Copy the last response |
| `/resume` | Resume a previous session |
| `/exit` | Quit Rayu |

## Collaboration & planning

| Command | Description |
|---------|-------------|
| `/collaborator_swarm` | Enter collaborator swarm mode: orchestrate a complex build via the 3-phase flow (scope → plan → delegate). `/normal` exits. |
| `/ultraplan` | Deep multi-agent planning: explore in parallel, weigh approaches, produce a step-by-step plan for approval |
| `/ultrareview` | Deep bug-hunt on your branch: parallel review subagents find and verify bugs |

## Configuration & tools

| Command | Description |
|---------|-------------|
| `/config` | View/edit settings |
| `/mcp` | Manage MCP servers (also available as the `rayu mcp` subcommand) |
| `/memory` | Edit project memory (`RAYU.md`) |
| `/agents` | Manage agents |
| `/hooks` | Configure hooks |
| `/effort` | Set effort level |
| `/diff` | Show pending diffs |
| `/doctor` | Run environment/health checks |
| `/theme` (via `/config`) | Change color theme |
| `/brandmark` | Customize Rayu's brand mark glyph and loading-spinner style |
| `/telegram-bot` | Link a Telegram bot to drive this CLI remotely |
| `/disconnect-telegram` | Unlink the Telegram bot from this CLI session |

## Generative media

| Command | Description |
|---------|-------------|
| `/generate-image` | Generate an image from a text prompt (NVIDIA / Vertex Imagen) |
| `/image-editor` | Edit an existing image with a text prompt |
| `/image-video` | Generate a video from a text prompt (fal.ai / NVIDIA / Vertex Veo) |

## Notes

- The exact set of commands depends on enabled features and plugins; `/help` is
  authoritative for your build.
- Some upstream commands tied to inert features (login/OAuth, bridge/remote,
  desktop, IDE integrations) are present but non-functional in this fork — see
  [Troubleshooting](./10-troubleshooting.md).
- Tip: type slash commands one keystroke at a time; pasting a whole command at
  once can be treated as pasted text rather than triggering the command menu.

Next: [MCP →](./08-mcp.md)
