# RAYU.md

This file provides guidance to RAYU when working with code in this repository.

---

## Commands

```bash
bun install                        # install dependencies
bun run build                      # bundle → dist/rayu.js
bun run src/entrypoints/cli.tsx    # run from source (no bundle step)
node dist/rayu.js                  # run built CLI interactively
node dist/rayu.js --print "<msg>"  # non-interactive single prompt
bun run typecheck                  # tsc --noEmit
bun test                           # full test suite
bun run build:binaries             # cross-platform standalone executables
bun run build:packages             # .deb/.rpm Linux packages
```

Build emits `dist/rayu.js`. Config is stored at `~/.rayu/`, diagnostics at `~/.rayu/diagnostics.jsonl`.

---

## Architecture

### Entry point & startup flow

`src/entrypoints/cli.tsx` is the bootstrap. It handles `--version` with zero imports (no module loading), then lazy-loads everything else via dynamic `import()`. Fast-paths exist for:
- `--version` / `-v` — inline console.log, no imports
- `--dump-system-prompt` — ant-only, for prompt sensitivity evals
- `--daemon-worker=<kind>` — headless worker spawned by the daemon supervisor
- `remote-control` / `bridge` — serve local machine as a bridge environment
- `daemon` — long-running supervisor process
- `ps | logs | attach | kill` + `--bg` / `--background` — session management
- `new | list | reply` — template job commands
- `environment-runner` — headless BYOC runner
- `self-hosted-runner` — headless self-hosted runner
- `--worktree --tmux` — exec into tmux before loading full CLI
- `update` / `uninstall` — npm-based management
- `--bare` — set SIMPLE mode early

`src/main.tsx` is the full interactive session — it wires together the Ink TUI, Commander argument parsing, slash command dispatch, tool dispatch, AI queries, and all lifecycle hooks. The two files are intentionally split so fast-path exits never pay the cost of loading the full session.

Startup phases in `main.tsx`:
1. MDM raw read + keychain prefetch (parallel with module eval)
2. Commander argument parsing
3. Config loading + session setup (hooks, policy limits, GrowthBook)
4. Remote managed settings + plugin initialization
5. REPL launch — the Ink-based interactive loop

### Feature flags

`feature('FLAG_NAME')` is imported from `bun:bundle` and is **compile-time dead-code elimination**, not a runtime check. Disabled flags are removed from the bundle entirely. This is why many modules are conditionally `require()`-d at the top of files instead of imported — it's the DCE pattern for optional features. Feature flags are defined in `scripts/macroValues.ts` under `ENABLED_FEATURES`.

### AI query pipeline

`src/query.ts` is the low-level streaming API call loop — it handles message normalization, compact/summarization boundaries, tool use, abort signals, and streaming event emission. The `src/query/` directory holds sub-modules for config, deps, interrupt messages, stop hooks, token budgets, and transitions.

`src/QueryEngine.ts` is the stateful per-session engine that manages message history, tool use dispatch, context window tracking, compact cycles, and abort signal wiring.

**Provider adapters** handle API communication:
- **Anthropic** — Direct Anthropic SDK (`@anthropic-ai/sdk`). Uses native streaming and tool-use API.
- **AWS Bedrock** — AWS SDK v3 (`@aws-sdk/client-bedrock-runtime`). Uses InvokeModelWithResponseStream.
- **OpenAI-compatible** — Any OpenAI-style endpoint (NVIDIA NIM, DeepSeek, Kimi/Moonshot, OpenRouter, Google Gemini, Ollama, LM Studio, etc.). Uses the OpenAI SDK with custom base URLs.
- **Vertex AI (Google)** — Google Gemini API via `@google/genai` SDK. Supports Gemini models, Imagen 4 image generation, and Veo video generation with Google OAuth / ADC credentials.
- **Rayu-hosted** — Activated by `USE_RAYU_OAUTH=true`; routes through `rayu-gateway` instead of calling providers directly. Auth token lives at `~/.rayu/rayu-auth.json`.

### Terminal renderer (`src/ink/`)

This is a **custom terminal renderer**, not just the npm `ink` package. It implements React reconciler targeting a terminal output buffer:

- **`src/ink/screen.ts`** — Cells stored as two packed `Int32`s per cell in a single `ArrayBuffer` (zero GC allocation for a 200×120 terminal). A shared `CharPool` interns character strings. Style, hyperlink, and width are bit-packed into word1. A `damage: Rectangle` field tracks the changed region.
- **`src/ink/log-update.ts`** — `diffEach()` diffs two frames and emits the minimal ANSI patch sequence. Handles ghost-character cleanup when rows shrink.
- **`src/ink/frame.ts`** — `{screen, viewport, cursor}` snapshot passed between render frames.
- **`src/ink/dom.ts`** — DOM-like node tree for Ink components.
- **`src/ink/reconciler.ts`** — Custom React reconciler using `react-reconciler`.
- **`src/ink/renderer.ts`** — Layout → paint → output pipeline.
- **`src/ink/layout/`** — Yoga (Flexbox) layout engine binding.
- **`src/ink/termio/`** — ANSI parser, SGR, DCS, CSI, OSC tokenizers.
- **`src/ink/components/`** — Built-in Ink components (Box, Text, Button, etc.).
- **`src/ink/events/`** — Event system (keyboard, mouse, focus, resize).

### Command system (`src/commands/`)

Commands are registered in `src/commands/commands.ts` (imported as `getCommands()`). Each command is a `Command` type with a `type` field:
- `'local-jsx'` — ink-based interactive UI rendered inline (e.g., `/connect`, `/model`, `/help`)
- `'local'` — non-interactive handler (e.g., `/cost`, `/clear`, `/keep`)
- `'remote-jsx'` — JSX rendered on the leader for swarm/teammate sessions

There are ~70+ commands covering: connect, model, config, agent, bridge, brand, clear, commit, compact, context, cost, diff, doctor, effort, exit, export, fast, feedback, help, history, hooks, ide, install-skill, keep, keybindings, login, logout, mcp, memory, model-subagent, model-image-generation, model-video-generation, normal, output-style, passes, permissions, plan, plugin, pr-comments, rename, resume, settings, swarm, thinking, todo, update, version, voice, and more.

### Task system (`src/Task.ts`, `src/tasks/`)

Tasks are typed: `local_bash`, `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, `monitor_mcp`, `dream`. Each has a status lifecycle: `pending → running → completed/failed/killed`. `isTerminalTaskStatus()` guards against injecting messages into dead tasks. Task output streams to a disk file (`outputFile`); `outputOffset` tracks how much has been consumed. The task system supports background execution, parallelism, and per-task tool dispatch.

### Tool system (`src/tools/`)

Tools are registered in `src/tools.ts` via `getTools()`. The registry includes ~45+ tools, conditionally including ant-only or feature-gated ones. Key tools:

| Tool | Purpose |
|------|---------|
| `AgentTool` | Spawn sub-agents for parallel work |
| `BashTool` | Execute shell commands |
| `FileReadTool` | Read files |
| `FileEditTool` | Edit files (exact string replace) |
| `FileWriteTool` | Write/overwrite files |
| `GlobTool` | File pattern matching |
| `GrepTool` | Content search (ripgrep) |
| `WebFetchTool` | HTTP fetches |
| `WebSearchTool` | Web search |
| `ImageGenTool` | Image generation (NVIDIA/Imagen) |
| `VideoGenTool` | Video generation (NVIDIA Cosmos/Veo) |
| `NotebookEditTool` | Jupyter notebook editing |
| `SkillTool` | Execute installed skills |
| `MCPTool` | Call MCP server tools |
| `TaskCreate/TaskGet/TaskUpdate/TaskList/TaskStop` | Task management |
| `ToolSearchTool` | Search available deferred tools |
| `LSPTool` | Language server protocol queries |
| `AskUserQuestionTool` | Ask user for input |

### Skill system (`src/skills/`)

Skills are packaged procedures loaded from `~/.rayu/skills/` or bundled with the CLI (`src/skills/bundled/`). `bundledSkills.ts` registers built-in skills. `installSkill.ts` handles downloading and installing skills from sources (GitHub repos, URLs, local paths). Skills can expose tools via MCP or execute as in-process procedures.

### Context / system prompt

`src/context.ts` builds the system prompt. `getSystemContext()` and `getUserContext()` are memoized. Git status (branch, recent commits, diff) is injected via `getGitStatus()` with a 2000-char truncation limit. RAYU.md / AGENTS.md files from the repo are loaded by `src/utils/claudemd.js`.

### State management (`src/state/`)

`AppState.tsx` and `AppStateStore.ts` hold the global application state using Zustand-like stores with selectors. Key state includes: conversation messages, task states, tool permissions, UI state, and session metadata.

### Design system (`src/components/design-system/`)

A structured design token system with:
- `ThemeProvider.tsx` — React context for theme injection
- `ThemedBox.tsx` / `ThemedText.tsx` — styled primitives
- `color.ts` — color token definitions
- Components: `Dialog`, `Divider`, `FuzzyPicker`, `KeyboardShortcutHint`, `ListItem`, `Pane`, `ProgressBar`, `Tabs`, `Byline`, `StatusIcon`, `LoadingState`, `Ratchet`

### Theme system (`src/utils/theme.ts`)

Defines a comprehensive `Theme` type with ~80+ color tokens covering: brand colors, semantic colors (success, error, warning, merged), diff colors (added/removed/word-level), agent/sub-agent colors, UI chrome colors, TUI V2 colors (message backgrounds, selection, rate limit bars), fast mode colors, rainbow colors for keyword highlighting, and shimmer variants for animated effects.

### Upstream proxy (`src/upstreamproxy/`)

For CCR (Cloud Container Runtime) sessions: reads a session token from `/run/ccr/session_token`, sets up a CONNECT→WebSocket relay (`relay.ts`), exposes `HTTPS_PROXY` + `SSL_CERT_FILE` env vars for subprocesses. Fails open — a broken proxy never breaks the session.

### Swarm / Teammate mode (`src/utils/swarm/`)

Multi-agent orchestration supporting:
- Multiple pane backends: tmux (`TmuxBackend`), iTerm2 (`ITermBackend`), in-process (`InProcessBackend`)
- Teammate agent management with lifecycle, model assignment, and layout management
- Permission syncing between leader and teammates
- Reconnection handling
- In-process runner for lightweight sub-agents

### Bridge / Remote control (`src/bridge/`)

Two-way bridge enabling remote control of the local machine. Uses WebSocket transport with JWTs for auth. Supports polling-based config, session management, and work secrets.

### Voice mode (`src/voice/`)

Voice input support with speech-to-text streaming, keyword term detection, and voice mode toggling.

### Vim mode (`src/vim/`)

Vim-style keybindings for the prompt input: motions (h/j/k/l/w/b/0/$), operators (d/c/y), text objects (iw/ip/it), and visual mode transitions.

---

## Build system (`scripts/`)

| File | Purpose |
|------|---------|
| `build.ts` | Bun bundler config, `--define` macro injection, stub aliasing, external modules |
| `macroValues.ts` | Build-time macro values and `ENABLED_FEATURES` flags |
| `build-binaries.ts` | Cross-platform standalone exe compilation |
| `build-native.ts` | Native binary build |
| `build-packages.ts` | .deb/.rpm Linux package generation |
| `preload.ts` | Preload module for crash diagnostics |
| `preinstall.cjs` / `postinstall.cjs` | npm lifecycle scripts |
| `typecheck-baseline.ts` | TypeScript regression baseline management |
| `sync-rayu-skills.ts` | Sync bundled skills from source |

---

## Key files reference

| Path | Role |
|------|------|
| `src/entrypoints/cli.tsx` | Bootstrap, all fast-paths, lazy-loads main session |
| `src/main.tsx` | Full interactive session wiring (500+ lines) |
| `src/query.ts` | Streaming API call loop, message normalization, compact |
| `src/QueryEngine.ts` | Stateful per-session AI engine |
| `src/tools.ts` | Tool registry (~45+ tools, conditional includes) |
| `src/context.ts` | System prompt builder, git status injection |
| `src/ink/screen.ts` | Packed cell buffer + CharPool + frame diffing |
| `src/ink/log-update.ts` | ANSI diff patch emitter |
| `src/ink/renderer.ts` | React-to-terminal render pipeline |
| `src/ink/reconciler.ts` | Custom React reconciler |
| `src/commands/commands.ts` | Command registry (~70+ commands) |
| `src/Task.ts` | Core task type definitions |
| `src/utils/config.ts` | Config file I/O, feature flags, permissions |
| `src/utils/theme.ts` | Theme type with ~80+ color tokens |
| `src/services/mcp/` | MCP server management (config, client, auth, registry) |
| `src/skills/` | Skill loading, execution, bundling |
| `src/bridge/` | Remote bridge/control transport |
| `src/upstreamproxy/` | CCR proxy relay |
| `src/utils/swarm/` | Multi-agent orchestration |
| `scripts/build.ts` | Bun bundler config, macros, stubs |
| `scripts/macroValues.ts` | Feature flag definitions |
