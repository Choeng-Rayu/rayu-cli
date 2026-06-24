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
bun test test/renderGhost.test.ts  # single test file
```

Build emits `dist/rayu.js`. Config is stored at `~/.rayu/`, diagnostics at `~/.rayu/diagnostics.jsonl`.

---

## Architecture

### Startup flow

`src/entrypoints/cli.tsx` is the bootstrap. It handles `--version` with zero imports, then lazy-loads everything else. `src/main.tsx` is the full interactive session — it wires together the Ink TUI, slash commands, tool dispatch, and AI queries. The two files are intentionally split so fast-path exits (version, daemon workers, bridge) don't pay the cost of loading the full session.

### Feature flags

`feature('FLAG_NAME')` is imported from `bun:bundle` and is **compile-time dead-code elimination**, not a runtime check. Disabled flags are removed from the bundle entirely. This is why many modules are conditionally `require()`-d at the top of files instead of imported — it's the DCE pattern for optional features (e.g., `KAIROS`, `COORDINATOR_MODE`, `TEAMMEM`, `CCR_AUTO_CONNECT`).

### AI query pipeline

`src/query.ts` → `src/QueryEngine.ts`. `query.ts` is the lower-level streaming API call loop; `QueryEngine.ts` is the stateful per-session engine that manages message history, tool use, compact/summarization, and abort signals. Providers are adapters in `src/backend/`:
- `anthropic` — Anthropic SDK direct
- `bedrock` — AWS Bedrock SDK
- `openai-compatible` — any OpenAI-compatible endpoint (NVIDIA, DeepSeek, Kimi, etc.)
- `rayu-hosted` — activated by `USE_RAYU_OAUTH=true`; routes through `rayu-gateway` instead of calling providers directly. Auth token lives at `~/.rayu/rayu-auth.json`.

### Terminal renderer (`src/ink/`)

This is a **custom terminal renderer**, not just the npm `ink` package. The key innovation is `src/ink/screen.ts`: cells are stored as two packed `Int32`s per cell in a single `ArrayBuffer` (zero GC allocation for a 200×120 terminal). Style, hyperlink, and width are bit-packed into word1. `src/ink/log-update.ts` diffs frames using `diffEach()` and emits the minimal ANSI patch sequence. `src/ink/frame.ts` is the `{screen, viewport, cursor}` snapshot passed between render frames.

The `src/ink/screen.ts` `damage: Rectangle` field is critical — it scopes `diffEach` to only the region that changed. When a live row **shrinks**, trailing cells are blitted forward from the previous frame (byte-identical to prev) and fall outside `damage`. The `diffRowTrailingRemoved` function in `diffEach` specifically handles this "ghost characters" defect.

### Task system (`src/Task.ts`, `src/tasks/`)

Tasks are typed: `local_bash`, `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, `monitor_mcp`, `dream`. Each has a status lifecycle: `pending → running → completed/failed/killed`. `isTerminalTaskStatus()` guards against injecting messages into dead tasks. Task output streams to a disk file (`outputFile`); `outputOffset` tracks how much has been consumed.

### Context / system prompt

`src/context.ts` builds the system prompt. `getSystemContext()` and `getUserContext()` are memoized. Git status (branch, recent commits) is injected via `getGitStatus()`. RAYU.md / AGENTS.md files from the repo are loaded by `src/utils/claudemd.js`.

### Upstream proxy (`src/upstreamproxy/`)

For CCR (Cloud Container Runtime) sessions: reads a session token from `/run/ccr/session_token`, sets up a CONNECT→WebSocket relay, exposes `HTTPS_PROXY` / `SSL_CERT_FILE` for subprocesses. Fails open — a broken proxy never breaks the session.

### Key files to know

| Path | Role |
|------|------|
| `src/entrypoints/cli.tsx` | Bootstrap, fast-paths |
| `src/main.tsx` | Full interactive session |
| `src/QueryEngine.ts` | Stateful AI session (history, tools, compact) |
| `src/query.ts` | Streaming API call loop |
| `src/ink/screen.ts` | Packed cell buffer + frame diffing |
| `src/ink/log-update.ts` | ANSI patch emitter |
| `src/utils/config.ts` | Config file I/O, feature flag reads, permission modes |
| `src/tools.ts` | Tool registry (conditionally includes ant-only / feature-gated tools) |
| `scripts/build.ts` | Bun bundler config, macro replacements, stub aliasing |
| `test/renderGhost.test.ts` | Renderer ghost-character regression harness |
