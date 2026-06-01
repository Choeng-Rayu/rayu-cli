# 7. Slash Commands

Slash commands run **inside an interactive session**. Type `/` to open the
command menu; start typing to filter. Press Enter to run.

## Rayu provider/model commands

| Command | Description |
|---------|-------------|
| `/connect` | Add or switch a provider: pick type → enter API key → choose a model. See [Providers](./03-providers.md). |
| `/model` | Searchable model picker across all connected providers. `/model <id>` sets a model directly. See [Models](./04-models.md). |

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

## Configuration & tools

| Command | Description |
|---------|-------------|
| `/config` | View/edit settings |
| `/mcp` | Manage MCP servers (also available as the `rayu mcp` subcommand) |
| `/memory` | Edit project memory (CLAUDE.md) |
| `/agents` | Manage agents |
| `/hooks` | Configure hooks |
| `/effort` | Set effort level |
| `/diff` | Show pending diffs |
| `/doctor` | Run environment/health checks |
| `/theme` (via `/config`) | Change color theme |

## Notes

- The exact set of commands depends on enabled features and plugins; `/help` is
  authoritative for your build.
- Some upstream commands tied to inert features (login/OAuth, bridge/remote,
  desktop, IDE integrations) are present but non-functional in this fork — see
  [Troubleshooting](./10-troubleshooting.md).
- Tip: type slash commands one keystroke at a time; pasting a whole command at
  once can be treated as pasted text rather than triggering the command menu.

Next: [MCP →](./08-mcp.md)
