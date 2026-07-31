# Make RAYU CLI Pluggable into Claude Code and Codex

## Improved Prompt

As a senior software engineer, design and implement the integration layer that lets **RAYU CLI plug into Claude Code and OpenAI Codex** as an extension / plugin. RAYU must be embeddable inside both host agents so their users can invoke RAYU's tools, skills, and provider routing from within Claude Code or Codex sessions.

## Background / Reference (already gathered)

### Claude Code extension surfaces
- **Hooks** — shell commands registered in `~/.claude/settings.json` (or project `.claude/settings.json`) that fire on lifecycle events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, etc. Each hook receives a JSON payload on stdin and returns a JSON verdict on stdout (allow/block/decision). This is the primary, lowest-friction way to inject an external CLI into Claude Code's loop.
- **MCP servers** — registered via `.mcp.json` (project) or user settings; supports stdio and HTTP/SSE transports. An MCP server exposes `tools`, `resources`, and `prompts` to Claude Code. This is the cleanest "plugin" surface for tool-level integration.
- **Skills** — `SKILL.md` files with frontmatter (`name`, `description`, optional `allowed-tools`), distributed as directories or via the skills repo, invocable as `/skill-name`. Skills are prompt-level procedures, not code plugins.
- **Agent SDK** — programmatic embedding of Claude Code's engine for custom orchestration. Heavier than MCP; only needed if we want to embed Claude Code inside RAYU (reverse direction).
- **CLI piping** — `claude -p "..."` non-interactive mode and stdin piping for one-shot composition. Useful for CI, not for live plugin integration.

Claude Code does **not** have a traditional "plugin package" system; the in-process equivalents are: hooks, MCP servers, skills, and the Agent SDK. The VS Code/JetBrains "plugins" are IDE extensions, not in-process plugins.

### Codex extension surfaces
- **Codex IDE extension** — per-editor extension (VS Code, Cursor, Windsurf, VS Code Insiders, Xcode, JetBrains). Composer takes open files + selection + recent chats as context; edits return as in-place diffs.
- **Codex SDK** — programmatic SDK for building on top of Codex.
- **App Server** — Codex's local/remote server protocol for programmatic clients.
- **MCP Server** — Codex supports MCP (Model Context Protocol); an MCP server registered with Codex exposes tools/resources/prompts.
- **Hooks** — Codex also has a hooks system for lifecycle events (analogous to Claude Code's).
- **Plugins & Skills** — Codex ships a "Build plugins" and "Build skills" system under "Extend and automate."
- **Non-interactive CLI mode** — `codex` CLI has a non-interactive mode for scripting.
- **GitHub Action** — for CI automation.

Both platforms **converge on MCP** as the shared, open standard for tool-level integration. MCP is the single integration surface that works for **both** Claude Code and Codex simultaneously.

## CRITICAL RULES (per RAYU.md / AGENTS.md)

### Rule 1: NO ASSUMPTIONS — Find Root Cause / Read the Code
Do NOT assume how RAYU's tool/command/skill/MCP systems work. This codebase has heavy modifications from upstream Claude Code. Before writing anything:
- ✅ READ `src/Tool.ts`, `src/tools.ts`, `src/commands.ts`, `src/skills/bundledSkills.ts`, `src/skills/installSkill.ts`, `src/skills/loadSkillsDir.ts`, `src/skills/mcpSkillBuilders.ts`.
- ✅ READ the MCP layer: `src/services/mcp/MCPConnectionManager.tsx`, `client.ts`, `config.ts`, `InProcessTransport.ts`, `SdkControlTransport.ts`, `officialRegistry.ts`, `oauthPort.ts`, `vscodeSdkMcp.ts`.
- ✅ READ the hooks layer: `src/utils/hooks/` (hookEvents.ts, hooksConfigManager.ts, hooksConfigSnapshot.ts, execAgentHook.ts, execHttpHook.ts, execPromptHook.ts).
- ✅ READ `src/plugins/` (this directory already exists — inspect what's there before adding anything).
- ✅ READ `src/entrypoints/cli.tsx` and `src/main.tsx` to understand bootstrap.
- ✅ Check `ORIGIN_MANIFEST.md` for provenance of the files you touch.
- ❌ DON'T guess MCP transport semantics from "standard MCP" knowledge — verify against this codebase's `InProcessTransport` and `SdkControlTransport`.
- ❌ DON'T assume the skill system matches upstream Claude Code. Read it.

### Rule 2: Search Before Writing
The repo has 2027+ files. Before creating any new module:
- Grep for existing MCP-server-authoring helpers, existing plugin scaffolds in `src/plugins/`, and any existing "expose RAYU as MCP server" code.
- Check `src/skills/mcpSkillBuilders.ts` first — the name suggests RAYU may already build MCP from skills; reuse it.
- Check `src/server/` (directory exists) — may already host an MCP/HTTP server skeleton.
- Check `src/services/mcp/InProcessTransport.ts` and `SdkControlTransport.ts` for an in-process MCP transport we can reuse for embedding.

### Rule 3: Follow Project Conventions
- TypeScript + Bun, ES modules, dynamic `import()` for lazy loading.
- Do NOT convert feature-gated `require()` to static `import` — `feature('FLAG')` is compile-time DCE.
- New tools → registered in `src/tools.ts` via `getTools()`.
- New commands → registered in `src/commands.ts` via `getCommands()`.
- Reuse the existing `src/services/mcp/` transport primitives rather than reinventing.

## Goal

Deliver **one integration layer** that lets RAYU be loaded as a plugin into both Claude Code and Codex, with the minimum viable surface and no duplicated logic.

## Required Plan (write the implementation plan in detail)

The plan must cover, in order:

### 1. Discovery & Audit (no code yet)
- Inventory `src/plugins/` — what already exists? Is there a partial plugin system?
- Inventory `src/services/mcp/` — what transports, client/server helpers exist? Can RAYU act as an MCP **server** (not just client)?
- Inventory `src/skills/mcpSkillBuilders.ts` — does it already build MCP tool defs from skills?
- Inventory `src/server/` — is there an HTTP/WS server skeleton we can reuse?
- Inventory `src/utils/hooks/` — could RAYU's own hook system be repurposed to *emit* Claude-Code-compatible hook events?
- Determine the gap: what is missing for RAYU to (a) expose its tools as MCP and (b) install itself into Claude Code / Codex via hooks + skills.

### 2. Integration Strategy Decision
Pick the primary integration surface and justify:
- **MCP server (PRIMARY)** — A single MCP server (`rayu-mcp-server`) exposing RAYU's tools (Read, Write, Edit, Glob, Grep, Bash, Agent, Skill, ImageGen, VideoGen, billing, telegram, etc.) works in **both Claude Code and Codex**. This is the highest-leverage path.
- **Skills (SECONDARY)** — Ship a small set of `SKILL.md` files (`/rayu`, `/rayu-billing`, `/rayu-telegram`) that document how to invoke RAYU's MCP tools and workflows from inside either host.
- **Hooks (TERTIARY)** — Ship a one-shot installer that registers RAYU as a Claude Code / Codex hook for `SessionStart` (auto-load RAYU MCP server) and `PostToolUse` (optional RAYU-side processing).
- **IDE extension (OUT OF SCOPE for v1)** — defer VS Code/JetBrains extensions; MCP + skills cover the in-agent surface.

### 3. Implementation Plan (detailed, file-by-file)

For each file, state: path, purpose, what to reuse, what to add, and how it stays DCE-safe.

#### 3.1 RAYU MCP Server (the core integration)
- `src/plugins/mcpServer/index.ts` — entrypoint that boots an MCP server over stdio (and optionally HTTP/SSE) using the existing `src/services/mcp/InProcessTransport.ts` or the official MCP SDK already used by `src/services/mcp/client.ts`.
- `src/plugins/mcpServer/toolAdapter.ts` — adapter that maps each RAYU `Tool` (from `src/tools.ts` `getTools()`) to an MCP tool definition: `name`, `description`, `inputSchema` (JSON Schema from `Tool.inputSchema`), and an `execute` handler that calls `tool.execute()` and serializes `ToolResult` content blocks back to MCP.
- `src/plugins/mcpServer/skillAdapter.ts` — adapter that exposes RAYU skills (from `src/skills/bundledSkills.ts` + `loadSkillsDir.ts`) as MCP prompts or tools, reusing `src/skills/mcpSkillBuilders.ts` if it already does this.
- `src/plugins/mcpServer/commandAdapter.ts` — adapter that exposes selected non-interactive RAYU commands as MCP tools (e.g., `/diff`, `/memory` read-only variants).
- `src/plugins/mcpServer/authGate.ts` — reuses `src/services/rayuAuth/` so MCP tool calls that need billing/auth (ImageGen, VideoGen, gateway-proxied completions) go through the same entitlement + credit path as the CLI.

#### 3.2 Host installers
- `src/plugins/installers/claudeCode.ts` — writes `.mcp.json` (or updates `~/.claude/settings.json`) to register `rayu-mcp-server` as a stdio MCP server; optionally installs RAYU's `SKILL.md` files under `~/.claude/skills/`; optionally registers a `SessionStart` hook to verify the MCP server is reachable. Must be idempotent and never clobber existing user config — read existing, merge, write back.
- `src/plugins/installers/codex.ts` — registers the same MCP server with Codex (Codex's MCP config format may differ; check whether Codex uses `.mcp.json` or its own settings file — verify before writing). Install RAYU skills into Codex's skill directory.
- `src/plugins/installers/uninstall.ts` — reverse of the above, idempotent removal.
- `src/plugins/installers/detect.ts` — detect which host (Claude Code, Codex, both, neither) is installed by looking for `claude` / `codex` CLIs and their config dirs. Used by the install command to decide what to wire.

#### 3.3 CLI commands (user-facing)
- `src/commands/rayu-plugin/install/` — interactive command that runs `detect.ts` + the right installer(s). UX: list detected hosts, let user pick which to install into, show a diff of what will change, confirm, write.
- `src/commands/rayu-plugin/uninstall/` — inverse.
- `src/commands/rayu-plugin/status/` — show which hosts RAYU is plugged into and whether the MCP server is healthy (run a `tools/list` ping against the in-process server).
- Register all three in `src/commands.ts` via `getCommands()`.

#### 3.4 RAYU-side command to run the MCP server standalone
- `src/commands/rayu-mcp-server/` (or `src/entrypoints/mcpServer.ts`) — non-interactive entrypoint that boots the MCP stdio server so Claude Code / Codex can spawn it as a child process. This is what `.mcp.json` will point to: `rayu mcp-server` (or the bundled binary path).
- Must be DCE-safe: lazy-load the MCP server module only when this entrypoint is invoked, so the main CLI bundle does not bloat.

#### 3.5 Skills shipped to hosts
- `src/plugins/skills/rayu/SKILL.md` — `/rayu` skill: explains the RAYU MCP tools available and how to invoke them from inside Claude Code / Codex.
- `src/plugins/skills/rayu-billing/SKILL.md` — `/rayu-billing`: wraps the billing/usage tools.
- `src/plugins/skills/rayu-telegram/SKILL.md` — `/rayu-telegram`: wraps the telegram bridge tools.
- These are copied into the host's skills directory at install time.

### 4. Capability & Security Boundary
- Explicitly list which RAYU tools are exposed over MCP and which are NOT (e.g., `ExitPlanMode`, `EnterWorktree`, `TestingPermission` should be excluded — they only make sense inside the RAYU TUI).
- MCP tool calls inherit the host's permission system; RAYU must NOT silently bypass it. Map RAYU permission rules onto MCP-tool-gated prompts where applicable.
- Never expose secrets. The MCP server must use the same `src/services/rayuAuth/` token handling and the same `src/services/mcp/auth.ts` patterns already in the codebase.
- Provider keys stay in the gateway (per RAYU.md). MCP tools that need AI calls route through `rayu-gateway`, exactly like the CLI does today.

### 5. Verification Plan
- `bun run typecheck`
- `bun run build` (verify the new MCP server entrypoint is DCE-safe — main bundle must not grow materially)
- `bun test` (add unit tests for `toolAdapter`, `skillAdapter`, `installers/detect`, `installers/claudeCode`, `installers/codex` — use fixture config files)
- Manual: install into a local Claude Code checkout, restart Claude Code, verify `tools/list` includes RAYU tools and `tools/call` works for at least `Read`, `Bash`, and one billing-gated tool.
- Manual: same for Codex.
- Manual: run `rayu-plugin/uninstall` and confirm the host config is restored to its pre-install state.

### 6. Risks
- **Config clobbering** — installers must merge, not overwrite, user config. Use JSON parse → merge → write with a backup.
- **Bundle bloat** — MCP server must lazy-load. Guard with `feature('RAYU_MCP_SERVER')` if needed, but prefer entrypoint-level splitting so the main `rayu` binary stays lean.
- **Transport mismatch** — verify whether `InProcessTransport` works for an external child-process MCP server, or whether we need stdio from the official MCP SDK. Decide during discovery, not after.
- **Codex config format** — verify the exact location and schema of Codex's MCP config before writing. If unknown, ship Claude Code first and gate Codex behind a TODO + clear error.
- **Permission drift** — every tool exposed over MCP must be re-checked against the host's permission semantics; do not assume RAYU's permission rules carry over.

## Acceptance Criteria

- [ ] Discovery report written (what already exists in `src/plugins/`, `src/services/mcp/`, `src/skills/mcpSkillBuilders.ts`, `src/server/`).
- [ ] `rayu mcp-server` (or equivalent entrypoint) starts an MCP server that exposes RAYU tools over stdio.
- [ ] `rayu-plugin/install` registers RAYU into Claude Code via `.mcp.json` and installs RAYU skills.
- [ ] `rayu-plugin/install` registers RAYU into Codex via Codex's MCP config (or, if format is unknown, fails clearly with a TODO and only ships Claude Code support).
- [ ] `rayu-plugin/status` reports install state and pings the in-process MCP server.
- [ ] `rayu-plugin/uninstall` cleanly reverts install changes.
- [ ] At least `Read`, `Bash`, `Glob`, `Grep`, `Edit`, `Write`, `Skill`, and one billing-gated tool work from inside Claude Code via MCP.
- [ ] `bun run typecheck`, `bun run build`, `bun test` all pass.
- [ ] No duplicated logic — adapters reuse `getTools()`, `getCommands()`, `bundledSkills`, `src/services/mcp/`, `src/services/rayuAuth/`.
- [ ] No new bundled bloat in the main `rayu` binary (MCP server is lazy-loaded from a separate entrypoint).