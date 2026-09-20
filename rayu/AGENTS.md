# AGENTS.md — AI Agent Instructions for RAYU CLI

This file provides critical guidance to AI agents (including RAYU itself) when working with this codebase. **READ THIS FILE FIRST before making ANY changes.**

---

## What is RAYU CLI?

**RAYU CLI** (`@rayu-dev/rayu-cli`) is a **terminal-based AI coding agent** — a multi-provider AI assistant that runs in your terminal, offering deep integration with your development workflow. The same `src/` also builds **Rayucode**, a VS Code extension — see "Shared Source, Two Products" below before adding anything.

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
- **Monorepo context:** sibling projects `rayu-backend`, `rayu-gateway-rust`, `rayu-web` — see "Phase 3" below for how this codebase relates to them
- **TypeScript + Bun** with compile-time feature flag DCE via `feature('FLAG')` from `bun:bundle`
- **Custom React reconciler** (`src/ink/`) for terminal output (not standard npm `ink`)
- **Zustand-like state management** in `src/state/`
- **~94 registered commands** in `src/commands.ts` via `getCommands()`
- **~48 registered tools** in `src/tools.ts` via `getTools()`

---

## Shared Source, Two Products

`src/` builds **two products from one engine**: the terminal CLI (`@rayu-dev/rayu-cli`) and **Rayucode**, a VS Code extension. Neither is a fork of the other and neither imports the other as a library — `bun run build:vscode` compiles the extension directly from this same `src/` tree (`scripts/build-vscode.ts`), producing three bundles:

| Bundle | Runs as | Entry |
|---|---|---|
| `engine.mjs` | a spawned child process (node, ESM) — the FULL engine, same code the CLI runs | `src/entrypoints/vscodeHost.ts` |
| `extension.js` | the VS Code extension host (node, CJS, `vscode` external) | `src/vscode/host/extension.ts` |
| `webview.js` | the React UI inside VS Code's webview (browser target) | `src/vscode/webview/` |

The engine runs as a **separate process**, not an in-process module, because it owns things the extension host cannot survive giving up: `process.on('SIGINT')`, `process.exit()`, direct `process.stdout` writes carrying the stream-json protocol, and a self re-exec with a computed `--max-old-space-size`. The CLI's own entry (`src/entrypoints/cli.tsx`) runs that identical engine directly in its own process instead of spawning it — same engine, different host.

**Where new code goes — decide this before writing anything:**

1. **Does the engine itself need it** (a tool, a command, a provider adapter, a piece of state, anything the AI agent loop uses)? → It goes in the **shared engine source** — `src/tools/`, `src/commands/`, `src/services/`, `src/state/`, `src/utils/`, etc. (everything under `src/` that is NOT `src/vscode/`). Both products get it automatically; there is nothing to wire up per-product. This is the common case — **when in doubt, a new tool/command/provider/utility belongs here, not under `src/vscode/`.**
2. **Is it purely about how VS Code hosts the extension** (activation, the webview UI, VS Code-specific auth/IDE integration, panel/webview protocol types)? → It goes under `src/vscode/`:
   - `src/vscode/host/` — the extension host: activation, auth (`host/auth/`), engine spawning/control (`host/engine/`), the chat panel (`host/panel/`), IDE integration (`host/ide/`), diff/review UI (`host/review/`).
   - `src/vscode/shared/` — types/protocol shared **between the host and the webview only** (`webviewProtocol.ts`, `connectProtocol.ts`, `permissionModes.ts`, etc.) — this is NOT the same thing as the engine-level shared `src/` described in point 1.
   - `src/vscode/webview/` — the React UI rendered inside VS Code.
3. **Is it purely about the terminal** (Ink components, terminal-only keybindings, the TUI-specific rendering of something)? → It goes under the CLI-facing parts of the shared source (`src/components/`, `src/ink/`, `src/keybindings/`) but is naturally invisible to the extension because the extension never mounts the Ink renderer — no gating needed, just don't route it through `src/vscode/`.

**Before adding a tool, command, provider, or utility, ask: "does this need to work identically whether the user is in a terminal or in VS Code?"** For nearly everything the answer is yes — a new tool, a new provider adapter, a new piece of billing logic, a new external-agent capability — all of it lives once in the shared engine and both front ends get it for free. Only genuinely UI-hosting concerns (how the chat renders, how VS Code's own panel/webview talks to the engine) are product-specific, and those already have a home in `src/vscode/`. Do not create a parallel implementation of engine logic inside `src/vscode/host/` "for VS Code" — if you find yourself doing that, the right fix is almost always to make the shared engine code configurable/host-agnostic instead, the same way `src/entrypoints/cli.tsx` and `src/entrypoints/vscodeHost.ts` are two thin entries over one engine.

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
  MAIN agent and for any subagent routed elsewhere, so a provider is
  registered exactly once.

**Cross-provider routing.** A request model may carry a `providerId\u0000model`
prefix (`rayuConfig.encodeModelWithProvider`, produced by `utils/model/agent.ts`)
so a subagent or delegated worker runs on a DIFFERENT provider than the active
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

### 🛑 Rule 1: No assumptions — read the source, then clarify

This codebase has significant modifications and is NOT a standard fork. Do not assume behavior from "what it should be," from general AI-agent knowledge, or from how upstream Claude Code works — READ THE ACTUAL CODE. If you guess, you will introduce bugs.

When something is unclear: read the source, trace the execution path, check `ORIGIN_MANIFEST.md` for provenance (original Rayu vs derivative Claude Code), use Graphify (Rule 3) to find relationships, and ask the user if it's still genuinely ambiguous after reading.

A few concrete traps, because they've bitten before:
- `feature('FLAG')` is **compile-time DCE**, not a runtime check — it's removed from the bundle entirely when disabled. Never convert a feature-gated `require()` to a static `import`.
- The Ink renderer at `src/ink/reconciler.ts` is a **custom reconciler** (packed Int32 buffers, custom ANSI parser, Yoga layout) — not standard npm `ink`.
- State management is **Zustand-like stores** in `src/state/`, not React context.
- Directory structure doesn't follow any external template — Rayu adds whole directories (`src/telegram/`, `src/coordinator/`, `src/bridge/`, `src/buddy/`, `src/vscode/`, etc.) that won't exist in your training data.

### 🔍 Rule 2: Prevent duplicate code — search before you write

Before adding any function, component, command, tool, or utility, verify it doesn't already exist. This codebase has 2000+ source files across 60+ directories, so duplication is the default outcome if you skip this. Duplicate code is a bug — treat it like one.

Search first (`grep`/`glob`, or Graphify per Rule 3) across the obvious registries before writing anything new: `src/commands/` + `src/commands.ts`, `src/tools/` + `src/tools.ts`, `src/utils/` (40+ subdirs), `src/components/`, `src/services/`, `src/skills/bundled/`, `src/hooks/`, `src/state/`, `src/vscode/`. Search broadly — the same concept may exist under a different name. If something similar exists, extend it; don't fork it.

### 📊 Rule 3: Use Graphify first, not as a last resort

Graphify is a knowledge-graph tool over this codebase — nodes are code entities, edges are relationships. Use it **before** writing code to check whether something already exists, and whenever you need to understand how modules relate (the provider architecture, the tool/command registries, an unfamiliar directory).

- Skill location: `.kiro/skills/graphify/SKILL.md` — invoke via `/graphify` or the Skill tool
- Output: `graphify-out/graph.json` and `graphify-out/GRAPH_REPORT.md`
- Common flags: `--mode deep` (thorough extraction), `--update` (incremental), `query` (BFS/DFS traversal), `--html` (interactive export)
- Typical use: `/graphify --mode deep src/tools/` before adding a tool, then read `GRAPH_REPORT.md` for anything similar before writing new code.

If you write code without checking Graphify or searching first, you are very likely creating duplicate code.

### 📋 Rule 4: Follow project conventions

- **TypeScript + Bun** — ES modules, dynamic `import()` for lazy loading
- **Feature flags:** `feature('FLAG')` from `bun:bundle` is compile-time DCE — see Rule 1
- **Commands:** registered in `src/commands.ts` via `getCommands()`
- **Tools:** registered in `src/tools.ts` via `getTools()`
- **Skills:** defined in `src/skills/bundled/` with SKILL.md files
- **React/Ink:** custom reconciler for terminal UI, not npm `ink`
- **State management:** Zustand-like stores in `src/state/`
- **Theme system:** ~80+ color tokens in `src/utils/theme.ts`; design system primitives in `src/components/design-system/`
- Check `src/constants/` before hardcoding values and `src/types/` before defining new types
- Check `src/keybindings/` before adding new keybindings

### 🧪 Rule 5: Build & test commands

```bash
bun install              # install dependencies
bun run dev              # run the CLI from source (no bundle step)
bun run build            # bundle → dist/rayu.js
bun run build:vscode     # bundle the Rayucode VS Code extension (.vsix)
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
- Create a new class in `src/tools/YourToolName/YourToolName.ts` — this is the shared engine, so it is automatically available to both the CLI and the VS Code extension (see "Shared Source, Two Products" above)
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
- Create a new directory in `src/commands/yourCommandName/` — shared engine, so both products get it
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

**DO NOT assume standard Ink APIs work here. READ THE CODE.** This renderer is CLI-only — the VS Code extension never mounts it; its UI is the React webview under `src/vscode/webview/` instead.

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

- **Backend location:** sibling monorepo project `rayu-backend`
- **Integration files:** `src/services/rayuAuth/`, `src/commands/billing/`
- **How it works:**
  1. User logs in via `/login` command (or automatically on first launch)
  2. Auth tokens stored securely
  3. API calls proxied through rayu-gateway
  4. Usage tracked in rayu-backend database
  5. User billed based on usage

**This is OPTIONAL — RAYU can run fully offline with direct API keys.**

---

## Phase 3: How This Codebase Relates to rayu-backend, rayu-gateway-rust, and rayu-web

Whatever RAYU is doing — CLI session or VS Code extension, doesn't matter, it's the same engine — model provider selection, usage metering, and plan/credit enforcement are **not self-contained here**. This codebase is one of three services in that flow, and most non-trivial features touch at least one of the other two:

| Service | What it owns, from this codebase's point of view |
|---|---|
| `rayu-backend` (NestJS) | Accounts, login, plans, credit/topup balances, the model/provider catalog admins configure, `/billing` data. This is who `/login` and `/billing` actually talk to. |
| `rayu-gateway-rust` (Rust) | The hot path: every request sent through the **Rayu-hosted** provider (as opposed to a user's own BYOK key) is proxied through here — rate limiting, credit settlement, provider-key rotation. BYOK requests never touch it; they go straight to the provider's own host. |
| `rayu-web` (Next.js) | Where a human manages their account/plan/billing outside the CLI, and where `/cli-login` and `/vscode-login` complete the device-code sign-in this codebase starts. |

**Where this shows up in `src/`:**
- `src/services/rayuAuth/` — the whole integration surface: `rayuSession.ts` (auth session + base URLs for both the backend and the gateway — `RAYU_API_URL` / `RAYU_GATEWAY_URL`), `rayuLogin.ts`, `rayuEntitlements.ts` (what the current plan allows), `rayuCredits.ts` / `rayuTopup.ts` (balance and purchasing), `rayuModelCatalog.ts` / `rayuPlansCatalog.ts` (what `rayu-backend` publishes), `rayuHostedProvider.ts` (the client that talks to `rayu-gateway-rust`), `rayuDevices.ts`, `rayuFeatureUsage.ts`.
- `src/commands/billing/` — the `/billing` command, reading plan/credit state from `rayu-backend`.
- `src/services/api/providerRegistry.ts` — `rayu-hosted` is one `ProviderKind` among others; picking it is what routes a session's model traffic through `rayu-gateway-rust` instead of directly to a provider.
- `src/webBridge/` + `src/commands/web-bridge.ts` (`/web-bridge`) — connects a running session (CLI **or** VS Code — both implement the identical protocol) outbound to `rayu-backend`'s relay so `rayu-web`'s Studio (`/studio/remote`) can attach to and drive it live. This is a distinct feature from `src/bridge/` (Claude Code's own upstream claude.ai remote-control) — don't conflate the two just because both are called "bridge."
- `src/vscode/host/auth/vscodeLogin.ts` — the VS Code-specific half of signing in; it completes against the same `rayu-backend` accounts as the CLI's `/login`, via `rayu-web`'s `/vscode-login` device-code page.

**Before touching anything in this area:** confirm which of the three services actually owns the behavior you're changing before assuming it's local to this codebase. A "usage isn't updating" or "wrong plan limit" bug is very often a `rayu-backend` or `rayu-gateway-rust` data issue, not a bug in `src/services/rayuAuth/`. Read that sibling codebase's own `AGENTS.md`/`README.md` before changing cross-service behavior.

---

## Key File Map

| Path | Purpose |
|------|---------|
| `src/entrypoints/cli.tsx` | CLI bootstrap, fast-paths, lazy-loads main session |
| `src/entrypoints/vscodeHost.ts` | Entry for the `engine.mjs` bundle spawned by the VS Code extension |
| `src/vscode/` | VS Code-only: `host/` (extension host), `shared/` (host↔webview protocol), `webview/` (React UI) — see "Shared Source, Two Products" |
| `src/main.tsx` | Full interactive session wiring (500+ lines) |
| `src/query.ts` | Streaming API call loop, message normalization, compact |
| `src/QueryEngine.ts` | Stateful per-session AI engine |
| `src/tools.ts` | Tool registry (~48 tools) |
| `src/commands.ts` | Command registry (~94 commands) |
| `src/Tool.ts` | Tool interface and base types |
| `src/ink/` | Custom terminal renderer (50+ files), CLI-only |
| `src/utils/` | Shared utilities (354 files across 40+ subdirs) |
| `src/services/` | API services, MCP, analytics, etc. |
| `src/services/api/` | Provider adapters (claude, openai, gemini, bedrock) |
| `src/services/rayuAuth/` | rayu-backend + rayu-gateway-rust integration (auth, plans, credits, model catalog) |
| `src/components/` | UI components (145+ files) |
| `src/state/` | Zustand-like state management |
| `src/hooks/` | React hooks (84 covering suggestions, permissions, keybindings, voice, swarm, teleport, settings, skills, tasks, etc.) |
| `src/constants/` | Constants (22 files) |
| `src/types/` | TypeScript type definitions (15+ files) |
| `src/skills/bundled/` | Bundled skill definitions (20+ skills) |
| `src/telegram/` | Telegram bridge components |
| `src/webBridge/` | Rayu Web Bridge client (CLI/VS Code ↔ rayu-backend ↔ rayu-web Studio remote-control) |
| `src/externalAgents/` | External-agent orchestrator: drive Codex / Claude Code / OpenCode / ACP CLIs (core, adapters, orchestration, recovery, workspace, permissions) |
| `src/commands/agent/` | `/agent` command — user-facing orchestrator surface |
| `src/tools/ExternalAgentTool/` | `ExternalAgent` tool — model-facing delegate/send/list/orchestrate |
| `src/tasks/ExternalAgentTask/` | `external_agent` background task type |
| `src/bridge/` | Claude Code's own upstream remote-control (connects to claude.ai) — NOT the same as `src/webBridge/` |
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
3. **Decide where it belongs** — Shared engine (`src/`, both products get it) or VS Code-only (`src/vscode/`)? See "Shared Source, Two Products"
4. **Check ORIGIN_MANIFEST.md** — Understand provenance (is this area derivative or original Rayu?)
5. **Search existing implementations** — Check all relevant directories from Rule 2

### Design phase:

6. **Read related source code** — Don't assume; verify actual implementation
7. **Ask clarifying questions** — If behavior is unclear, read the code until it's clear
8. **Check conventions** — Follow the patterns in nearby files
9. **If it touches providers, usage, plans, or credits** — check whether the behavior actually lives in `rayu-backend` or `rayu-gateway-rust` first (see "Phase 3")

### Implementation phase:

10. **Write tests first** (TDD) — 80%+ coverage minimum
11. **Implement minimal code** to pass tests
12. **Run type checks:** `bun run typecheck`
13. **Build bundle:** `bun run build` (verify no bloat from feature flags) — and `bun run build:vscode` too if the change touches shared engine code
14. **Test locally:** `bun run dev`

### Review phase:

15. **Code review** — Check against project conventions
16. **Verify no duplication** — Did you accidentally duplicate code elsewhere?
17. **Security review** — Check for hardcoded secrets, validation, etc.
18. **Performance check** — For large files or complex operations

### Commit phase:

19. **Detailed commit message** — Follow conventional commits format (feat, fix, refactor, docs, test, chore, perf, ci)
20. **Verify CI passes** — All automated checks green
21. **Resolve merge conflicts** — Sync with target branch

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
- Put new engine logic (tools, commands, providers, utilities) in the shared `src/` so both the CLI and Rayucode get it — reserve `src/vscode/` for genuinely VS Code-only concerns

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
- Reimplement shared engine logic inside `src/vscode/host/` "just for VS Code" — fix the shared code to be host-agnostic instead
- Assume a usage/plan/provider bug is local to this codebase — it may live in `rayu-backend` or `rayu-gateway-rust`

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
