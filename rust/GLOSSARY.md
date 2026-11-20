# GLOSSARY

The original's domain terms, what they mean here, and the name used in the Rust
port. Add a row when a unit introduces a term; never let two units name the same
thing differently.

| Term | Meaning | Rust name |
|---|---|---|
| Rayu | The CLI product (`@rayu-dev/rayu-cli`), binary `rayu` | `rayu` (crate/app) |
| Rayucode | The VS Code extension built from the same engine; out of scope | — (TS) |
| engine | Everything under `rayu/src/` except `src/vscode/`: tools, commands, services, state, utils | the whole Rust app |
| unit | One directory/module cluster from `analyze` (415 total) | `rust/<unit>` crate |
| wave | Port order group in the analyze plan (0–4); a unit only depends on earlier waves | `MAP.md` ordering |
| front door | The Rust binary that owns argv and falls back to the original | `rust/app` |
| fallback rate | Share of recorded cases the original still answers through the front door | `app replay` metric |
| kill switch | `RUST_ANYTHING_UNIT_<NAME>=original` env var that sends one unit back to the original until the lift | same name in `rust/app` |
| keep unit | A unit the analyzer recommends leaving in the source language (UI/editor) | ported anyway per ADR-003, VS Code excepted |
| tool | A model-invocable action extending `Tool` in `src/Tool.ts` (48 built in) | `Tool` trait, `tools::*` |
| slash command | A user-typed `/name` command from `getCommands()` (~94) | `Command` trait, `commands::*` |
| session | One interactive or `--print` run with a conversation state | `Session` |
| transcript | The message history sent to the provider | `Transcript` |
| provider | A model vendor: anthropic, openai-compatible, bedrock, azure, vertex, genai, kiro, copilot, rayu-hosted, custom | `ProviderKind` |
| wire format | What goes over the socket: `anthropic-messages`, `openai-chat`, `openai-responses`, `genai`, `codewhisperer` | `WireFormat` |
| Anthropic IR | The internal request shape every provider translates from | `ir::Request` |
| routed id | `providerId\0model` prefix selecting a provider per request | `RoutedModel` |
| rayu-hosted | Requests proxied through `rayu-gateway-rust` under the user's plan | `ProviderKind::RayuHosted` |
| entitlement | Plan limits/features fetched from rayu-backend | `Entitlements` |
| credit | Billing unit reserved before and settled after a request | `Credit` |
| stream-json | NDJSON protocol used by `--print --output-format stream-json` and the VS Code engine | `stream_json` |
| plan mode | Read-only project mode that may write only the plan file | `PermissionMode::Plan` |
| orchestrator | Multi-agent coordination mode (main thread + workers) | `orchestrator` |
| external agent | Another agentic CLI (Codex, Claude Code, OpenCode, ACP) driven as a plugin | `external_agents` |
| web bridge | Outbound link from a session to rayu-backend for rayu-studio remote control | `web_bridge` |
| telegram bridge | Mobile/remote access through a Telegram bot | `telegram` |
| MCP | Model Context Protocol servers/tools/resources | `mcp` (rmcp) |
| skill | A bundled/external `SKILL.md` procedure invokable as `/name` | `skills` |
| worktree | A git worktree used for isolated edits | `worktree` |
| Ink renderer | The custom React reconciler at `src/ink/` (not npm ink) | `tui::render` |
| case | One recorded behavior: argv/stdin/env/files in; stdout/stderr/exit/files out | trycmd case in `rust/app-cases/` |
| gate | Definition of done for a unit: fmt, clippy, tests, no unsafe, recorded cases match | `rust-anything gate` |
| lift | Final step that deletes fallbacks and kill switches once every unit is Rust | `app lift` |
