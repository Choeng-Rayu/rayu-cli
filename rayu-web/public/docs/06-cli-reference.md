# 6. CLI Reference

```
rayu [options] [prompt]
rayu <subcommand> [options]
```

- No subcommand + no `--print` → **interactive** session (TUI).
- `--print "..."` (or piped stdin) → **non-interactive** single run.
- A subcommand (e.g. `mcp`, `plugin`, `install`) runs that subcommand.

---

## Common options

| Flag | Description |
|------|-------------|
| `-p, --print` | Print response and exit (non-interactive). The workspace trust dialog is skipped in print mode — only use in trusted directories. |
| `--model <model>` | Model for this session. Provide an alias (`sonnet`, `opus`) or a full id (e.g. `claude-sonnet-4-6`). |
| `--fallback-model <model>` | Fallback when the main model is overloaded (`--print` only). |
| `--effort <level>` | Effort level: `low`, `medium`, `high`, `max`, `auto`. |
| `--output-format <fmt>` | `text` (default), `json`, or `stream-json` (`--print` only). |
| `--input-format <fmt>` | `text` (default) or `stream-json` (`--print` only). |
| `--json-schema <schema>` | Constrain output to a JSON schema (`--print` only). |
| `--max-turns <n>` | Maximum agentic turns before early exit (`--print` only). |
| `--max-budget-usd <amount>` | Cap spend for the run (`--print` only). |

## Session control

| Flag | Description |
|------|-------------|
| `-c, --continue` | Continue the most recent conversation in the current directory. |
| `-r, --resume [id\|term]` | Resume a session by ID or open the interactive picker (optional search term). |
| `--from-pr [pr\|term]` | Resume a session linked to a PR by number/URL, or open the picker. |
| `--fork-session` | When resuming, create a new session ID instead of reusing the original. |
| `--session-id <uuid>` | Use a specific session UUID. |
| `-n, --name <name>` | Set a display name for the session (shown in `/resume` and terminal title). |
| `--no-session-persistence` | Disable session persistence — sessions won't be saved or resumable (`--print` only). |

## Directories & context

| Flag | Description |
|------|-------------|
| `--add-dir <dirs...>` | Allow tool access to additional directories (space-separated). |
| `--system-prompt <prompt>` | Override the system prompt for this session. |
| `--append-system-prompt <prompt>` | Append text to the default system prompt. |
| `--settings <file-or-json>` | Load additional settings from a JSON file path or inline JSON string. |

## Agents & tools

| Flag | Description |
|------|-------------|
| `--agent <agent>` | Select an agent for this session (overrides the `agent` setting). |
| `--agents <json>` | Define custom agents as a JSON object, e.g. `'{"reviewer": {"prompt": "…"}}'`. |
| `--tools <tools...>` | Set available built-in tools. `""` disables all; `"default"` uses all; or specify names: `"Bash,Edit,Read"`. |
| `--allowed-tools <tools...>` | Comma or space-separated list of tool names to allow (e.g. `"Bash(git:*) Edit"`). Also `--allowedTools`. |
| `--disallowed-tools <tools...>` | Comma or space-separated list of tool names to deny. Also `--disallowedTools`. |
| `--betas <betas...>` | Beta headers to include in API requests (API key users only). |

## Permissions & safety

| Flag | Description |
|------|-------------|
| `--permission-mode <mode>` | One of `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`, `fullManage`. |
| `--dangerously-skip-permissions` | Bypass all permission checks. Use only in sandboxes with no sensitive data or internet. |
| `--allow-dangerously-skip-permissions` | Enable bypass permissions as an option without activating it by default. |

### Permission mode details

- `default` — asks before any tool that modifies files or executes commands.
- `acceptEdits` — auto-accept file edits; still asks before shell commands.
- `plan` — plan first, don't execute any tools.
- `dontAsk` — run tools without prompting (same as `bypassPermissions` for most tools).
- `bypassPermissions` — run everything without prompting. Sandbox/CI use only.
- `fullManage` — full tool management mode.

In non-interactive `--print` mode, `bypassPermissions` is often required for tool-using runs (no prompt to approve).

## MCP & plugins

| Flag | Description |
|------|-------------|
| `--mcp-config <configs...>` | Load MCP servers from JSON files or inline JSON strings (space-separated). |
| `--strict-mcp-config` | Only use MCP servers from `--mcp-config`; ignore all other MCP configurations. |
| `--plugin-dir <path>` | Load plugins from a directory for this session only. Repeatable: `--plugin-dir A --plugin-dir B`. |
| `--disable-slash-commands` | Disable all skills/slash commands for this session. |

## Worktree & IDE

| Flag | Description |
|------|-------------|
| `-w, --worktree [name]` | Create a new git worktree for this session (optionally specify a name). |
| `--tmux` | Create a tmux session for the worktree (requires `--worktree`). Add `--tmux=classic` for traditional tmux instead of iTerm2 panes. |
| `--ide` | Automatically connect to IDE on startup if exactly one valid IDE is available. |

## Debug & diagnostics

| Flag | Description |
|------|-------------|
| `-d, --debug [filter]` | Enable debug logging. Optional category filter, e.g. `"api,hooks"` or `"!1p,!file"`. |
| `--debug-file <path>` | Write debug logs to a specific file (implicitly enables debug mode). |
| `--verbose` | Override verbose mode setting from config. |
| `--bare` | Minimal mode: skip hooks, LSP, plugin sync, auto-memory, background prefetches, keychain reads, and RAYU.md auto-discovery. Sets `RAYU_SIMPLE=1`. |
| `-v, --version` | Print version. |
| `-h, --help` | Show help. |

Run `rayu --help` for the complete, current list.

> **Note on Rayu providers:** `--model` accepts any model id your active provider serves (e.g. `meta/llama-3.3-70b-instruct`). To pick the *provider*, use `/connect`, the saved `providers.json`, or the `RAYU_OPENAI_*` env vars (see [Providers](./03-providers.md)). Anthropic aliases (`sonnet`, `opus`, `haiku`) only apply to the Anthropic provider.

---

## Subcommands

| Command | Description |
|---------|-------------|
| `rayu mcp …` | Manage MCP servers — see [MCP](./08-mcp.md). |
| `rayu plugin …` | Manage plugins (install, uninstall, enable, disable, update, list). |
| `rayu agents` | List configured agents and their definitions. |
| `rayu install [target]` | Install Rayu native build. Target: `stable`, `latest`, or a specific version. Add `--force` to reinstall. |
| `rayu update` / `rayu upgrade` | Check for updates and upgrade. |
| `rayu uninstall` / `rayu remove` | Uninstall Rayu. |

### `rayu mcp` subcommands

| Command | Description |
|---------|-------------|
| `rayu mcp add <name> <command\|url> [args...]` | Add an MCP server. Transport defaults to `stdio`; use `-t http` or `-t sse` for remote servers. Options: `-s <scope>` (`local`/`user`/`project`), `-e KEY=val` (env vars), `-H "Header: val"` (headers), `--client-id` / `--client-secret` (OAuth). |
| `rayu mcp add-json <name> <json>` | Add an MCP server from a JSON string directly. Use `-s <scope>`. |
| `rayu mcp remove <name>` | Remove an MCP server. Use `-s <scope>` to target a specific scope. |
| `rayu mcp serve` | Start the Rayu MCP server (exposes Rayu as an MCP server itself). |

### `rayu plugin` subcommands

| Command | Description |
|---------|-------------|
| `rayu plugin list` | List installed plugins. Add `--json` for JSON output. |
| `rayu plugin install <plugin>` | Install a plugin from a configured marketplace. Use `-s <scope>`. |
| `rayu plugin uninstall <plugin>` | Uninstall a plugin. Aliases: `remove`, `rm`. |
| `rayu plugin enable <plugin>` | Enable a disabled plugin. |
| `rayu plugin disable [plugin]` | Disable a plugin. Use `-a` to disable all. |
| `rayu plugin update <plugin>` | Update a plugin to the latest version. |
| `rayu plugin marketplace add <source>` | Add a marketplace from a URL, path, or GitHub repo. |
| `rayu plugin marketplace list` | List all configured marketplaces. |

---

## Output formats (`--print`)

- `text` — plain text result (default).
- `json` — a single JSON result object with `result`, `usage`, `total_cost_usd`, `num_turns`, `session_id`, etc.
- `stream-json` — newline-delimited JSON events as they arrive. Pair with `--input-format stream-json` for streaming input. Add `--include-hook-events` to include hook lifecycle events in the stream.

```bash
rayu --print --output-format json "list the modules" | jq .result
rayu --print --output-format stream-json "summarize this repo"
```

---

## Exit codes

- `0` — success.
- `1` — error (e.g. API error, no input provided to `--print`, invalid args).

Next: [Slash Commands →](./07-slash-commands.md)
