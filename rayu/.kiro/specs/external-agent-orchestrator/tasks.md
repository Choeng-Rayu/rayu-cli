# RAYU External-Agent Orchestrator — Remaining Task Spec

Companion to the approved implementation plan. This file captures everything
discovered during Tasks 1–2 so later sessions do not re-research protocol details
or rediscover repo conventions.

**Testing constraint (user instruction):** Tasks 3–18 are implementation only.
No test files. Verify each with typecheck + build + the stated manual demo.
The entire test suite is written once, at the end, in Task 19.

---

## Status

| Task | State |
|---|---|
| 1. Core types + feature gate | **Done, verified** |
| 2. Persistence + lease locks | **Code written, NOT yet verified** — verification interrupted |
| 3–19 | Not started |

### Task 1 — delivered
- `src/externalAgents/core/types.ts` — branded `ProviderId` / `AgentInstanceId` /
  `AgentSessionId` / `TaskRef`; `formatAgentInstanceId` + `parseAgentInstanceId`
  (`<provider>:<slot>`, throws if provider contains `:`); `ControlLevel` string
  union + `CONTROL_LEVEL_RANK` + `compareControlLevel` / `atLeastControlLevel`;
  `CapabilityAxis` (terminal, messages, sessions, process, permissions) +
  `AgentCapabilities` + `noCapabilities()`; `OPERATION_REQUIREMENTS` +
  `AgentOperation` + `supportsOperation()`; `AdoptionClass`; `Durability`;
  four state axes + `isTerminalAgentState` / `isDispatchableAgentState`;
  `toRayuTaskStatus()`; `TurnKind` + `isSteerableTurnKind()`;
  `AgentStatusSnapshot`; 12-variant `ExternalAgentEvent` union + envelope;
  `isTerminalEventType()`.
- `src/tasks/ExternalAgentTask/guards.ts` — `ExternalAgentTaskState`,
  `isExternalAgentTask()`.
- `src/externalAgents/featureGate.ts` — `isExternalAgentsEnabled()`,
  `getExternalAgentsDisabledReason()`, `RAYU_EXTERNAL_AGENTS` kill-switch.
- Modified `src/Task.ts` (+`'external_agent'`, +`external_agent: 'x'`) and
  `src/tasks/types.ts` (both unions).

### Task 2 — written, pending verification
- `src/externalAgents/persistence/paths.ts` — `~/.rayu/agents/<provider>/<slot>/`
  layout (**not** `<provider>:<slot>` — `:` is illegal in Windows paths);
  `isSafePathSegment()` allowlist + Windows reserved-device-name rejection;
  `getAgentDir/getAgentRecordPath/getAgentSessionsPath/getAgentTasksPath/getAgentEventsDir/getLeasesDir`.
- `src/externalAgents/persistence/schemas.ts` — zod schemas via `lazySchema`,
  each enum array carrying `satisfies readonly <Union>[]` so adding a union
  variant without updating the schema is a compile error; `AgentRecord`,
  `AgentSessionsRecord`, `AgentTasksRecord`, `AgentTransport`, `AgentForensics`.
- `src/externalAgents/persistence/agentStore.ts` — atomic temp→rename JSON IO at
  mode 0600 in 0700 dirs; `RecordReadResult` separating `missing` from
  `corrupt`; `writeAgentRecord` / `readAgentRecord` / `patchAgentRecord` /
  `pruneAgentRecord` / `listAgentInstanceIds` / `listAgentRecords`;
  **`classifyLiveness()`** (pure) and `sweepStaleAgents()`;
  `registerAgentExitCleanup()`; sessions/tasks accessors.
- `src/externalAgents/persistence/workspaceLease.ts` — `O_EXCL` per-file write
  leases; `tryAcquireWriteLease` / `releaseWriteLease` /
  `releaseAllLeasesForAgent` / `listWriteLeases` / `sweepStaleLeases` /
  `registerLeaseCleanup`.

**Remaining for Task 2:** run the verification protocol below; fix anything it
surfaces; then run the demo (write three agent records, kill one owner PID,
confirm the sweep reclaims exactly that one; acquire → contend → stale-recover a
lease).

Two design decisions in Task 2 worth preserving:
- **The sweep never unlinks.** It marks agents `dead` and records forensics.
  `concurrentSessions.ts` does unlink stale PID files, but only behind a strict
  `/^\d+\.json$/` guard added after lenient `parseInt` prefix-parsing caused
  silent user data loss (anthropics/claude-code#34210). Deletion here is a
  separate explicit call, and forensics survive for Task 16's recovery path.
- **`classifyLiveness` returns `unknown`, not a guess.** A `process-durable`
  agent adopted over HTTP has no pid RAYU ever learned (only an endpoint probe
  can answer — Task 9), and on WSL `~/.rayu` may be shared with a Windows-native
  install where PIDs are not probeable. Guessing `dead` there would orphan a
  working agent's task.

---

## Verification protocol (apply to every task)

```bash
bun run typecheck:ci   # gate: src/externalAgents/ must not appear in output
bun run build          # gate: succeeds; gated code absent from dist/rayu.js
```

- The total "NEW type error" count **flaps 27/29/30 non-deterministically** in
  this working tree. That flapping is pre-existing and confined to
  `src/services/compact`, `contextCollapse` barrels, `main.tsx`, `query.ts`,
  `InstallSkillTool`, `utils/dxt`, `utils/attachments`, `utils/messages`, and two
  test files. **Do not chase the count.** The real gate is that
  `src/externalAgents/` and `src/tasks/ExternalAgentTask/` never appear.
- Confirm new files are actually being checked:
  `npx tsc --noEmit -p tsconfig.typecheck.json --listFiles | grep externalAgents`
- `bun run build` is byte-deterministic, but absolute sizes drift because the
  tree is dirty. Measure impact with a stash/pop A/B on your own files only.
- Confirm DCE: `grep -c "externalAgents\|EXTERNAL_AGENTS" dist/rayu.js` → `0`
  until Task 18 flips the flag.

**Working-tree caution:** 40 files were already modified and several untracked
(`src/telegram/telegramChatGuard.ts`, `src/tools/FileEditTool/coerce.ts`,
`src/utils/model/imageCapability.ts`, `src/utils/toolInputRepair.ts`, 5 test
files) **before** this work began. They are not ours. Never stash broadly or
revert them.

---

## Repo conventions (non-negotiable)

- **Zero TS `enum` in the codebase.** Use string unions + a rank map. Also
  required for JSON-stable persistence.
- Branded types: `string & { readonly __brand: 'X' }`.
- `SessionId` in `src/types/ids.ts` already means *RAYU's own* session. External
  agent sessions use `AgentSessionId`.
- **`feature()` DCE requires the positive-ternary pattern:**
  `return feature('X') ? real : fallback`. A negative guard
  (`if (!feature('X')) return`) does **not** eliminate literals or imports.
  Documented in `src/bridge/bridgeEnabled.ts`. (`docs/feature-gating.md` is
  referenced by that file but does not exist in this fork.)
- Gated modules are reached via `require()` behind `feature()`, never a static
  import (`src/tools.ts` pattern).
- Files < 800 lines, functions < 50 lines, no `console.log`, explicit types on
  public APIs. Use `logForDebugging` from `src/utils/debug.js`.

## Reuse map (AGENTS.md Rule 2 — do not duplicate)

| Need | Existing code |
|---|---|
| `~/.rayu` root | `getRayuConfigHomeDir()` — `src/utils/envUtils.ts` |
| PID liveness | `isProcessRunning()` — `src/utils/genericProcessUtils.ts` |
| Cleanup on exit | `registerCleanup()` — `src/utils/cleanupRegistry.ts` |
| Lazy zod | `lazySchema()` — `src/utils/lazySchema.ts` |
| JSON | `safeParseJSON` (memoized `Object.assign` const), `parseJSONL` — `src/utils/json.ts`; `jsonStringify` — `src/utils/slowOperations.ts` |
| Errors | `errorMessage`, `getErrnoCode`, `isFsInaccessible` — `src/utils/errors.ts` |
| Platform / WSL | `getPlatform()` — `src/utils/platform.ts` |
| Process registry precedent | `src/utils/concurrentSessions.ts` |
| Lease lock precedent | `src/utils/cronTasksLock.ts` |
| Task framework | `src/Task.ts`, `src/utils/task/framework.ts`, `TaskOutput.ts`, `diskOutput.ts` |
| Model notification | `enqueuePendingNotification` — `src/utils/messageQueueManager.ts` |
| SDK events | `enqueueSdkEvent` — `src/utils/sdkEventQueue.ts` |
| XML tags | `src/constants/xml.ts`; `escapeXml` — `src/utils/xml.ts` |
| Emitter base | `src/ink/events/emitter.ts` (also re-exported from `src/ink.ts`) |
| Permission dialog bridge | `src/utils/swarm/leaderPermissionBridge.ts`; `ToolUseConfirm` — `src/components/permissions/PermissionRequest.tsx` |
| Terminal attach pattern | `src/utils/terminalPanel.ts` |
| Pane backends (tmux + iTerm2) | `src/utils/swarm/backends/` |
| Host detection + config paths | `src/plugins/installers/detect.ts` (`getCodexHomeDir`, `getClaudeCodeConfigDir`, `whichSync`) |
| Worktrees | `src/utils/worktree.ts`, `src/tools/EnterWorktreeTool` |
| RAYU-as-MCP-server (already ships) | `src/plugins/mcpServer/`, `src/plugins/installers/` |

---

## Task 3 — Event Bus and Normalizer

**Files:** `src/externalAgents/core/eventBus.ts`, `eventSinks.ts`,
`eventLog.ts`, `normalizer.ts`

Typed in-process emitter built over `src/ink/events/emitter.ts`. Fan out to the
three sinks that already exist — do **not** replace them:

1. `AppState` (UI) via `setAppState`.
2. `enqueuePendingNotification({ value, mode: 'task-notification', priority, agentId })`
   so foreign-agent output reaches RAYU's model.
3. `enqueueSdkEvent(...)` for SDK consumers.
4. Plus an append-only JSONL log in `getAgentEventsDir(id)`; read back with
   `parseJSONL` from `src/utils/json.ts`.

Define the `EventNormalizer` interface every adapter implements
(`normalize(raw: unknown): ExternalAgentEvent[]`), plus a `seq` allocator that
is monotonic per agent instance.

**Gotchas learned from `LocalShellTask.tsx`:**
- A `<status>` tag in a task notification is a **terminal** signal to
  `print.ts`; an unknown value falls through to `completed` and falsely closes
  the task for SDK consumers. Progress pings must be **statusless**.
- `priority: 'next'` vs `'later'` matters — bash completions use `'later'`,
  monitor uses `'next'`. Pick per event type deliberately.
- Call `abortSpeculation(setAppState)` when task state changes, as
  `enqueueShellNotification` does.

**Demo:** inject a synthetic `AgentMessageEvent` and `ToolStartedEvent`; observe
them in the RAYU transcript, the SDK stream, and the JSONL log simultaneously.

## Task 4 — Agent state machine and admission control

**File:** `src/externalAgents/core/stateMachine.ts` — pure, no I/O.

Legal transitions across the four axes
(`starting → connecting → ready → working → idle → stopped`, plus
`waiting`/`interrupted`/`failed`/`dead`), and:

```ts
resolveAdmission(snapshot, capabilities, request):
  { action: 'dispatch' | 'steer' | 'queue' | 'resume' | 'relaunch' | 'reject', reason: string }
```

Must encode: `idle`/`ready` → dispatch; `working` + `messages: full` +
`isSteerableTurnKind(activeTurn.kind)` → steer; `working` otherwise → queue;
`waiting` → resume; `interrupted` → resume; `failed` → relaunch;
`dead` → relaunch; missing capability → reject with the naming error.

**Demo:** scripted driver prints the transition table and shows a `working` +
steer-unsupported agent queueing instead of clobbering the active turn.

## Task 5 — AgentManager, registries, adapter registry

**File:** `src/externalAgents/core/AgentManager.ts` (+ `adapterRegistry.ts`,
`stubAdapter.ts`)

Owns Agent Registry, Session Registry, Adapter Registry. Capability-gated
dispatch via `assertCapability(agent, operation)` built on
`OPERATION_REQUIREMENTS`, throwing errors that name the shortfall:
`"codex:agent_01 supports messages at level 'message'; steer requires 'full'"`.
Register a `StubAdapter` so the manager is exercisable before real adapters land.

**Demo:** start/list/inspect/stop the stub; `steer` on a `message`-level stub
returns the actionable capability error.

## Task 6 — Codex adapter

**Files:** `src/externalAgents/transport/jsonRpcStdio.ts`,
`src/externalAgents/adapters/codex/{CodexAdapter.ts,normalize.ts,protocol.ts}`

Verified protocol facts (from `codex-rs/app-server/README.md`):

- JSON-RPC 2.0, newline-delimited, **`"jsonrpc":"2.0"` omitted on the wire**.
- Transports: `--stdio` (default), `--listen ws://IP:PORT` (experimental),
  `--listen unix://[PATH]` defaulting to
  `$CODEX_HOME/app-server-control/app-server-control.sock`, `--listen off`.
  `codex app-server proxy [--sock PATH]` bridges that socket to stdio — this is
  the adoption path.
- Handshake: `initialize` `{ clientInfo: { name, title, version }, capabilities: { experimentalApi?, optOutNotificationMethods? } }`
  → then an `initialized` notification. Any request before that → `"Not initialized"`;
  a second `initialize` → `"Already initialized"`. Use `clientInfo.name = 'rayu_cli'`.
- Threads: `thread/start` (`model`, `cwd`, `approvalPolicy`, and **either**
  `sandbox` **or** `permissions` — never both), `thread/resume`
  (`{ threadId, excludeTurns: true }` preferred; full hydration is deprecated and
  emits `deprecationNotice`), `thread/fork`, `thread/loaded/list`.
- Turns: `turn/start { threadId, input: [{ type:'text', text }], clientUserMessageId? }`
  → `{ turn: { id, status, items, error } }`.
  `turn/steer { threadId, input, expectedTurnId }` — **`expectedTurnId` is
  required**, and review / manual-compaction turns reject it with
  `ActiveTurnNotSteerable { turnKind }`. `turn/interrupt { threadId, turnId }`
  → `{}` then `turn/completed` with `status: 'interrupted'`.
- Notifications to normalize: `thread/started`, `thread/status/changed`
  (`notLoaded` | `idle` | `systemError` | `active`), `turn/started`,
  `turn/completed`, `item/started`, `item/completed`,
  `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`,
  `item/reasoning/textDelta`, `item/commandExecution/outputDelta`,
  `item/fileChange/patchUpdated`, `turn/diff/updated`, `turn/plan/updated`,
  `error`, `warning`, `configWarning`.
- Item types: `userMessage`, `agentMessage`, `reasoning`, `commandExecution`,
  `fileChange`, `mcpToolCall`, `webSearch`, `imageGeneration`,
  `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`, `plan`,
  `collabToolCall`, `subAgentActivity`, `sleep`, `imageView`,
  `functionCallOutput`.
- Approvals are **server-initiated requests**:
  `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
  Reply `{ decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }`
  (object forms exist for execpolicy / network amendments). Server then emits
  `serverRequest/resolved { threadId, requestId }`. Route to the Task 11 broker
  seam; stub until then.
- Errors: `-32001 "Server overloaded; retry later."` is **retryable** — back off
  with jitter. `-32601` = unsupported method (degrade the capability, don't
  crash). `codexErrorInfo` values include `ContextWindowExceeded`,
  `UsageLimitExceeded`, `rateLimitExceeded`, `HttpConnectionFailed`,
  `ResponseStreamDisconnected`, `Unauthorized`, `SandboxError`,
  `ActiveTurnNotSteerable`.
- `codex app-server generate-json-schema --out DIR [--experimental]` produces a
  version-exact schema bundle — use it to generate Task 19 fixtures.

Capabilities: all axes `full`; `adopt: full` via control socket;
`durability: 'process-durable'` when using `--listen unix://`, else
`'session-bound'`.

**Demo:** `/agent start codex` → assign "summarize this repo" → normalized events
stream → `turn/interrupt` cancels mid-flight.

## Task 7 — Claude Code adapter

**Files:** `src/externalAgents/adapters/claudeCode/{ClaudeCodeAdapter.ts,normalize.ts}`

Verified flags (`docs.claude.com/en/docs/claude-code/cli-reference`):
`-p/--print`, `--input-format stream-json`, `--output-format stream-json`,
`--verbose` (required with stream-json), `--replay-user-messages` (requires
stream-json both directions), `--include-partial-messages`,
`--session-id <uuid>`, `--resume`, `--fork-session`,
`--permission-prompt-tool <mcpTool>`, `--mcp-config`, `--strict-mcp-config`,
`--max-turns`, `--max-budget-usd`, `--allowedTools` / `--disallowedTools` /
`--tools`, `--append-system-prompt`, `--model`, `--permission-mode`, `--add-dir`.

Key semantics: with `--input-format stream-json`, a message sent while Claude is
working **stays queued and runs as its own turn**. That is precisely
"steer = queue", so `messages` is `full` for send but the state machine must
still choose `queue` rather than `steer`.

Capabilities: `messages: full`, `sessions: full`, `terminal: observe`,
`process: full`, `permissions: full` (via `--permission-prompt-tool` pointed at
`src/plugins/mcpServer/`), `adoption: observable`,
`durability: 'session-bound'`. **`adopt` is genuinely impossible** — no listener.
Observation path is `~/.claude/projects/*.jsonl` (honor `CLAUDE_CONFIG_DIR`).

**Security:** never inject `--dangerously-skip-permissions`.

**Demo:** same assign/stream flow; `/agent inspect` prints the matrix showing
`adopt ✗` rather than failing at call time.

## Task 8 — OpenCode adapter

**Files:** `src/externalAgents/adapters/opencode/{OpenCodeAdapter.ts,httpClient.ts,sse.ts,normalize.ts}`

Hand-rolled `fetch` + SSE. **No `@opencode-ai/sdk` dependency.**

Verified endpoints (`opencode.ai/docs/server`):
- `opencode serve [--port 4096] [--hostname 127.0.0.1]`. The TUI also runs a
  server, on a **random** port unless `--port`/`--hostname` are given — port
  discovery is required for adoption.
- Auth: HTTP basic via `OPENCODE_SERVER_PASSWORD`, username from
  `OPENCODE_SERVER_USERNAME` (default `opencode`). Never log these.
- `GET /global/health` → `{ healthy, version }`; `GET /event` SSE (first event
  `server.connected`).
- `POST /session`, `GET /session`, `GET /session/status`, `GET /session/:id`,
  `DELETE /session/:id`, `POST /session/:id/fork`, `POST /session/:id/abort`,
  `GET /session/:id/diff`, `GET /session/:id/todo`.
- `POST /session/:id/message` (waits) vs `POST /session/:id/prompt_async`
  (204, no wait — prefer this), `POST /session/:id/command`,
  `POST /session/:id/shell`.
- `POST /session/:id/permissions/:permissionID { response, remember? }`.
- TUI drive: `POST /tui/append-prompt`, `/tui/submit-prompt`,
  `/tui/clear-prompt`, `/tui/execute-command`, `/tui/show-toast`.
- `GET /doc` → OpenAPI 3.1 spec; capture as Task 19 fixture source.

Capabilities: `terminal: full` (can drive the real TUI), `adopt: full`,
`durability: 'process-durable'`. Bind/connect `127.0.0.1` only.

**Demo:** with `opencode` already open elsewhere, `/agent adopt opencode`
connects, injects a prompt that visibly appears and submits in that TUI, and
streams the response back into RAYU.

## Task 9 — Discovery and adoption classifier

**File:** `src/externalAgents/core/discovery.ts`

Extend `src/plugins/installers/detect.ts` (reuse `whichSync`,
`getCodexHomeDir`, `getClaudeCodeConfigDir` — do not duplicate) with liveness
probes: Codex control socket existence, OpenCode `GET /global/health` port
probe, process scan for terminal-only instances. Combine with
`classifyLiveness()` from Task 2. Classify `managed` / `adoptable` /
`observable` / `unknown`.

**Demo:** `/agent discover` renders the honest table — Claude Code as
`OBSERVABLE` with `Attach ✓ / Send ✗ / Adopt ✗` plus a `[Restart under RAYU]`
action.

## Task 10 — Terminal Manager

**Files:** `src/externalAgents/terminal/{tmuxSession.ts,attach.ts,index.ts}`

Per-agent tmux session on a RAYU-private socket
(`rayu-agent-<sessionId.slice(0,8)>`, mirroring `getTerminalPanelSocket()`).
Reuse the `terminalPanel.ts` sequence exactly: `instances.get(process.stdout)`,
`enterAlternateScreen()`, `tmux attach-session`, `exitAlternateScreen()` in a
`finally`, with `Alt+J` bound to `detach-client` and `registerCleanup` killing
the tmux server. `attach(agentId)` must re-attach an existing session, never
create a duplicate. Use `PaneBackend` for split views. Windows/tmux-less falls
back to the normalized event view.

**Demo:** `/agent attach codex:agent_01` drops into the live Codex TUI mid-work;
`Alt+J` returns with the agent still running.

## Task 11 — Permission Broker

**File:** `src/externalAgents/core/permissionBroker.ts`

Adapters declare participation. Requests translate into RAYU's existing
`ToolUseConfirm` queue via `leaderPermissionBridge`; decisions translate back
per protocol (Codex `{ decision }`, OpenCode
`POST /session/:id/permissions/:id`, Claude Code via
`--permission-prompt-tool`). Agents that cannot participate report
`permissions: 'none'` in `/agent inspect`. Never fake centralized control.

**Demo:** Codex requests a shell command; RAYU shows its normal permission
dialog attributed to `codex:agent_01`; `accept` / `acceptForSession` / `decline`
all round-trip.

## Task 12 — Workspace Manager

**File:** `src/externalAgents/core/workspaceManager.ts`

Consume `FileChangedEvent` into per-agent `changedFiles`; acquire Task 2 write
leases; detect overlap; provision a git worktree per agent for parallel
assignments via `src/utils/worktree.ts`. Remember leases are **advisory
detectors**, worktrees are the actual remedy.

**Demo:** overlapping work assigned to Codex and Claude Code simultaneously →
RAYU isolates each into its own worktree, reports the isolation plan, and flags
the overlap it prevented.

## Task 13 — Commands

**Files:** `src/commands/agent/`, `src/commands/task/`

Follow the `src/commands/rayu-plugin/rayu-plugin.ts` subcommand-parsing pattern.
`/agent list|start|stop|attach|chat|assign|inspect|adopt|discover|logs` and
`/task list|inspect|cancel|retry`. `/agent chat` must consult admission control
before sending. Register both in `src/commands.ts` `getCommands()`.

**Demo:** start two agents, assign different tasks, chat with one while the other
works, inspect, attach, cancel, stop.

## Task 14 — ExternalAgent tool

**File:** `src/tools/ExternalAgentTool/ExternalAgentTool.ts`

Model-facing tool (`start`, `assign`, `status`, `interrupt`, `result`) through
the identical `AgentManager` path as the commands, registering an
`external_agent` task so results return via `<task_notification>`. Use
`ImageGenTool` as the structural reference. Register in `src/tools.ts`
`getTools()` behind `feature('EXTERNAL_AGENTS')` with the existing `require()`
pattern — **never** a static import.

**Demo:** "have Codex fix the failing test while you review the config" → RAYU
delegates autonomously, the task appears in the background indicator, and the
result lands in RAYU's turn.

## Task 15 — Orchestration policies

**File:** `src/externalAgents/core/policies.ts`

Declarative `parallel`, `sequential`, `reviewAfter`, `retry`, `fallback`,
`race` over the Task Manager, with Task 12 worktree isolation for `parallel`.

**Demo:** Codex ∥ Claude implement → Reviewer → tests; plus a fallback chain
where Claude failing escalates to Codex, then to the user.

## Task 16 — Crash, exit, and recovery

**File:** `src/externalAgents/core/recovery.ts`

Implement the `durability` contract: exit semantics for `session-bound` vs
`process-durable`; startup reconnect for socket/HTTP/tmux agents;
relaunch-and-resume (`--resume` / `thread/resume` / session GET) for
session-bound; and the crash-forensics decision (recover / restart / resume /
mark-failed / ask-user). The `AgentForensics` schema and `classifyLiveness()`
already exist from Task 2 — build on them. **Preserve native session identity
across restarts.**

**Demo:** `kill -9` a Codex process mid-task, restart RAYU → it detects the
crash, reports forensics, and resumes the *same* native thread.

## Task 17 — ACP protocol adapter

**Files:** `src/externalAgents/adapters/acp/{AcpAdapter.ts,normalize.ts}`

Reuse `transport/jsonRpcStdio.ts` from Task 6. Implement `initialize`
capability negotiation mapped onto `AgentCapabilities`, `session/new`,
`session/load`, `session/prompt`, `session/update` → normalized events,
`cancel`, and permission requests. Config-driven registration so any ACP binary
works with no new code. **Target stable ACP v1** (v2 is draft); do not couple the
core to ACP.

**Demo:** register an arbitrary ACP-compliant agent by command path alone and
drive it end-to-end via `/agent assign`.

## Task 18 — Integration sweep, flag enable, docs

Verify every registration point: `src/tools.ts`, `src/commands.ts`, `TaskType`
in `src/Task.ts`, `src/tasks/types.ts`, attach keybinding in
`src/keybindings/`. Add `'EXTERNAL_AGENTS'` to `ENABLED_FEATURES` in
`scripts/macroValues.ts`. Regenerate `ORIGIN_MANIFEST.md` via
`scripts/origin-manifest.ts` (this is **ORIGINAL** Rayu work). Document the
subsystem and its honest capability matrix in `AGENTS.md`.

**Demo:** clean `bun run build` ships the feature; `/agent` and `/task` appear in
`/help`; no orphaned modules.

## Task 19 — Consolidated test suite (ALL testing happens here)

One suite under `test/` (existing convention: `test/*.test.ts`, run by
`bun test`). Cover:

- Capability resolution, `ControlLevel` ordering, `supportsOperation`.
- State machine transitions and `resolveAdmission`, including the Codex
  non-steerable-turn rule.
- Event normalization for all four protocols from **recorded wire fixtures**
  (Codex: `generate-json-schema`; OpenCode: `GET /doc`).
- Persistence: round-trip, atomic write, `missing` vs `corrupt`, stale-PID
  sweep, `classifyLiveness` across all four axis combinations including WSL and
  unknown-pid cases.
- Leases: acquire, contend, stale-recover, race resolution, `sweepStaleLeases`.
- Path safety: traversal and Windows-reserved-name rejection in
  `isSafePathSegment`.
- Discovery classification.
- Adapter integration against fake Codex JSON-RPC, fake `stream-json`, and fake
  OpenCode HTTP+SSE servers.
- Orchestration policy graphs; crash-and-resume.

Target the 80%+ coverage floor from `AGENTS.md` for `src/externalAgents/`.

**Demo:** `bun test` green, coverage ≥ 80% for `src/externalAgents/`.

---

## Cross-cutting risks

- **Security.** Foreign agents inherit real credentials and execute code. Pass
  explicit env, never blanket `process.env`. Never inject
  `--dangerously-skip-permissions` or `approvalPolicy: "never"`. OpenCode's
  server is network-exposed — `127.0.0.1` only, honor
  `OPENCODE_SERVER_PASSWORD`, never echo credentials into logs or events.
- **Protocol drift.** Codex's surface is large and partly experimental. Pin to
  the documented stable subset; on `-32601` degrade the capability rather than
  crashing. Ignore unknown notification methods.
- **No PTY.** There is no `node-pty` in the tree and `ShellCommand` exposes no
  stdin. Do not add a PTY dependency: terminal surface rides on tmux, control
  surface rides on stdio/socket/HTTP.
- **Earlier cut.** Tasks 1–8 form a coherent shippable slice if scope needs
  trimming.
