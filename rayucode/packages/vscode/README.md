# rayucode

A Visual Studio Code extension that surfaces the existing Rayu CLI agent inside
the editor. rayucode does **not** reimplement the agent — it spawns the existing
`rayu` binary in headless streaming mode and drives it over the binary's
bidirectional newline-delimited JSON (NDJSON) control protocol, rendering the
agent's output and routing tool/permission decisions back to you.

## Features

- **Agent panel** — a webview that streams the agent's responses, renders
  Markdown with fenced code blocks, and shows file-edit proposals as per-file
  diffs.
- **Permission control** — tool actions (including the exact bash command) are
  surfaced for approval, with selectable permission modes.
- **Workspace context** — optionally include the active file and selection in
  your prompt.
- **File edits** — apply the agent's proposed edits, with conflict detection
  against on-disk changes.
- **Session history** — conversation history is retained across panel
  close/reopen.

## Requirements

- The `rayu` CLI must be installed and available on your `PATH`, or its location
  set via the `rayucode.cliPath` setting.

## Commands

- `rayucode.openPanel` — Open the agent panel.
- `rayucode.addSelectionToPrompt` — Add the current selection to the prompt.

## Settings

- `rayucode.cliPath` — Explicit path to the `rayu` executable.
- `rayucode.includeActiveFile` — Include the active file path in prompt context.
- `rayucode.includeSelection` — Include the active selection in prompt context.
- `rayucode.permissionMode` — Initial permission mode for a new session.
- `rayucode.diagnosticLogging` — Log control-protocol traffic and lifecycle
  events to the rayucode output channel.
- `rayucode.unresponsiveTimeoutMs` — Milliseconds of no protocol activity before
  rayucode shows an unresponsive notice (0 disables).

## Architecture

rayucode is split into two layers so future editors can reuse the integration:

- `@rayucode/core` — editor-agnostic process lifecycle, NDJSON protocol, session
  state, and message streaming. Contains zero `vscode` imports.
- `rayucode` (this package) — the VS Code host: implements the `EditorAdapter`
  (panel, file edits, workspace queries, command registration, secret storage)
  using the `vscode` API.
