# RAYU.md — RAYU CLI Agent Instructions

This file provides critical guidance to AI agents (including RAYU itself) when working with the CLI codebase. **READ THIS FILE FIRST before making ANY changes inside `rayu/`.**

---

## What is RAYU CLI?

**RAYU CLI** (`@rayu-dev/rayu-cli`) is a **terminal-based AI coding agent** — a multi-provider AI assistant that runs in your terminal, offering deep integration with your development workflow. It is published on npm as `@rayu-dev/rayu-cli`.

### What Makes RAYU Unique?

RAYU is a **universal AI coding assistant** that works with any AI provider:

- **A terminal UI wrapper** giving Claude Code-style interaction with ANY AI provider
- **A multi-provider CLI tool** with ~94 slash commands for development workflows
- **An extensible tool platform** with ~48 built-in tools (file operations, bash, web search, MCP integration, etc.)
- **A skill system** supporting both bundled and external skills
- **A Telegram bridge** allowing mobile/remote access via Telegram bot
- **Image/Video generation** built-in via AI models
- **Optional billing integration** with rayu-backend for centralized management

### Technical Snapshot

| Attribute | Value |
|-----------|-------|
| Language | TypeScript + Bun |
| UI Framework | Custom React/Ink (custom reconciler, NOT npm `ink`) |
| Source files | ~2027 across 60+ top-level `src/` directories |
| Provenance | ~96% derivative from Claude Code fork, ~4% original Rayu |
| State management | Zustand-like stores (`src/state/`) |
| Feature flags | Compile-time DCE via `feature('FLAG')` from `bun:bundle` |
| Commands | ~94 registered in `src/commands.ts` via `getCommands()` |
| Tools | ~48 registered in `src/tools.ts` via `getTools()` |
| Skills | 20+ bundled in `src/skills/bundled/` |
| Hooks | 84 React hooks in `src/hooks/` |
| Components | 145+ UI components in `src/components/` |
| Utilities | 354 files across 40+ subdirs in `src/utils/` |
| Constants | 22 files in `src/constants/` |
| Types | 15+ type definitions in `src/types/` |
| Keybindings | 15 files in `src/keybindings/` |
| Ink renderer | 50+ files in `src/ink/` (custom reconciler with packed Int32 buffers) |

### Provider Support

RAYU supports multiple AI providers through a common abstraction layer (`src/services/api/`):

- **Anthropic Claude** — native via `@anthropic-ai/sdk`
- **OpenAI** — adapter via `openai` SDK
- **Google Gemini** — adapter via `@google/genai`
- **AWS Bedrock** — adapter via `@aws-sdk/client-bedrock-runtime`
- **DeepSeek, Kimi, OpenRouter** — OpenAI-compatible adapter
- **Any OpenAI-compatible local server**

### How RAYU Differs from Claude Code

RAYU started as a Claude Code fork but has diverged significantly:

| Area | Claude Code (upstream) | RAYU CLI |
|------|----------------------|----------|
| Provider support | Anthropic only | Multi-provider (Anthropic, OpenAI, DeepSeek, Gemini, Bedrock, etc.) |
| Pricing model | Direct API key | Optional centralized billing via rayu-backend |
| Remote access | Desktop/Web only | Telegram bridge for mobile/remote access |
| Tool set | ~40 tools | ~48 tools (adds image/video generation, telegram, billing) |
| Deployment | Self-hosted | Self-hosted + optional cloud (rayu-backend) |
| Branding | Claude Code | RAYU (customizable brand glyph/mascot) |

**Critical: Do NOT assume Claude Code features work the same in RAYU. Always read the actual source code.**

---

## 🚨 CRITICAL RULES FOR AI AGENTS

### Rule 1: NO ASSUMPTIONS — Find Root Cause and Clarify

**NEVER assume how RAYU works based on general "AI agent" or "Claude Code" knowledge.** This codebase has significant modifications and is NOT a standard fork.

**If you guess, you WILL introduce bugs. If you assume, you WILL break existing functionality.**

**When you encounter something unclear:**
- ✅ **DO:** Read the actual source code, trace execution paths, verify behavior in the code
- ✅ **DO:** Clarify by reading file contents — don't assume from names or docstrings
- ✅ **DO:** Check `ORIGIN_MANIFEST.md` to understand which files are original vs derivative
- ✅ **DO:** Use Graphify to explore the codebase and discover relationships
- ✅ **DO:** Ask the user for clarification if the code is genuinely ambiguous after reading it
- ❌ **DON'T:** Guess behavior from "what it should be"
- ❌ **DON'T:** Assume upstream Claude Code features work the same here
- ❌ **DON'T:** Assume directory structure matches any template
- ❌ **DON'T:** Assume file names or function names tell you what they do — READ THE CODE
- ❌ **DON'T:** Assume APIs work like "typical" implementations — READ THE ACTUAL CODE

**Common wrong assumptions to AVOID:**
- "This config key works like upstream" → **READ** `src/utils/settings/settings.ts` and actual config handlers
- "This command behaves the same" → **READ** the command source in `src/commands/`
- "This tool has these parameters" → **READ** the tool definition in `src/tools/`
- "Feature flags are runtime checks" → **NO** — `feature('FLAG')` is **compile-time DCE**, removed from bundle entirely if disabled
- "The Ink renderer is standard npm ink" → **NO** — custom reconciler at `src/ink/reconciler.ts`
- "Permission system is simple" → **NO** — 20+ files with classifiers, shell rule matching, dangerous patterns, shadowed rule detection
- "State management uses React context" → **NO** — uses Zustand-like stores in `src/state/`
- "Directory structure follows convention" → **NO** — Rayu adds entire new directories: `src/telegram/`, `src/coordinator/`, `src/bridge/`, `src/buddy/`, `src/memdir/`, `src/assistant/`, `src/remote/`, etc.

**When in doubt: READ THE SOURCE CODE. It is the source of truth, not your training data.**

---

### Rule 2: PREVENT DUPLICATE CODE — Read Before You Write

**CRITICAL: Before adding ANY new function, component, command, tool, utility, or feature, you MUST verify it does not already exist.**

The codebase has **2027+ source files** across **60+ directories** — accidental duplication is EXTREMELY likely.

**You MUST search FIRST, code SECOND. Always. Every time. No exceptions.**

**Duplicate code is a BUG. Treat it as seriously as a security vulnerability.**

**When thinking about a new feature or addition:**

1. **Stop and search first** — use `Grep` and `Glob` to check if similar functionality exists
2. **Use Graphify FIRST** (see Rule 3) — it's faster than manual searching and discovers relationships you might miss
3. **Check ALL relevant locations:**
   - `src/commands/` — 94 commands exist; check `src/commands.ts` for registry
   - `src/tools/` — 48 tools exist; check `src/tools.ts` for registry
   - `src/utils/` — 354 files across 40+ subdirectories
   - `src/components/` — 145+ UI components
   - `src/services/` — API services, MCP, analytics, etc.
   - `src/skills/bundled/` — 20+ bundled skills
   - `src/hooks/` — 84 React hooks
   - `src/state/` — Zustand-like stores
   - `src/ink/` — terminal renderer (50+ files)
   - `src/constants/` — 22 files of constants
   - `src/types/` — 15+ type definitions
   - `src/keybindings/` — 15 files for keybinding system
   - `src/telegram/` — Telegram bridge components
   - `src/bridge/` — Bridge abstractions
   - `src/coordinator/` — Multi-agent coordination
   - `src/buddy/` — Buddy system
   - `src/memdir/` — Memory directory utilities
   - `src/assistant/` — Assistant helpers
   - `src/remote/` — Remote execution
   - And many more directories...

4. **Search BROADLY** — use multiple keywords and patterns; the same concept may exist under a different name or in a different module
5. **Reuse and extend** existing patterns rather than creating new ones
6. **Check for similar patterns** — even if the exact function doesn't exist, there may be a similar one to extend
7. **Check `ORIGIN_MANIFEST.md`** to understand which files are original Rayu vs derivative Claude Code
8. **When in doubt, use Graphify** (see Rule 3) to discover related code across the entire codebase

---

### Rule 3: USE GRAPHIFY FOR CODEBASE UNDERSTANDING

**Graphify is your FIRST tool, not your last resort.** It is a knowledge-graph tool that can:

- Build a knowledge graph of the codebase (nodes = code entities, edges = relationships)
- Discover code structure, dependencies, and relationships **10x faster** than manual searching
- Find whether functionality already exists before you write it
- Map dependencies across the entire codebase
- Identify related code you didn't know existed
- Trace execution paths through complex module interactions

**When to use Graphify (use it EARLY and OFTEN):**
- ✅ **Before writing any new code** — discover if something already exists
- ✅ **Before adding a new tool** — check if a similar tool exists
- ✅ **Before adding a new command** — check if a similar command exists
- ✅ **Before adding a utility function** — check if similar utilities exist
- ✅ When exploring an unfamiliar area of the codebase
- ✅ When understanding how components/modules relate to each other
- ✅ When debugging complex cross-module issues
- ✅ When you need to understand the dependency graph of a module
- ✅ When you're unsure where to put new code
- ✅ When you're trying to understand the provider architecture, tool registration, or command registration

**How to use Graphify:**
- **Invoke via:** `/graphify` or the Skill tool
- **Outputs go to:** `graphify-out/` directory (`graph.json`, `GRAPH_REPORT.md`)
- **Key commands:**
  - `--mode deep` — thorough extraction (use this for comprehensive analysis)
  - `--update` — incremental update
  - `--cluster-only` — recluster only (faster than full rebuild)
  - `--html` / `--svg` / `--graphml` / `--neo4j` — export formats
  - `--watch` — auto-rebuild for continuous development
  - `query` — BFS/DFS traversal to trace relationships

**Example Graphify workflow:**
```bash
# Before adding a new tool, check existing tools
/graphify --mode deep src/tools/

# Check the graph output in graphify-out/GRAPH_REPORT.md
# Search for similar tool names, dependencies, patterns

# If you find a similar tool, READ IT FIRST before writing new code

# Before adding a new command
/graphify --mode deep src/commands/

# Before adding a utility
/graphify --mode deep src/utils/
```

**If you write code without running Graphify first, you are almost certainly creating duplicate code.**

---

### Rule 4: Follow Project Conventions

- **TypeScript + Bun** — use ES modules, dynamic `import()` for lazy loading
- **Feature flags:** `feature('FLAG')` from `bun:bundle` is **COMPILE-TIME DCE**, not runtime. Do NOT convert to static `import` — it bloats the bundle
- **Commands:** Registered in `src/commands.ts` via `getCommands()`
- **Tools:** Registered in `src/tools.ts` via `getTools()`
- **Skills:** Defined in `src/skills/bundled/` with SKILL.md files
- **React/Ink:** For terminal UI (custom reconciler, not npm `ink`)
- **State management:** Zustand-like stores in `src/state/`
- **Theme system:** ~80+ color tokens in `src/utils/theme.ts`
- **Design system:** ThemedBox/ThemedText primitives in `src/components/design-system/`
- **Constants:** Always check `src/constants/` before hardcoding values
- **Types:** Always check `src/types/` before defining new types
- **Keybindings:** Check `src/keybindings/` before adding new keybindings

---

### Rule 5: Build & Test Commands

```bash
bun install              # install dependencies
bun run dev              # run from source (no bundle step)
bun run build            # bundle → dist/rayu.js
bun test                 # run tests (80%+ coverage required)
bun run typecheck        # tsc --noEmit
bun run build:binaries   # cross-platform standalone executables
bun run build:packages   # .deb/.rpm Linux packages
```

---

## RAYU Architecture Fundamentals

### Tool System

**Tools** are the building blocks of RAYU's capabilities. Every action the AI can perform goes through a tool.

- **Tool interface:** Defined in `src/Tool.ts`
- **Tool registry:** `src/tools.ts` exports `getTools()` which returns all available tools
- **Tool implementation pattern:** Each tool is a class extending the Tool interface
- **Tool categories:**
  - **File operations:** Read, Write, Edit, Glob, Grep
  - **Execution:** Bash, REPL (Ant-only)
  - **Web:** WebFetch, WebSearch
  - **AI:** Agent, Skill, InstallSkill
  - **Task management:** TaskCreate, TaskUpdate, TaskGet, TaskList, TaskStop, TaskOutput
  - **Plan mode:** EnterPlanMode, ExitPlanModeV2
  - **Worktree:** EnterWorktree, ExitWorktree
  - **MCP:** ListMcpResources, ReadMcpResource, ToolSearch
  - **Config:** Config, AskUserQuestion
  - **Media:** ImageGen, VideoGen
  - **Notifications:** Brief, PushNotification (feature-gated)
  - **Scheduling:** CronCreate, CronDelete, CronList (feature-gated)
  - **Team:** TeamCreate, TeamDelete, SendMessage (lazy-loaded)
  - **Testing:** TestingPermission (testing only)

**Adding a new tool:**
- Create a new class in `src/tools/YourToolName/YourToolName.ts`
- Extend the Tool interface
- Implement required methods: `name`, `description`, `inputSchema`, `execute()`
- Register in `src/tools.ts` by importing and adding to the tools array
- Use `ImageGenTool` as a reference pattern (simple and well-structured)

### Command System

**Commands** are slash commands users can type in the interactive session.

- **Command interface:** Defined in `src/commands.ts`
- **Command registry:** `src/commands.ts` exports `getCommands()` which returns all available commands
- **Command types:** `'interactive'` (shows UI), `'non-interactive'` (executes immediately), `'jsx'` (renders JSX component)

**Adding a new command:**
- Create a new directory in `src/commands/yourCommandName/`
- Create `index.ts` with command definition
- Export command object with `name`, `description`, `type`, `action`
- Register in `src/commands.ts` by importing and adding to the commands array

### Provider Architecture

Providers abstract different AI APIs into a common interface (`src/services/api/`):

- `src/services/api/claude.ts` — Anthropic Claude adapter
- `src/services/api/openai.ts` — OpenAI adapter (also used for DeepSeek, Kimi, OpenRouter)
- `src/services/api/gemini.ts` — Google Gemini adapter
- `src/services/api/bedrock.ts` — AWS Bedrock adapter

### State Management

Zustand-like stores in `src/state/`:
- `src/state/AppState.ts` — main store, exports `useAppState()` hook
- Key slices: Messages, Tools, Commands, Permissions, MCP, Settings, Skills, Tasks, Telegram

### Terminal Rendering (Ink)

**CUSTOM React reconciler** at `src/ink/reconciler.ts` — NOT standard npm `ink`:
- Packed Int32 buffers for performance
- Custom ANSI parser
- Yoga layout engine
- Custom component primitives

### Telegram Bridge

For mobile/remote access. The default bot is whatever `RAYU_SHARED_BOT_TOKEN`
points at on rayu-backend (the CLI asks `/telegram/bot` for its `@username`);
users can instead supply their own @BotFather token:
- `src/commands/telegram-bot/` — Telegram bot command
- `src/telegram/` — Telegram message handlers
- `src/bridge/` — Bridge abstractions

### Billing Integration (Optional)

Integrates with rayu-backend for centralized billing:
- `src/services/rayuAuth/` — Auth and entitlement services
- `src/commands/billing/` — Billing commands
- **This is OPTIONAL** — RAYU can run fully offline with direct API keys

---

## Key File Map

| Path | Purpose |
|------|---------|
| `src/entrypoints/cli.tsx` | Bootstrap, fast-paths, lazy-loads main session |
| `src/main.tsx` | Full interactive session wiring (500+ lines) |
| `src/query.ts` | Streaming API call loop, message normalization, compact |
| `src/QueryEngine.ts` | Stateful per-session AI engine |
| `src/tools.ts` | Tool registry (~48 tools) |
| `src/commands.ts` | Command registry (~94 commands) |
| `src/Tool.ts` | Tool interface and base types |
| `src/ink/` | Custom terminal renderer (50+ files) |
| `src/utils/` | Shared utilities (354 files across 40+ subdirs) |
| `src/services/` | API services, MCP, analytics, etc. |
| `src/services/api/` | Provider adapters (claude, openai, gemini, bedrock) |
| `src/services/rayuAuth/` | Optional rayu-backend authentication |
| `src/components/` | UI components (145+ files) |
| `src/state/` | Zustand-like state management |
| `src/hooks/` | React hooks (84) |
| `src/constants/` | Constants (22 files) |
| `src/types/` | TypeScript type definitions (15+ files) |
| `src/skills/bundled/` | Bundled skill definitions (20+ skills) |
| `src/telegram/` | Telegram bridge components |
| `src/bridge/` | Bridge abstractions |
| `src/coordinator/` | Multi-agent coordination |
| `src/buddy/` | Buddy system |
| `src/memdir/` | Memory directory utilities |
| `ORIGIN_MANIFEST.md` | Provenance tracking (original vs derivative) |
| `graphify-out/` | Knowledge graph output (graph.json, GRAPH_REPORT.md) |

---

## Workflow: Adding a New Feature

### Before you start:

1. **Use Graphify** — Run `/graphify` to understand the codebase structure and verify the feature doesn't already exist
2. **Read this file** — RAYU.md (you're reading it now)
3. **Read AGENTS.md** — For deeper agent guidance
4. **Check ORIGIN_MANIFEST.md** — Understand provenance (is this area derivative or original Rayu?)
5. **Search existing implementations** — Check all relevant directories from Rule 2

### Design phase:

6. **Read related source code** — Don't assume; verify actual implementation
7. **Ask clarifying questions** — If behavior is unclear, read the code until it's clear
8. **Check conventions** — Follow the patterns in nearby files

### Implementation phase:

9. **Write tests first** (TDD) — 80%+ coverage minimum
10. **Implement minimal code** to pass tests
11. **Run type checks:** `bun run typecheck`
12. **Build bundle:** `bun run build` (verify no bloat from feature flags)
13. **Test locally:** `bun run dev`

### Review phase:

14. **Code review** — Check against project conventions
15. **Verify no duplication** — Did you accidentally duplicate code elsewhere?
16. **Security review** — Check for hardcoded secrets, validation, etc.
17. **Performance check** — For large files or complex operations

### Commit phase:

18. **Detailed commit message** — Follow conventional commits format (feat, fix, refactor, docs, test, chore, perf, ci)
19. **Verify CI passes** — All automated checks green
20. **Resolve merge conflicts** — Sync with target branch

---

## What to DO

✅ **Always:**
- Read the source code when in doubt
- Use Graphify to explore the codebase
- Search broadly for existing implementations
- Follow project conventions and patterns
- Write tests (80%+ coverage minimum)
- Check `ORIGIN_MANIFEST.md` for file provenance
- Clarify behavior by reading actual code, not assumptions

✅ **When adding a new tool:**
- Check `src/tools.ts` for registration
- Read `src/Tool.ts` for the Tool interface
- Look at existing tool implementations for patterns
- Add to the registry via `getTools()`

✅ **When adding a new command:**
- Check `src/commands.ts` for registration
- Read `src/commands/` directory structure for patterns
- Add to the registry via `getCommands()`

✅ **When adding a new utility:**
- Check if similar utilities exist in `src/utils/`
- Follow existing file organization (small, focused files)
- Re-export from index.ts if part of a module

---

## What NOT to do

❌ **Never:**
- Assume behavior from "what it should be" — read the code
- Guess that upstream Claude Code features work the same here
- Make assumptions about file paths or structure
- Hardcode values — use constants from `src/constants/`
- Duplicate code — search first, reuse existing code
- Convert feature-gated `require()` to static `import` — breaks DCE
- Assume the Ink renderer is standard npm `ink` — it's custom
- Skip the duplication check — this codebase is HUGE

❌ **Don't skip:**
- Reading actual source code when unclear
- Using Graphify for codebase exploration
- Checking existing implementations before writing
- Tests (80%+ coverage required)
- Type checking (`bun run typecheck`)

---

## When Adding Code: The Checklist

Before marking work complete, verify:

- [ ] **Code is readable** and well-named
- [ ] **Functions are small** (<50 lines)
- [ ] **Files are focused** (<800 lines)
- [ ] **No deep nesting** (>4 levels)
- [ ] **Error handling is explicit**
- [ ] **No hardcoded values** (use constants)
- [ ] **No mutation** (use immutable patterns)
- [ ] **Tests exist** (80%+ coverage minimum)
- [ ] **No duplication** (searched first, reused existing code)
- [ ] **Conventions followed** (TypeScript, Bun, React/Ink patterns)
- [ ] **Security reviewed** (no hardcoded secrets, validation, injection prevention)
- [ ] **No console.log** in production code
- [ ] **Types are explicit** (especially public APIs)
- [ ] **Build passes** (`bun run build`)
- [ ] **Tests pass** (`bun test`)
- [ ] **Type check passes** (`bun run typecheck`)

---

## Questions? Clarifications?

If you're unsure about anything:

1. **Use Graphify** — `/graphify` to explore the codebase
2. **Read the source** — Don't assume; verify in code
3. **Check conventions** — Look at nearby files for patterns
4. **Ask the user** — If unclear after reading the code, ask for clarification

**Remember: Code is the source of truth, not training data or assumptions.**
