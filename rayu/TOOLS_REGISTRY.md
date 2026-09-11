# RAYU Tools — Full Registry

> Verified directly from source on 2026-09-11. Source of truth:
> `src/tools.ts` → `getAllBaseTools()`, which the file itself calls
> "the source of truth for ALL tools" and must stay in sync with the
> claude_code_global_system_caching config. Cross-checked against every
> directory under `src/tools/` and each tool's `*_TOOL_NAME` constant for
> the exact wire name the model sees.

Tools fall into three buckets:
1. **Always included** — present in every build/session.
2. **Conditionally included** — gated by a `feature()` flag, an env var, a
   growthbook flag, or a runtime capability check.
3. **Not real end-user tools** — MCP-dynamic templates, ant-only/internal
   stubs, or test-only tools. Listed separately so nothing is silently
   omitted, but they don't appear in a normal RAYU session.

---

## 1. Always included (17)

| # | Wire name | Class | Purpose |
|---|-----------|-------|---------|
| 1 | `Agent` | `AgentTool` | Spawn subagents/collaborators (legacy wire name: `Task`) |
| 2 | `TaskOutput` | `TaskOutputTool` | Read output of a background task |
| 3 | `Bash` | `BashTool` | Execute shell commands |
| 4 | `ExitPlanMode` | `ExitPlanModeV2Tool` | Exit plan mode with an approved plan |
| 5 | `Read` | `FileReadTool` | Read file contents |
| 6 | `Edit` | `FileEditTool` | Edit an existing file |
| 7 | `Write` | `FileWriteTool` | Create/overwrite a file |
| 8 | `NotebookEdit` | `NotebookEditTool` | Edit Jupyter notebook cells |
| 9 | `WebFetch` | `WebFetchTool` | Fetch and extract content from a URL |
| 10 | `TodoWrite` | `TodoWriteTool` | Manage the session todo list |
| 11 | `WebSearch` | `WebSearchTool` | Web search |
| 12 | `GenerateImage` | `ImageGenTool` | AI image generation |
| 13 | `GenerateVideo` | `VideoGenTool` | AI video generation |
| 14 | `TaskStop` | `TaskStopTool` | Stop/kill a background task |
| 15 | `AskUserQuestion` | `AskUserQuestionTool` | Ask the user a structured question |
| 16 | `Skill` | `SkillTool` | Run an installed skill |
| 17 | `InstallSkill` | `InstallSkillTool` | Install a skill from GitHub/URL/path |
| 18 | `EnterPlanMode` | `EnterPlanModeTool` | Enter plan mode |
| 19 | `SendUserMessage` | `BriefTool` | Send a brief/notification-style message to the user (legacy wire name: `Brief`) |

**Search tools — conditional pair, but effectively always-on for RAYU:**

| Wire name | Class | Condition |
|-----------|-------|-----------|
| `Glob` | `GlobTool` | Included unless `hasEmbeddedSearchTools()` is true (only true on ant-native builds with bfs/ugrep embedded in the binary — never true for RAYU) |
| `Grep` | `GrepTool` | Same condition as above |

---

## 2. Conditionally included

### By explicit feature flag (`feature('FLAG')`, compile-time DCE)

| Wire name | Class | Feature flag |
|-----------|-------|---------------|
| `Sleep` | `SleepTool` | `PROACTIVE` or `KAIROS` |
| `CronCreate` | `CronCreateTool` | `AGENT_TRIGGERS` |
| `CronDelete` | `CronDeleteTool` | `AGENT_TRIGGERS` |
| `CronList` | `CronListTool` | `AGENT_TRIGGERS` |
| `RemoteTrigger` | `RemoteTriggerTool` | `AGENT_TRIGGERS_REMOTE` |
| `Monitor` (name TBD by module) | `MonitorTool` | `MONITOR_TOOL` |
| `SendUserFile` (name TBD by module) | `SendUserFileTool` | `KAIROS` |
| `PushNotification` (name TBD by module) | `PushNotificationTool` | `KAIROS` or `KAIROS_PUSH_NOTIFICATION` |
| `SubscribePR` (name TBD by module) | `SubscribePRTool` | `KAIROS_GITHUB_WEBHOOKS` |
| — | `OverflowTestTool` | `OVERFLOW_TEST_TOOL` (test-only) |
| — | `CtxInspectTool` | `CONTEXT_COLLAPSE` |
| — | `TerminalCaptureTool` | `TERMINAL_PANEL` |
| — | `WebBrowserTool` | `WEB_BROWSER_TOOL` |
| — | `SnipTool` | `HISTORY_SNIP` |
| — | `ListPeersTool` | `UDS_INBOX` |
| `Workflow` | `WorkflowTool` | `WORKFLOW_SCRIPTS` |
| `ExternalAgent` | `ExternalAgentTool` | `EXTERNAL_AGENTS` (the orchestrator that drives Codex/Claude Code/OpenCode/ACP agents) |

### By runtime capability / settings check

| Wire name | Class | Condition |
|-----------|-------|-----------|
| `TaskCreate` | `TaskCreateTool` | `isTodoV2Enabled()` |
| `TaskGet` | `TaskGetTool` | `isTodoV2Enabled()` |
| `TaskUpdate` | `TaskUpdateTool` | `isTodoV2Enabled()` |
| `TaskList` | `TaskListTool` | `isTodoV2Enabled()` |
| `LSP` | `LSPTool` | `process.env.ENABLE_LSP_TOOL` truthy |
| `EnterWorktree` | `EnterWorktreeTool` | `isWorktreeModeEnabled()` |
| `ExitWorktree` | `ExitWorktreeTool` | `isWorktreeModeEnabled()` |
| `SendMessage` | `SendMessageTool` | Always resolved via lazy `require()` (breaks a circular dep) — effectively always included |
| `TeamCreate` | `TeamCreateTool` | `isAgentSwarmsEnabled()` |
| `TeamDelete` | `TeamDeleteTool` | `isAgentSwarmsEnabled()` |
| `VerifyPlanExecution` | `VerifyPlanExecutionTool` | `process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'` |
| `PowerShell` | `PowerShellTool` | `isPowerShellToolEnabled()` (Windows-relevant shells) |
| `ToolSearch` | `ToolSearchTool` | `isToolSearchEnabledOptimistic()` |
| `TestingPermission` | `TestingPermissionTool` | `process.env.NODE_ENV === 'test'` (test-only, never in a real session) |

### MCP-related (always assembled, but content depends on connected servers)

| Wire name | Class | Notes |
|-----------|-------|-------|
| `ListMcpResourcesTool` | `ListMcpResourcesTool` | Lists resources from connected MCP servers |
| `ReadMcpResourceTool` | `ReadMcpResourceTool` | Reads a specific MCP resource |

### Ant-only (internal Anthropic builds — never present in a real RAYU/end-user install)

| Wire name | Class | Condition |
|-----------|-------|-----------|
| `Config` | `ConfigTool` | `process.env.USER_TYPE === 'ant'` |
| `Tungsten` | `TungstenTool` | `process.env.USER_TYPE === 'ant'` — **and its own source file says it's a stub**: *"TungstenTool absent from the leaked tree... never included in external Rayu builds"* |
| `REPL` | `REPLTool` | `process.env.USER_TYPE === 'ant'` AND `isReplModeEnabled()` — Ant-only sandboxed VM tool |
| — | `SuggestBackgroundPRTool` | `process.env.USER_TYPE === 'ant'` |

### Mutually exclusive "simple mode" set

When `CLAUDE_CODE_SIMPLE` env var is truthy, the entire list above is bypassed
and RAYU restricts itself to just: `Bash`, `Read`, `Edit` (plus `Agent` +
`TaskStop` + `SendMessage` if coordinator mode is also active). This is a
different, minimal tool surface, not an addition to the main list.

---

## 3. Not standalone/static tools (documented so nothing looks "missing")

| Name basis | Class | Why it's not in the list above |
|------------|-------|----------------------------------|
| `mcp` (template) | `MCPTool` | Not a single tool — a **template** (`buildTool({ isMcp: true, name: 'mcp', ... })`) that `services/mcp/client.ts` clones and overrides (name/description/schema/args) once per tool exposed by each connected MCP server. The actual tool count here is dynamic and depends on how many MCP servers/tools the user has connected. |
| (dynamic) | `createMcpAuthTool` (`McpAuthTool.ts`) | A factory function, not a fixed tool — produces an OAuth-flow tool instance per MCP server that needs authentication. |
| — | `SyntheticOutputTool` (`StructuredOutput`) | Explicitly filtered OUT of the normal tool list in `getTools()` (`specialTools` set) — used internally for structured-output requests, not exposed to the model as a callable tool in normal flow. |

---

## Totals

| Bucket | Count |
|--------|-------|
| Always included (core + Glob/Grep) | **19** |
| Feature-flag gated (`feature('FLAG')`) | **17** |
| Runtime/settings gated | **13** |
| MCP list/read tools (always assembled) | **2** |
| Ant-only / internal-only (never in real RAYU builds) | **4** |
| Dynamic/template (not fixed tools — count varies by MCP config) | **2** (`MCPTool` template, `McpAuthTool` factory) |
| Excluded-by-design from model-visible list | **1** (`SyntheticOutputTool`) |
| **Grand total distinct tool implementations under `src/tools/`** | **58 directories** (including ant-only, test-only, and dynamic-template ones) |
| **Realistic tool count in a default RAYU session** (always-on + typically-enabled flags, excluding ant-only/test-only/MCP-dynamic) | **~30–35**, growing with each connected MCP server |

The exact number visible in any given session depends on: build type
(ant-internal vs public RAYU), enabled feature flags (`PROACTIVE`, `KAIROS`,
`AGENT_TRIGGERS`, `EXTERNAL_AGENTS`, `WORKFLOW_SCRIPTS`, etc.), settings
(`isTodoV2Enabled`, `isWorktreeModeEnabled`, `isAgentSwarmsEnabled`, `isPowerShellToolEnabled`),
environment variables (`ENABLE_LSP_TOOL`, `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_VERIFY_PLAN`),
and how many MCP servers/tools are connected. `getToolsForDefaultPreset()`
in `src/tools.ts` is the exact runtime function that returns the live,
already-`isEnabled()`-filtered list for the current process — that is the
authoritative way to get an exact live count for any single session, since
this document is a source-code-level enumeration of everything that COULD
appear.

---

## Evidence trail (files read to verify this document)

- `src/tools.ts` — `getAllBaseTools()`, `getTools()`, `assembleToolPool()`, `getMergedTools()` (the definitive registry + assembly logic)
- Every `*_TOOL_NAME` / `*_TOOL_NAME` constant across `src/tools/**/{prompt.ts,constants.ts,toolName.ts,*.ts}` — exact wire names
- `src/tools/MCPTool/MCPTool.ts` — confirmed `name: 'mcp'` is a template, "Overridden in mcpClient.ts"
- `src/tools/McpAuthTool/McpAuthTool.ts` — confirmed factory-style, no fixed `name`
- `src/tools/TungstenTool/TungstenTool.ts` — confirmed literal stub, ant-only, never in external Rayu builds
- `src/services/mcp/client.ts` — confirmed `MCPTool` and `createMcpAuthTool` are consumed dynamically here, not statically registered
- Directory listing of `src/tools/` (58 subdirectories) cross-checked against every import in `src/tools.ts`
