# Changelog

All notable changes to the Rayucode extension will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Rayucode uses [Semantic Versioning](https://semver.org/).

---

## [0.1.1] — 2026-09-07

### Fixed
- **First launch showed only "Model Loading…", and signing in appeared to do nothing.**
  Two causes. With no credentials the engine emits the sign-in refusal as its *first*
  frame and exits — it never sends `system/init`, and the model, command catalog and
  permission mode all arrive in that frame, so the panel had nothing to show. And
  signing in wrote the credential store but nothing restarted the engine, so the dead
  process stayed dead and the panel was unchanged. The panel now states whether you are
  signed in, shows your account name or email, offers a Sign in button, and restarts the
  engine once sign-in succeeds. The model button no longer claims to be "Loading…" when
  the real reason is that you are signed out.
- The active provider is now published from the shared config rather than only alongside
  a models response, so it is named even before the engine starts.
- **Permission prompts never appeared.** The engine was spawned without
  `--permission-prompt-tool`, so `getCanUseToolFn` took its "decide locally"
  branch and never sent a `can_use_tool` request. The panel reported that a tool
  needed permission while the user was never asked for one. The host now always
  passes `--permission-prompt-tool=stdio`.
- **Slash commands did nothing.** Headless mode filters every `local-jsx` command
  out of the registry (37 of 98 commands survive), so `/login`, `/model`,
  `/permissions`, `/plan` and `/mcp` reached an engine that had never heard of
  them and returned success with no output. The panel now serves these itself.
- **"Full manage" could not be selected.** Selecting it failed with "the session was
  not launched with --dangerously-skip-permissions". The engine computes
  `isBypassPermissionsModeAvailable` once at startup, so a session launched in
  `default` can never switch into a bypass-class mode — sending the request at all was
  the mistake. Choosing "Full manage" or "Bypass all prompts" now confirms, then
  relaunches the engine with `--permission-mode`, which satisfies the same gate without
  `--dangerously-skip-permissions` (that flag would force *every* session to start in
  full bypass). "Full manage" is now offered in the picker.
- **Deep-link sign-in was delivered to nothing.** The web sign-in page redirected
  to `vscode://rayu-dev.rayucode/auth`, but the extension publishes as
  `RayuCode.rayucode`, so the URI handler never fired and sign-in only recovered
  by falling back to the slower loopback flow — which is why login felt slow after
  a fresh install. A test now pins the authority against `package.json`.

### Added
- **Provider setup / BYOK.** "Add or switch AI provider" configures Anthropic,
  OpenAI, DeepSeek, OpenRouter, Groq or a local Ollama/LM Studio server, reachable
  from the provider badge in the input bar. Gated behind Rayu sign-in. Keys are
  written through the CLI's own `upsertProvider` into `~/.rayu/config.json`, so a
  provider added in the panel works immediately in `rayu` too. This is also why only
  one model appeared after a fresh install — there was no way to configure a second.
- **Plan approval.** `ExitPlanMode` requests now reach the panel and render as
  "Review the plan" instead of naming the tool.
- A command the engine cannot run is now refused with a list of what is available,
  rather than appearing to succeed while doing nothing.
- **`@`-mentions.** Typing `@` offers workspace files, ranked so a filename match
  beats a match deeper in the path.
- **Session history.** "Resume a previous session" lists past transcripts for the
  workspace and relaunches the engine with `--resume`.
- **Background tasks.** Long-running work now appears above the composer with a Stop
  button; previously it was invisible and could not be cancelled.
- **MCP servers can be added and removed** from the panel, not just reconnected and
  toggled.

### Changed
- The model selector and permission-mode control moved from the panel header into
  the input bar, where the prompt is actually composed.
- The model selector now shows the active provider, read from the same
  `~/.rayu/config.json` the CLI uses.

## [0.1.1] — 2026-09-07

### Changed

- License changed from `UNLICENSED` to **MIT**
- Publisher ID updated to `RayuCode`

### Added

- `CHANGELOG.md` — release history
- `PUBLISHING.md` — step-by-step guide for publishing future versions

---

## [0.1.0] — 2026-09-06

### Added

- **Agent Panel** — Activity Bar panel (`Rayucode: Open Agent Panel`) that runs a full Rayu session inside VS Code with the same engine as the CLI.
- **Multi-provider support** — Anthropic, OpenAI, DeepSeek, Gemini, and Ollama via Bring Your Own Key (BYOK). Never trained on your code.
- **Shared auth** — `Rayucode: Sign in to Rayu` writes to `~/.rayu/rayu-auth.json`, the same token file used by the `rayu` CLI. One account, one machine, one token.
- **Chat participant** — `@rayucode` in the VS Code Chat view with slash commands: `/explain`, `/fix`, `/review`, `/test`.
- **Editor context menu** — Explain, Fix, and Review selection actions wired to the right-click menu.
- **Session control** — `Start New Session` and `Interrupt Current Turn` commands in the command palette and panel toolbar.
- **Web Studio bridge** — `Connect to Rayu Web Studio` / `Disconnect` commands for remote session control.
- **Permission modes** — `default`, `acceptEdits`, `bypassPermissions`, `plan`, and `dontAsk` configurable via `rayucode.permissionMode` (machine-scoped for security).
- **Workspace containment** — File edits are restricted to the open workspace by default; opt out via `rayucode.allowEditsOutsideWorkspace` (machine-scoped).
- **Bundled engine** — `dist/rayu.js` v1.6.23 shipped inside the VSIX; version and sha256 are pinned in `build-info.json` and verified at activation.
- **Diagnostic logging** — `rayucode.diagnosticLogging` setting writes Control Protocol traffic to the Rayucode output channel.

[0.1.0]: https://github.com/rayu-dev/rayucode/releases/tag/v0.1.0
