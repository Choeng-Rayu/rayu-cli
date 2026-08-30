# AGENTS.md — AI Agent Instructions for RAYU CLI

This file provides critical guidance to AI agents (including RAYU itself) when working with this codebase. **READ THIS FILE FIRST before making ANY changes.**

---

## What is RAYU CLI?

**RAYU CLI** (`@rayu-dev/rayu-cli`) is a **terminal-based AI coding agent** — a multi-provider AI assistant that runs in your terminal, offering deep integration with your development workflow.

### What Makes RAYU Unique?

RAYU is designed to be a **universal AI coding assistant** that works with any AI provider (Anthropic, OpenAI, NVIDIA, DeepSeek, Kimi/Moonshot, OpenRouter, Google Gemini, AWS Bedrock, or any OpenAI-compatible endpoint). Think of it as:

- **A terminal UI wrapper** that gives you Claude Code-style interaction with ANY AI provider
- **A multi-provider CLI tool** with ~94 slash commands for development workflows
- **An extensible tool platform** with ~48 built-in tools (file operations, bash, web search, MCP integration, etc.)
- **A skill system** supporting both bundled and external skills
- **A Telegram bridge** allowing mobile/remote access to your AI coding agent via Telegram bot

### Core Features

1. **Multi-Provider Support**: Switch between Anthropic Claude, OpenAI, DeepSeek, Google Gemini, AWS Bedrock, and more
2. **Rich Terminal UI**: Custom React/Ink-based TUI with syntax highlighting, diffs, progress indicators, and interactive components
3. **Comprehensive Tooling**: 48+ tools including file operations (Read, Write, Edit, Glob, Grep), Bash execution, web fetch/search, LSP integration, MCP servers, and more
4. **Command System**: 94+ slash commands for development tasks (/connect, /model, /help, /config, /diff, /plan, /swarm, /memory, /telegram-bot, etc.)
5. **Skill System**: Bundled skills (simplify, verify, remember, updateConfig, keybindings, etc.) and support for external Claude skills
6. **Telegram Integration**: Connect your RAYU CLI to Telegram for mobile/remote access
7. **State Management**: Zustand-like stores for managing complex application state
8. **Image/Video Generation**: Built-in tools for generating images and videos via AI models
9. **Billing Integration**: Optional rayu-backend integration for centralized billing and management
10. **External Agent Orchestration**: Launch, adopt, assign work to and stream OTHER agentic CLIs (Codex, Claude Code, OpenCode, any ACP agent) as capability-gated plugins — `/agent` and the `ExternalAgent` tool

### Technical Architecture

**RAYU CLI** is a TypeScript + Bun + React/Ink application with the following key characteristics:

- **~2027+ source files** across **60+ top-level directories** under `src/`
- **~96% derivative** from Anthropic Claude Code fork; **~4% original** Rayu additions (ORIGIN_MANIFEST.md tracks provenance)
- **Monorepo context:** Part of `/home/rayu/rayu-cli/` with 4 sibling projects (rayu-backend, rayu-gateway, rayu-web, deploy)
- **TypeScript + Bun** with compile-time feature flag DCE via `feature('FLAG')` from `bun:bundle`
- **Custom React reconciler** (`src/ink/`) for terminal output (not standard npm `ink`)
- **Zustand-like state management** in `src/state/`
- **~94 registered commands** in `src/commands.ts` via `getCommands()`
- **~48 registered tools** in `src/tools.ts` via `getTools()`

### Provider Architecture

RAYU adapts every AI provider onto ONE internal representation: the **Anthropic
Messages (beta) request shape**. `src/services/api/claude.ts` builds that request
and calls `beta.messages.create(...).withResponse()`; every provider is a
*transport* that presents the same surface and translates outward from it.

There are **4 canonical wire formats** plus 2 provider-specific ones. Provider
KIND says who you are talking to; wire FORMAT says what goes over the socket — and
one provider can serve several formats, chosen **per model**:

| Wire format | Endpoint | Providers |
|---|---|---|
| `anthropic-messages` (the IR — no translation) | `/v1/messages` | first-party Anthropic; anthropic-compatible (LongCat, Ollama Cloud); rayu-hosted; **Claude** on Bedrock / Azure / Vertex |
| `openai-chat` | `/chat/completions` | openai-compatible (NVIDIA, DeepSeek, Kimi, OpenRouter, local); GitHub Copilot; Bedrock non-Claude (bedrock-mantle); Vertex MaaS |
| `openai-responses` | `/responses` | Azure OpenAI; any custom provider that picks it |
| `genai` | `generateContent` | Gemini on Vertex; Login-with-Gemini (Code Assist) |
| `codewhisperer` | AWS event-stream | Kiro |

**The single dispatch table is `src/services/api/providerRegistry.ts`.** Adding or
changing a provider means editing that one file:

- `resolveWireFormat(provider, model)` — precedence: explicit `provider.wireFormat`
  → per-kind model-pattern rules → kind default. **Pure**, so it is exhaustively
  testable.
- `resolveClientTarget(provider, model)` — which client implementation serves it,
  or `'unsupported'` when credentials/endpoint are missing. **Pure.**
- `buildClient(provider, opts)` — a thin executor over that decision. Used for the
  MAIN agent and for any subagent/collaborator routed elsewhere, so a provider is
  registered exactly once.

**Cross-provider routing.** A request model may carry a `providerId\u0000model`
prefix (`rayuConfig.encodeModelWithProvider`, produced by `utils/model/agent.ts`)
so a subagent or swarm collaborator runs on a DIFFERENT provider than the active
one, concurrently. `services/api/client.ts` decodes it to pick the transport, and
`utils/model/providerCapabilities.ts` decodes the same string to shape the request
— use `resolveRequestShape(model)` / `usesTranslatedFormat(model)` /
`isFirstPartyRequest(model)` for anything request-shaping. The older
`isXActive()` predicates in `utils/model/providers.ts` answer only for the ACTIVE
provider and are correct only for session-global questions (the model picker,
`/status`, preconnect, policy limits).

Shared building blocks — reuse these, do not re-implement:

| Module | Owns |
|---|---|
| `anthropicIR.ts` | reading the IR (system prompt, text blocks, image sources) — used by ALL translators |
| `openaiShared.ts` | tool specs + reasoning-effort mapping for both OpenAI formats |
| `anthropicMessagesClient.ts` | the ONLY `new Anthropic()` call site; auth modes `x-api-key` / `bearer` / `custom-fetch` |
| `anthropicTransport.ts` | headers, timeout, proxy, debug logger; `firstParty` flag gates first-party-only headers |
| `providerKeys.ts` | the API-key list + paid multi-key gate |
| `keyRotation.ts` | which HTTP statuses roll over to the next key |
| `awsEventStream.ts` | AWS event-stream framing (Kiro **and** Bedrock streaming) |

**Security invariants** (see each module's header for the reasoning): a provider's
credential is only ever sent to that provider's own host; URL-rewriting fetches
validate the final host and use `redirect:'error'`; first-party-only headers
(`ANTHROPIC_CUSTOM_HEADERS`, `x-client-request-id`, `X-Claude-Code-Session-Id`) are
gated to genuine api.anthropic.com; remote catalog model ids are sanitized
(`sanitizeRemoteModelId`) because a `\u0000` in one could spoof provider routing.

### How RAYU Differs from Claude Code

RAYU CLI started as a Claude Code fork but has evolved significantly:

| Feature | Claude Code (upstream) | RAYU CLI |
|---------|------------------------|----------|
| Provider support | Anthropic only | Multi-provider (Anthropic, OpenAI, DeepSeek, Gemini, Bedrock, etc.) |
| Pricing model | Direct API key | Optional centralized billing via rayu-backend |
| Remote access | Desktop/Web only | Telegram bridge for mobile/remote access |
| Tool set | ~40 tools | ~48 tools (adds image/video generation, telegram, billing) |
| Deployment | Self-hosted | Self-hosted + optional cloud (rayu-backend) |
| Branding | Claude Code | RAYU (customizable brand glyph/mascot) |

**Critical for AI agents:** Do NOT assume Claude Code features work the same in RAYU. Always read the actual source code, never guess based on upstream behavior.

---

## CRITICAL RULES FOR AI AGENTS

### 🛑 Rule 1: NO ASSUMPTIONS — Always Find Root Cause and Clarify

**NEVER assume how RAYU works based on general "AI agent" or "Claude Code" knowledge.** This codebase has significant modifications and is NOT a standard fork.

**🚨 CRITICAL WARNING FOR AI AGENTS 🚨**

**DO NOT make assumptions about this codebase.** You MUST find the root cause and clarify by reading the actual source code. This is NOT negotiable. This is NOT optional.

**If you guess, you WILL introduce bugs. If you assume, you WILL break existing functionality.**

**When you encounter something unclear:**
- ✅ **DO:** Read the actual source code, trace execution paths, verify behavior in the code
- ✅ **DO:** Clarify by reading file contents — don't assume from names or docstrings
- ✅ **DO:** Check `ORIGIN_MANIFEST.md` to understand which files are original vs derivative
- ✅ **DO:** Use Graphify (see Rule 3) to explore the codebase and discover relationships
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
- "The Ink renderer is standard npm ink" → **NO** — custom reconciler at `src/ink/reconciler.ts` with packed Int32 buffers, custom ANSI parser, Yoga layout
- "Permission system is simple" → **NO** — 20+ files with classifiers, shell rule matching, dangerous patterns, shadowed rule detection
- "State management uses React context" → **NO** — uses Zustand-like stores in `src/state/`
- "Directory structure follows convention" → **NO** — Rayu adds entire new directories: `src/telegram/`, `src/coordinator/`, `src/bridge/`, `src/buddy/`, `src/memdir/`, `src/assistant/`, `src/remote/`, etc.

**When in doubt: READ THE SOURCE CODE. It is the source of truth, not your training data.**

---

### 🔍 Rule 2: PREVENT DUPLICATE CODE — Read Before You Write

**CRITICAL: Before adding ANY new function, component, command, tool, utility, or feature, you MUST verify it does not already exist.**

The codebase has **2027+ source files** across **60+ directories** — accidental duplication is EXTREMELY likely.

**🚨 THIS IS NOT OPTIONAL 🚨**

**You MUST search FIRST, code SECOND. Always. Every time. No exceptions.**

**Duplicate code is a BUG. Treat it as seriously as a security vulnerability.**

**When thinking about a new feature or addition:**

1. **Stop and search first** — use `Grep` and `Glob` to check if similar functionality exists
2. **Use Graphify FIRST** (see Rule 3) — it's faster than manual searching and discovers relationships you might miss
3. **Check ALL relevant locations:**
   - `src/commands/` — 94 commands exist; check `src/commands.ts` for registry
   - `src/tools/` — 48 tools exist; check `src/tools.ts` for registry
   - `src/utils/` — 354 files across 40+ subdirectories (git, settings, bash, mcp, memory, permissions, hooks, swarm, model, messages, background, github, sandbox, suggestions, todo, ultraplan, filePersistence, secureStorage, processUserInput, deepLink, computerUse, dxt, nativeInstaller, powershell, shell, skills, task, teleport, cron, etc.)
   - `src/components/` — 145+ UI components across design-system, messages, permissions, agents, diff, hooks, mcp, memory, sandbox, shell, skills, tasks, teams, ui, wizard
   - `src/services/` — API services (api/, mcp/, rayuAuth/, analytics/, lsp/, plugins/, settingsSync/, compact/, policyLimits/)
   - `src/skills/bundled/` — 20+ bundled skills (simplify, verify, remember, updateConfig, keybindings, claudeApi, rayuSkills, batch, debug, loop, loremIpsum, scheduleRemoteAgents, skillify, stuck, etc.)
   - `src/hooks/` — 84 React hooks
   - `src/state/` — Zustand-like stores (AppState, selectors, store, etc.)
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

**Examples of how to search:**

```bash
# Search for existing tool implementations
grep -r "class.*Tool" src/tools/

# Search for similar command implementations
grep -r "command.*telegram" src/commands/

# Search for utility functions
grep -r "function.*validate" src/utils/

# Use Graphify to explore relationships
/graphify --mode deep src/tools/
```

---

### 📊 Rule 3: USE GRAPHIFY FOR CODEBASE UNDERSTANDING

**🚨 GRAPHIFY IS YOUR FIRST TOOL, NOT YOUR LAST RESORT 🚨**

**Graphify is available and MUST be used as a FIRST STEP for codebase exploration.**

Graphify is a knowledge-graph tool that can:
- Build a knowledge graph of the codebase (nodes = code entities, edges = relationships)
- Discover code structure, dependencies, and relationships **10x faster** than manual searching
- Find whether functionality already exists before you write it
- Map dependencies across the entire codebase
- Identify related code you didn't know existed
- Trace execution paths through complex module interactions

**When to use Graphify (use it EARLY and OFTEN):**
- ✅ **Before writing any new code** — use Graphify to discover if something already exists
- ✅ **Before adding a new tool** — check if a similar tool exists
- ✅ **Before adding a new command** — check if a similar command exists
- ✅ **Before adding a utility function** — check if similar utilities exist
- ✅ When exploring an unfamiliar area of the codebase
- ✅ When understanding how components/modules relate to each other
- ✅ When debugging complex cross-module issues
- ✅ When you need to understand the dependency graph of a module
- ✅ When you're unsure where to put new code
- ✅ When you're trying to understand the provider architecture
- ✅ When you're trying to understand the tool registration system
- ✅ When you're trying to understand the command registration system

**How to use Graphify:**
- Skill location: `.kiro/skills/graphify/SKILL.md`
- **Invoke via:** `/graphify` or the Skill tool
- **Outputs go to:** `graphify-out/` directory (`graph.json`, `GRAPH_REPORT.md`)
- **Key commands:**
  - `--mode deep` — thorough extraction (use this for comprehensive analysis)
  - `--update` — incremental update (use this to refresh after changes)
  - `--cluster-only` — recluster only (faster than full rebuild)
  - `--html` / `--svg` / `--graphml` / `--neo4j` — export formats (use HTML for interactive exploration)
  - `--watch` — auto-rebuild (use this for continuous development)
  - `query` — BFS/DFS traversal (use this to trace relationships)
- **Tip:** Run `graphify --mode deep` on a specific directory to understand its structure before making changes

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

# To understand the provider architecture
/graphify --mode deep src/services/api/
```

**Graphify is available to you via the `/graphify` skill. Use it as your FIRST exploration tool, not your last resort.**

**If you write code without running Graphify first, you are almost certainly creating duplicate code.**

---

### 📋 Rule 4: Follow Project Conventions

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

### 🧪 Rule 5: Build & Test Commands

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
- **Tool registration:** Tools are registered in `src/tools.ts` via `getTools()`
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
  - **Team:** TeamCreate, TeamDelete, SendMessage (lazy-loaded to break circular deps)
  - **Testing:** TestingPermission (testing only)

**How tools work:**
1. AI model decides which tool to call (from schema)
2. Tool is invoked via `tool.execute()` with `toolInput` and `context`
3. Tool performs action (read file, execute bash, call API, etc.)
4. Tool returns `ToolResult` with content blocks
5. Result is sent back to AI model for next turn

**Adding a new tool:**
- Create a new class in `src/tools/YourToolName/YourToolName.ts`
- Extend the Tool interface
- Implement required methods: `name`, `description`, `inputSchema`, `execute()`
- Register in `src/tools.ts` by importing and adding to the tools array
- Use `ImageGenTool` as a reference pattern (it's relatively simple and well-structured)

### Command System

**Commands** are slash commands users can type in the interactive session.

- **Command interface:** Defined in `src/commands.ts`
- **Command registry:** `src/commands.ts` exports `getCommands()` which returns all available commands
- **Command implementation pattern:** Each command is an object with `name`, `description`, `type`, and `action`
- **Command registration:** Commands are registered in `src/commands.ts` via `getCommands()`
- **Command types:**
  - `'interactive'` — shows interactive UI (most commands)
  - `'non-interactive'` — executes immediately without showing UI
  - `'jsx'` — renders JSX component

**How commands work:**
1. User types `/commandName` in the input
2. Command is looked up in the registry
3. Command's `action` function is called
4. Action can show UI, modify state, or trigger other actions

**Adding a new command:**
- Create a new directory in `src/commands/yourCommandName/`
- Create `index.ts` with command definition
- Export command object with `name`, `description`, `type`, `action`
- Register in `src/commands.ts` by importing and adding to the commands array

### Provider Architecture

**Providers** all speak the Anthropic Messages IR internally; each is a transport.
See "Provider Architecture" above for the wire-format table — this section covers
only the mechanics.

- **Single dispatch table:** `src/services/api/providerRegistry.ts`
- **Provider kinds** (`ProviderKind` in `src/utils/rayuConfig.ts`): `anthropic`,
  `anthropic-compatible`, `openai-compatible`, `bedrock`, `azure`, `vertex`,
  `genai`, `kiro`, `copilot`, `rayu-hosted`, `custom`

**How providers work:**
1. User selects a provider via `/connect` (`src/components/RayuProviderSetup.tsx`)
2. Provider config is saved to `~/.rayu/providers.json` at mode 0600 (secrets)
3. `getAnthropicClient({model})` resolves the provider — routed prefix first, else
   active — then `buildClient()` resolves format → client
4. The adapter translates the Anthropic Messages request into the target protocol
   and translates the response stream back into Anthropic events
5. `claude.ts` consumes those events, unaware of which provider served them

**Provider files** (the ones that actually exist):
- `src/services/api/claude.ts` — builds the IR request; provider-agnostic
- `src/services/api/providerRegistry.ts` — format + client resolution (start here)
- `src/services/api/anthropicMessagesClient.ts` — the only `new Anthropic()`
- `src/services/api/openaiAdapter.ts` — OpenAI Chat Completions
- `src/services/api/openaiResponsesAdapter.ts` — OpenAI Responses
- `src/services/api/gemini/genaiTranslate.ts` — GenAI (Vertex + Code Assist)
- `src/services/api/bedrockAnthropic.ts` — Claude on Bedrock (URL rewrite + SSE transcode)
- `src/services/api/azureFoundry.ts` — Azure endpoints (Claude + Azure OpenAI)
- `src/services/api/gemini/vertexAnthropic.ts` — Claude + MaaS on Vertex
- `src/services/api/kiro/` — CodeWhisperer event-stream
- `src/utils/model/providerCapabilities.ts` — per-(provider, model) request shaping
- `src/utils/customProvider.ts` — validation for user-defined providers

### State Management

**RAYU uses Zustand-like stores** for state management (not React context).

- **State location:** `src/state/`
- **Main store:** `src/state/AppState.ts` exports `useAppState()` hook
- **State shape:** See `AppState` interface in `src/state/AppState.ts`
- **State mutations:** Via setter functions, not direct mutation

**Key state slices:**
- Messages (conversation history)
- Tools (available tools)
- Commands (available commands)
- Permissions (permission mode, rules, denials)
- MCP (connected MCP servers)
- Settings (user configuration)
- Skills (loaded skills)
- Tasks (todo list)
- Telegram (telegram bot connection state)

### Terminal Rendering (Ink)

**RAYU uses a CUSTOM React reconciler** for terminal output — NOT standard npm `ink`.

- **Reconciler location:** `src/ink/reconciler.ts`
- **Key differences from standard Ink:**
  - Packed Int32 buffers for performance
  - Custom ANSI parser
  - Yoga layout engine
  - Custom component primitives

**DO NOT assume standard Ink APIs work here. READ THE CODE.**

### Telegram Bridge

**RAYU has a Telegram bridge** for mobile/remote access.

- **Bridge location:** `src/telegram/`, `src/bridge/`
- **Bot:** resolved at runtime — never hardcoded in the CLI. The default
  (hosted) bot's `@username` comes from rayu-backend's `/telegram/bot`, which
  derives it from `RAYU_SHARED_BOT_TOKEN`; to change the default bot, rotate
  that env var and restart the backend (`TelegramService.botUsername` is
  memoized per process). Users may instead bring their own @BotFather token,
  in which case the CLI talks to Telegram directly and the bot is resolved via
  `getMe`. The bot a link was made with is recorded in `telegram.json` as
  `linkedBotUsername` so `/telegram-bot` can detect a bot change and re-pair
  instead of silently reusing a stale link.
- **How it works:**
  1. User runs `/telegram-bot` command
  2. QR code displayed for pairing
  3. User scans QR code with Telegram
  4. Bot sends messages to RAYU CLI via WebSocket
  5. RAYU CLI sends responses back to Telegram

**Telegram bridge files:**
- `src/commands/telegram-bot/` — Telegram bot command
- `src/telegram/` — Telegram message handlers
- `src/bridge/` — Bridge abstractions

### Billing Integration (Optional)

**RAYU can integrate with rayu-backend** for centralized billing.

- **Backend location:** `/home/rayu/rayu-cli/rayu-backend/` (sibling monorepo project)
- **Integration files:** `src/services/rayuAuth/`, `src/commands/billing/`
- **How it works:**
  1. User logs in via `/login` command (or automatically on first launch)
  2. Auth tokens stored securely
  3. API calls proxied through rayu-gateway
  4. Usage tracked in rayu-backend database
  5. User billed based on usage

**This is OPTIONAL — RAYU can run fully offline with direct API keys.**

### External Agent Orchestrator

**RAYU can drive OTHER agentic CLIs** — Codex, Claude Code, OpenCode, and any
agent speaking the Agent Client Protocol — as plugins it launches, adopts,
assigns work to, and streams. This is what makes RAYU an orchestrator rather
than just another agent. Gated by `feature('EXTERNAL_AGENTS')`.

**Surfaces:** `/agent` (user) and the `ExternalAgent` tool (model). Work becomes
a real `external_agent` Task, so the EXISTING `/tasks` dialog and the
TaskOutput / TaskGet / TaskList / TaskStop tools already work on it.

#### The capability model — read this before touching an adapter

An adapter is **not** a fixed set of mandatory methods. Five axes
(`terminal`, `messages`, `sessions`, `process`, `permissions`) each carry a
LEVEL (`none` | `observe` | `message` | `full`), and an optional method is how an
adapter says "cannot".

Three rules that are easy to get wrong:

1. **A method that always throws is banned — lower the capability instead.** A
   throwing stub is a lie that surfaces mid-task. If Claude Code cannot resume a
   session from a live handle, its `sessions` level is `observe` and
   `resumeSession` does not exist.
2. **`handle.capabilities` is PER-INSTANCE and may be lower than
   `adapter.capabilityCeiling`.** The ceiling describes a RAYU-launched agent;
   an adopted or observed instance offers less. The ACP adapter derives its level
   from the `initialize` handshake, because conforming ACP agents genuinely
   differ.
3. **Adoption class downgrades capabilities.** `capabilitiesForAdoption` drops
   an `observable` instance to `messages: 'none'` and caps `terminal` at
   `'observe'`. It never RAISES anything. This is what keeps `/agent discover`
   honest instead of aspirational.

Adoption is classified, never assumed: **MANAGED** (RAYU launched it) /
**ADOPTABLE** (a real control channel exists — Codex `--listen` socket, OpenCode
HTTP) / **OBSERVABLE** (read its transcript only — Claude Code exposes no
listener, so adoption is impossible) / **UNKNOWN** (refuses to guess).

#### Four independent states — do not collapse them

`processState` (running) / `connectionState` (connected) / `agentState` (working)
/ external task state (waiting-provider). A live process can be unreachable; a
connected agent can be idle while its task waits on a provider. `resolveAdmission`
in `core/stateMachine.ts` maps (snapshot, capabilities, request) to
dispatch | steer | queue | resume | relaunch | reject and NEVER throws.

**Task ≠ session.** One agent instance serves many tasks over one native
session; `ExternalAgentTask.kill` interrupts the TURN, it does not stop the agent.

#### Layer map — `src/externalAgents/`

| Layer | Owns |
|-------|------|
| `core/` | types, state machine, admission, AgentManager, registries, event bus/normalizer/sinks, discovery, process scan. Must NOT import the renderer. |
| `persistence/` | `~/.rayu` agent records, sessions, forensics, workspace leases |
| `transport/` | JSONL reader, bidirectional JSON-RPC peer, child env allowlist |
| `adapters/` | `codex/`, `claudeCode/`, `opencode/`, `acp/`, `stub/` + `registry.ts` |
| `permissions/` | routes a foreign agent's approval into RAYU's own dialog |
| `workspace/` | per-agent changed files, conflicts, worktree isolation, leases |
| `orchestration/` | parallel / sequential / race / retry / fallback / reviewAfter |
| `recovery/` | crash survey, relaunch-with-resume, session install/teardown |

#### Non-obvious invariants (breaking these causes silent, expensive bugs)

- **Registration is explicit, never a module side effect.** A self-registering
  adapter would defeat `feature()` DCE and pull four CLIs' protocol code into
  every bundle. Call `registerAdapters()`.
- **Subscribe to an outcome BEFORE sending the work.** An adapter can answer
  inside the send call; `orchestration/` splits dispatch into
  `prepare()` then `start()` for exactly this reason.
- **`awaitTaskOutcome` must always settle.** It watches task terminal events,
  `agent_disconnected` (matched on agentId — disconnects carry no taskRef), an
  abort signal, and an optional timeout. An unsettled promise is
  indistinguishable from a hung agent.
- **A race in a shared working tree is REFUSED.** Cancelling a loser stops
  future work but does not revert edits already written.
- **Never write a foreign agent's file changes into `pendingFileChanges.ts`.**
  That store backs `/undo` and needs before-content RAYU cannot know;
  `workspace/changeTracker.ts` stores metadata only. See its header.
- **Recovery never relaunches automatically**, and never touches an agent whose
  `ownerPid` belongs to another live RAYU.
- **Permissions are brokered only when there is a real reply channel.** Otherwise
  the user is told to answer in the agent's own terminal. Nothing is written to
  RAYU's own permission rules.
- **`buildChildEnv` blocks `*_API_KEY|_SECRET|_TOKEN|...`** even if an adapter
  asks to forward them. RAYU's credentials never reach a third-party agent, and
  RAYU's MCP servers are never handed over either.

Configure extra ACP agents with the `RAYU_ACP_AGENTS` env var (JSON array of
`{provider, command, args?}`). Kill switch: `RAYU_EXTERNAL_AGENTS=0`.

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
| `src/hooks/` | React hooks (84 covering suggestions, permissions, keybindings, voice, swarm, teleport, settings, skills, tasks, etc.) |
| `src/constants/` | Constants (22 files) |
| `src/types/` | TypeScript type definitions (15+ files) |
| `src/skills/bundled/` | Bundled skill definitions (20+ skills) |
| `src/telegram/` | Telegram bridge components |
| `src/externalAgents/` | External-agent orchestrator: drive Codex / Claude Code / OpenCode / ACP CLIs (core, adapters, orchestration, recovery, workspace, permissions) |
| `src/commands/agent/` | `/agent` command — user-facing orchestrator surface |
| `src/tools/ExternalAgentTool/` | `ExternalAgent` tool — model-facing delegate/send/list/orchestrate |
| `src/tasks/ExternalAgentTask/` | `external_agent` background task type |
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
2. **Read AGENTS.md** — This file (you're reading it now)
3. **Check ORIGIN_MANIFEST.md** — Understand provenance (is this area derivative or original Rayu?)
4. **Search existing implementations** — Check all relevant directories from Rule 2

### Design phase:

5. **Read related source code** — Don't assume; verify actual implementation
6. **Ask clarifying questions** — If behavior is unclear, read the code until it's clear
7. **Check conventions** — Follow the patterns in nearby files

### Implementation phase:

8. **Write tests first** (TDD) — 80%+ coverage minimum
9. **Implement minimal code** to pass tests
10. **Run type checks:** `bun run typecheck`
11. **Build bundle:** `bun run build` (verify no bloat from feature flags)
12. **Test locally:** `bun run dev`

### Review phase:

13. **Code review** — Check against project conventions
14. **Verify no duplication** — Did you accidentally duplicate code elsewhere?
15. **Security review** — Check for hardcoded secrets, validation, etc.
16. **Performance check** — For large files or complex operations

### Commit phase:

17. **Detailed commit message** — Follow conventional commits format (feat, fix, refactor, docs, test, chore, perf, ci)
18. **Verify CI passes** — All automated checks green
19. **Resolve merge conflicts** — Sync with target branch

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
