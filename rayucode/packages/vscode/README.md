# Rayucode for VS Code

The **Rayu AI coding agent**, inside your editor.

Rayucode does not reimplement the agent. It runs the real [`@rayu-dev/rayu-cli`](https://www.npmjs.com/package/@rayu-dev/rayu-cli)
binary in headless streaming mode and drives it over the CLI's bidirectional
NDJSON control protocol. Your models, providers, API keys, MCP servers, and
`~/.rayu` configuration are exactly the ones you already use in the terminal —
there is no second configuration to maintain, and no cloud round-trip that the
CLI would not have made itself.

- **Multi-provider, BYOK** — Anthropic, OpenAI, DeepSeek, Google Gemini, Kimi, and
  local models via Ollama / LM Studio.
- **Never trained on your code** — bring your own key, or use a zero-retention
  Rayu-hosted connection.
- **Secrets are redacted** before anything reaches the panel or the log channel.

## Features

### Agent panel in the Activity Bar

Click the Rayucode icon in the Activity Bar to open a persistent chat panel. It
streams responses as they are generated, renders Markdown with fenced code
blocks, and shows file-edit proposals as per-file diffs. Conversation history is
kept by the extension host, so it survives closing and reopening the panel.

### `@rayucode` in the chat view

Type `@rayucode` in VS Code's chat view to talk to the same agent from there,
including the slash commands `/explain`, `/fix`, `/review`, and `/test`. Attach
files or selections with `#file` and they are included in the prompt. Cancelling
the chat turn interrupts the agent.

The chat participant and the panel are independent sessions, so the two
conversations never interleave.

### Right-click actions

Select code and use the lightbulb or the editor context menu:

| Action | What it does |
|--------|--------------|
| **Rayucode: Explain selection** | Stages an explain request for the selection |
| **Rayucode: Fix selection** | Stages a bug-fix request |
| **Rayucode: Review selection** | Stages a code-review request |
| **Add Selection to Prompt** | Stages just the selection, with no framing |

Each action *stages* the prompt in the panel input rather than submitting it, so
you can add detail before spending a turn.

### Permission control

Every tool action is surfaced for approval before it runs — including the exact
bash command — and any still-pending request is denied automatically when the
session closes.

While a request is outstanding the agent is stopped, so the request is pinned in
a bar directly above the message box rather than left to scroll away in the
transcript. Approve or deny from there, or press **Review** to jump to the full
request — a diff for a file edit, the complete command for bash.

Change how much you approve up front from the picker in the panel header, which
takes effect immediately for the rest of the session:

| Mode | Behaviour |
|------|-----------|
| **Plan** | Read and analyse only. No file edits, no commands. |
| **Ask every time** | Prompt before each file edit and each command. The default. |
| **Auto-accept edits** | Apply file edits without asking; still prompt before commands. |
| **Bypass all prompts** | Run edits and commands with no prompt. Use only in a throwaway workspace. |

`rayucode.permissionMode` sets the mode each new session starts in. It is
machine-scoped, so a repository cannot choose its own — see
[Security](#security).

### File edits with conflict detection

The agent's proposed edits are applied through VS Code's own workspace edit API,
so they are undoable. A file that changed on disk since the proposal was
generated is reported as a conflict and left untouched until you confirm. A file
you already have open is updated in place and left unsaved for you to review;
other files are written to disk.

### Status bar

The status bar shows `$(sparkle) Rayu` when idle and `$(sync~spin) Rayu —
Generating` during a turn. Click it mid-turn to interrupt.

## Requirements

The Rayu CLI must be installed:

```bash
npm install -g @rayu-dev/rayu-cli
```

Rayucode resolves the executable in this order:

1. the `rayucode.cliPath` setting,
2. `rayu` on your `PATH`,
3. the npm global install (`npm prefix -g` / `npm root -g`),
4. `~/.bun/bin` or `~/.local/bin`.

Steps 3 and 4 matter because a GUI-launched VS Code often inherits a narrower
`PATH` than your shell. If the CLI still is not found, Rayucode offers a
one-click install that runs the command above in an integrated terminal.

On first run, connect a provider with `rayu` in a terminal — Rayucode uses the
same credentials.

## Commands

| Command | Title |
|---------|-------|
| `rayucode.openPanel` | Rayucode: Open Agent Panel |
| `rayucode.addSelectionToPrompt` | Rayucode: Add Selection to Prompt |
| `rayucode.interrupt` | Rayucode: Interrupt Current Turn |
| `rayucode.newSession` | Rayucode: Start New Session |
| `rayucode.explainSelection` | Rayucode: Explain Selection |
| `rayucode.fixSelection` | Rayucode: Fix Selection |
| `rayucode.reviewSelection` | Rayucode: Review Selection |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `rayucode.cliPath` | `""` | Explicit path to the `rayu` executable. Empty means auto-resolve. |
| `rayucode.includeActiveFile` | `false` | Include the active file path in prompt context. |
| `rayucode.includeSelection` | `false` | Include the active selection in prompt context. |
| `rayucode.permissionMode` | `default` | Mode each new session starts in: `default`, `acceptEdits`, `bypassPermissions`, `plan`, or `dontAsk`. Change it mid-session from the panel header. |
| `rayucode.allowEditsOutsideWorkspace` | `false` | Allow edits to read/write paths outside the open workspace folders. See Security. |
| `rayucode.diagnosticLogging` | `false` | Log control-protocol traffic and lifecycle events to the Rayucode output channel. |
| `rayucode.unresponsiveTimeoutMs` | `60000` | Milliseconds of protocol silence before an unresponsive notice. `0` disables. |

Files matched by `files.exclude` / `search.exclude` — and by your `.gitignore`
when the built-in Git extension is available — are never included in prompt
context.

## Security

**Edits are confined to your workspace.** The agent chooses the `file_path` for
every edit, and its output is influenced by whatever it reads — file contents,
tool output, fetched web pages. A prompt-injection attack could therefore aim an
edit at `~/.bashrc` or `~/.ssh/authorized_keys`, and under a permission mode that
auto-approves edits that would happen with no prompt. Rayucode refuses any edit
resolving outside the open workspace folders and reports it as a per-file failure.
Set `rayucode.allowEditsOutsideWorkspace` to `true` only if you need it.

**Credentials are redacted before display.** The agent inherits your environment
so the CLI can find its own configuration, which means a tool that runs `env`,
prints a stack trace, or reads a `.env` file can echo an API key back. Rayucode
recognises credential-shaped environment values and replaces every occurrence with
`[REDACTED]` in both the panel and the log channel, so a copied bug report does
not carry your keys.

**Every tool action is reviewable.** Approval prompts show the exact parameters —
and for shell actions the exact command — before anything runs. Any request still
pending when a session closes is denied automatically.

**The panel renders untrusted content safely.** Agent output is Markdown rendered
by an escape-first renderer that emits only a fixed tag subset and drops any link
scheme other than `http`, `https`, `mailto`, and `tel`. The webview runs under a
strict Content Security Policy (`default-src 'none'`, nonce-gated script, no
remote content).

## Troubleshooting

**"Rayu CLI was not found"** — Install it with `npm install -g @rayu-dev/rayu-cli`,
or set `rayucode.cliPath` to the executable's full path.

**No response from the agent** — Enable `rayucode.diagnosticLogging` and open the
**Rayucode** output channel (View → Output) to see the control-protocol traffic
and process lifecycle events.

**Authentication failed** — Connect your provider by running `rayu` in a
terminal, then retry.

**`@rayucode` is missing from chat** — The chat view requires VS Code 1.100 or
later. The Activity Bar panel works regardless.

## Architecture

Rayucode is split into two layers so other editors can reuse the integration:

- **`@rayucode/core`** — editor-agnostic process lifecycle, NDJSON codec, control
  protocol, permission coordination, edit proposals, redaction, and session
  state. Contains zero `vscode` imports.
- **`rayucode`** (this package) — the VS Code host. Implements the core's
  `EditorAdapter` interface (panel surfaces, workspace edits, workspace queries,
  command registration, secret storage) and contributes the Activity Bar view,
  status bar, chat participant, and code actions.

```
rayu/src ──bun build──► dist/rayu.js (@rayu-dev/rayu-cli)
                              │  spawn + stdin/stdout NDJSON
                        @rayucode/core
                              │  EditorAdapter
                        rayucode (VS Code)
```

## Links

- Website — <https://rayucode.com>
- Documentation — <https://rayucode.com/docs>
- Issues — <https://github.com/rayu-dev/rayucode/issues>
