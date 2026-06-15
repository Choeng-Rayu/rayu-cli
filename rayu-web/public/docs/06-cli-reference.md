# 6. CLI Reference

```
rayu [options] [command] [prompt]
```

- No command + no `--print` → **interactive** session (TUI).
- `--print "..."` (or piped stdin) → **non-interactive** single run.
- A `command` (e.g. `mcp`, `update`) runs that subcommand.

## Common options

| Flag | Description |
|------|-------------|
| `-p, --print` | Print response and exit (non-interactive) |
| `--model <model>` | Model for this session (id or Anthropic alias) |
| `--fallback-model <model>` | Fallback when the main model is overloaded (`--print` only) |
| `--output-format <fmt>` | `text` (default), `json`, or `stream-json` (with `--print`) |
| `--input-format <fmt>` | `text` (default) or `stream-json` (with `--print`) |
| `-c, --continue` | Continue the most recent conversation in this directory |
| `-r, --resume` | Resume a session (interactive picker or id) |
| `--session-id <uuid>` | Use a specific session id |
| `--fork-session` | On resume, start a new session id |
| `-n, --name <name>` | Set a display name for the session |
| `--add-dir <dirs...>` | Allow tool access to additional directories |
| `--agent <agent>` / `--agents <json>` | Select / define custom agents |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| `--allowedTools <tools...>` / `--disallowedTools <tools...>` | Allow/deny specific tools |
| `--dangerously-skip-permissions` | Bypass all permission checks (see warning below) |
| `--mcp-config <configs...>` | Load MCP servers from JSON files/strings |
| `--effort <level>` | Effort level: `low`, `medium`, `high`, `max` |
| `--max-budget-usd <amount>` | Cap spend for the run (`--print`) |
| `--json-schema <schema>` | Constrain output to a JSON schema |
| `-d, --debug [filter]` | Debug logging (optional category filter) |
| `--debug-file <path>` | Write debug logs to a file |
| `--bare` | Minimal mode (skip hooks/LSP/plugins/auto-memory/etc.) |
| `-v, --version` | Print version |
| `-h, --help` | Show help |

Run `rayu --help` for the complete, current list.

> **Note on Rayu providers:** `--model` accepts any model id your active
> provider serves (e.g. `meta/llama-3.3-70b-instruct`). To pick the *provider*,
> use `/connect`, the saved `providers.json`, or the `RAYU_OPENAI_*` env vars
> (see [Providers](./03-providers.md)). Anthropic aliases (`sonnet`, `opus`,
> `haiku`) only apply to the Anthropic provider.

## Subcommands

| Command | Description |
|---------|-------------|
| `rayu mcp …` | Manage MCP servers — see [MCP](./08-mcp.md) |
| `rayu doctor` | Environment/health check |
| `rayu update` / `upgrade` | Update check (inert in this fork) |
| `rayu agents` | Manage agents |
| `rayu auth` | Authentication management |
| `rayu plugin` / `plugins` | Manage plugins |

## Output formats (`--print`)

- `text` — plain text result (default).
- `json` — a single JSON result object with `result`, `usage`, `total_cost_usd`,
  `num_turns`, `session_id`, etc.
- `stream-json` — newline-delimited JSON events as they arrive (pair with
  `--input-format stream-json` for streaming input).

```bash
rayu --print --output-format json "list the modules" | jq .result
```

## Permission modes & safety

By default Rayu asks before running tools that modify files or execute commands.

- `--permission-mode acceptEdits` — auto-accept file edits.
- `--permission-mode plan` — plan first, don't execute.
- `--permission-mode bypassPermissions` (or `--dangerously-skip-permissions`) —
  **run everything without prompting.** Only use in a sandbox / disposable
  environment with no sensitive data or network access. In non-interactive
  `--print` mode this is often required for tool-using runs (there is no prompt
  to approve).

## Exit codes

- `0` — success.
- `1` — error (e.g. API error, no input provided to `--print`, invalid args).

Next: [Slash Commands →](./07-slash-commands.md)
