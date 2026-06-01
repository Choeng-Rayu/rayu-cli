# RAYU.md

This file provides guidance to **RAYU** (the Claude‑Code CLI) when working with code in this repository.

---

## 1️⃣ Common Development Commands

| Goal | Command | What it does |
|------|---------|--------------|
| **Install dependencies** | `bun install` | Installs all NPM/Bun packages defined in `package.json`. |
| **Build the CLI** | `bun run scripts/build.ts`  *(or `npm run build` / `bun run build`)* | Bundles the entry‑point `src/entrypoints/cli.tsx` with Bun, applies macro replacements, and emits `dist/rayu.js`. |
| **Run the CLI (interactive)** | `node dist/rayu.js` | Starts a TUI session; on first launch you’ll be prompted to add a provider and API key. |
| **Run the CLI (non‑interactive)** | `node dist/rayu.js --print "<prompt>"` | Executes a single prompt and prints the result, useful for scripting. |
| **Show version** | `node dist/rayu.js --version` | Prints the current Rayu version. |
| **Run the development server** | `bun run src/entrypoints/cli.tsx` | Starts the CLI directly from source (fast‑path, no bundling). |
| **Run type‑checking** | `bun run typecheck` *(or `npm run typecheck`)* | Executes `tsc --noEmit` to ensure TypeScript types are correct. |
| **Run the test suite** | `bun test` | Executes all Jest/Playwright tests under `test/` (full suite). |
| **Run a single test** | `bun test path/to/file.test.ts` | Runs only the specified test file. |
| **Run Playwright E2E tests** | `bun test:e2e` *(if defined) or `npx playwright test`* | Executes the Playwright end‑to‑end tests for critical user flows. |
| **Package binaries** | `bun run package` *(or `npm run package`)* | Builds the self‑contained binaries for the supported platforms (`dist/bin/*`). |
| **Start the daemon** | `node dist/rayu.js daemon start` | Launches the background supervisor process used for background tasks and workers. |
| **Update Rayu** | `node dist/rayu.js update` | Checks for a new version (no‑op in this fork). |
| **Show help** | `node dist/rayu.js --help` | Lists all CLI flags and sub‑commands. |

> **Tip:** For any command that modifies files (e.g., `npm run package`), Rayu will ask for confirmation unless you run with `--permission-mode acceptEdits` or `--dangerously-skip-permissions`.

---

## 2️⃣ High‑Level Architecture Overview

The repository follows a **modular, feature‑first** layout. Below is a concise map of the most important directories and entry points:

```
src/
├─ entrypoints/
│   └─ cli.tsx          ← Main CLI bootstrap (parses args, fast‑paths, then loads main())
├─ utils/
│   ├─ config.ts        ← Loads `~/.claude` / `~/.rayu` configs, env vars, feature gates
│   ├─ startupProfiler.ts ← Simple performance profiling for CLI stages
│   ├─ auth.ts          ← OAuth / Claude AIO token handling
│   ├─ earlyInput.ts   ← Captures piped stdin before full init
│   ├─ process.ts       ← Helper wrappers for graceful process exits
│   └─ sinks.ts         ← Initializes telemetry/log sinks
├─ main.tsx            ← Full interactive session (Ink UI, command handling)
├─ daemon/
│   ├─ main.ts          ← Supervisor that forks worker processes
│   └─ workerRegistry.ts← Registers and runs `--daemon-worker=<kind>` processes
├─ bridge/
│   ├─ bridgeMain.ts    ← Remote‑control bridge implementation
│   └─ bridgeEnabled.ts ← Feature‑gate for the bridge
├─ mcp/
│   └─ ...               ← Model‑Context‑Protocol server utilities
├─ environment-runner/
│   └─ main.ts          ← Headless BYOC runner for custom environments
├─ self‑hosted‑runner/
│   └─ main.ts          ← Runner for the Self‑Hosted Runner service
├─ cli/
│   └─ handlers/
│        └─ templateJobs.ts ← Handles `new`, `list`, `reply` template sub‑commands
├─ services/
│   └─ policyLimits/…   ← Rate‑limit and policy‑check services used by bridge/daemon
└─ ... (other feature folders)
```

### Key Runtime Flow

1. **CLI Startup (`cli.tsx`)** – parses flags, applies fast‑paths, loads config and feature flags.
2. **Feature‑Gate System** – reads GrowthBook experiments via `utils/config` and DCE‑removes disabled blocks.
3. **Main Interactive Loop (`main.tsx`)** – runs the Ink TUI, handles slash commands, and processes user prompts.
4. **Background Workers** (`daemon/workerRegistry.ts`) – spawned with `--daemon-worker=<kind>`; lightweight and skip config loading.
5. **Bridge / Remote‑Control** (`bridge/bridgeMain.ts`) – validates auth, policy limits, and version before starting.
6. **MCP Servers** (`mcp/…`) – implement the Model Context Protocol used by the `mcp` sub‑command.
7. **Extensibility Hooks** – defined in `~/.claude/settings.json` (Prettier, ESLint, TypeScript checks, console‑log audit).

---

## 3️⃣ Important Project Files & Docs

| File / Directory | Why it matters for RAYU |
|------------------|--------------------------|
| `documentations/01‑installation.md` | First‑time setup, `bun install` & `bun run build`. |
| `documentations/02‑quickstart.md`   | Shows the typical workflow (`/connect`, `/model`). |
| `documentations/06‑cli-reference.md`| Full flag list & sub‑command table (referenced by the CLI). |
| `documentations/07‑slash-commands.md`| In‑session commands (e.g., `/help`, `/model`, `/connect`). |
| `documentations/12‑image-generation.md`| Built‑in `GenerateImage` tool (NVIDIA): create/edit images, save to disk, inline + terminal display. |
| `src/tools/ImageGenTool/` | Implements the `GenerateImage` tool (NVIDIA genai image models, registered in `src/tools.ts`). |
| `RAYU.md` (this file) | Provides guidance for future RAYU instances. |
| `STARTING.md` | Explains the early‑input capture and profiling steps. |
| `scripts/build.ts` | The build script that bundles the CLI; contains stub aliasing and macro handling. |
| `src/utils/config.ts` | Central place for environment variables, feature flags, and permission‑mode handling. |
| `src/utils/startupProfiler.ts` | Tiny profiler used to emit timestamps for performance tracing. |
| `src/daemon/` | Provides background processing needed for `--daemon` and `--bg` features. |
| `src/bridge/` | Implements the remote‑control bridge used by the `bridge` sub‑command. |
| `src/mcp/` | Holds the MCP server implementation for multi‑model orchestration. |
| `src/cli/handlers/templateJobs.ts` | Handles the `new`, `list`, `reply` template jobs (fast‑path). |
| `src/services/policyLimits/` | Enforces organization‑wide rate limits before privileged actions. |

---

## 4️⃣ Recommended Hook Configuration (already present)

```json
{
  "hooks": {
    "PostToolUse": [
      {"matcher": "Write|Edit", "command": "pnpm prettier --write \"$FILE_PATH\""},
      {"matcher": "Write|Edit", "command": "pnpm eslint --fix \"$FILE_PATH\""},
      {"matcher": "Write|Edit", "command": "timeout 60 pnpm tsc --noEmit --pretty false --incremental --tsBuildInfoFile node_modules/.cache/tsc-hook.tsbuildinfo"}
    ],
    "PreToolUse": [
      {"matcher": "Write", "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);const c=i.tool_input?.content||'';const lines=c.split('\\n').length;if(lines>800){console.error('[Hook] BLOCKED: File exceeds 800 lines ('+lines+' lines)');process.exit(2)}console.log(d)})\""}
    ],
    "Stop": [{"command": "pnpm build", "description": "Verify the production build at session end"}]
  }
}
```

*These hooks run automatically when you edit files.*

---

## 5️⃣ Quick Reference for New Contributors

1. **Clone & Install**
   ```bash
   git clone <repo‑url>
   cd claude-code
   bun install
   ```
2. **Build & Run**
   ```bash
   bun run build      # creates dist/rayu.js
   node dist/rayu.js  # interactive session
   ```
3. **Run Tests**
   ```bash
   bun test               # full suite
   bun test src/utils/xyz.test.ts   # single test
   ```
4. **Add a Provider** – run `/connect` inside a session and paste your API key.
5. **Debug** – use `--debug` or `-d` for internal logs; `--permission-mode acceptEdits` to auto‑accept file edits.
6. **When Adding Files** – Prettier/ESLint hooks run automatically; run `bun run typecheck` to verify typings.

---

*End of RAYU.md*
