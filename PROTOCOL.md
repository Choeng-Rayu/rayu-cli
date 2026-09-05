# Wire Protocol Contract

Status: **decided** (Task 1). Defines the contract between the Rayu engine
(`rayu/dist/rayu.js`) and the Rayucode extension. Tasks 3–5 implement it; Task 10
tests it.

## 1. Scope

The protocol is the NDJSON message stream exchanged over the engine child
process's **stdin and stdout**:

```
extension  --stdin-->   engine     StdinMessage,  one JSON object per line
extension  <--stdout--  engine     StdoutMessage, one JSON object per line
```

Engine invocation (unchanged from today):

```
spawn(process.execPath, [
  <enginePath>,
  "--print",
  "--input-format=stream-json",
  "--output-format=stream-json",
  "--verbose",          // required: the CLI rejects stream-json output without it
])
```

`--verbose` is mandatory. stderr is diagnostic only and is routed to the log
channel — never into the conversation.

Out of scope: the host ↔ webview `postMessage` contract
(`rayucode/packages/vscode/src/webview/protocol.ts`) is a separate boundary and
is not governed by this document.

## 2. Single source of truth

`@rayu-dev/agent-protocol` **owns** the wire schemas. Both the engine and the
extension import them from that package. There is no second definition.

Schemas are Zod, wrapped in `lazySchema()` — a memoised thunk, so a schema is
**called** to obtain the Zod object:

```ts
import { StdoutMessageSchema, type StdoutMessage } from "@rayu-dev/agent-protocol";

// type extraction
type T = StdoutMessage;                          // = z.infer<ReturnType<typeof StdoutMessageSchema>>

// runtime validation
const parsed = StdoutMessageSchema().safeParse(frame);   // note the () call
```

Always `safeParse` at the process boundary. Never `parse` — a throw inside the
stdout data handler is not recoverable in a way the UI can present.

## 3. `PROTOCOL_VERSION`

A single monotonically increasing **integer**, exported from
`@rayu-dev/agent-protocol`.

```ts
export const PROTOCOL_VERSION = 1;
```

It starts at `1`. Semantic versioning is deliberately not used: there is exactly
one producer and one consumer, both built from this repository, so a single
compatibility integer is sufficient and cannot be misread.

### Bump rules

**Bump (breaking) — any change that can make an existing consumer misbehave:**

- removing or renaming a field on any wire message
- narrowing a field's type or its accepted enum values
- making an optional field required
- changing the discriminant of a message union (`type`, `subtype`)
- removing a member from `StdoutMessage` / `StdinMessage`
- changing the meaning of an existing field while keeping its shape

**Do not bump (backward compatible):**

- adding a new **optional** field
- adding a new member to `StdoutMessage` / `StdinMessage` — consumers must
  already tolerate unknown message *types* (see §6)
- widening a field's type or adding an enum value, *provided* consumers have a
  defined fallback
- comment, documentation, or internal refactoring changes

A bump is a coordinated change: the version constant, the engine's emitted value,
and the extension's accepted range all move together in one commit.

### Accepted range

The extension accepts an engine whose `protocolVersion` **equals** its own
`PROTOCOL_VERSION`. There is no compatibility window in v1, because the engine is
bundled inside the VSIX — a mismatch means the packaging step is broken, not that
a user has an old CLI. Treating it as a hard error surfaces a build defect
immediately instead of producing subtle runtime misbehaviour.

## 4. `protocolVersion` on `system/init`

The engine's first stdout message is `system` / `subtype: "init"`. It gains one
field:

```jsonc
{
  "type": "system",
  "subtype": "init",
  "protocolVersion": 1,        // NEW
  "claude_code_version": "1.6.13",
  "model": "...",
  "permissionMode": "default",
  "tools": ["..."],
  "session_id": "...",
  "cwd": "..."
  // ... existing fields unchanged
}
```

Implementation points:

- add `protocolVersion` to `SDKSystemMessageSchema` in
  `packages/agent-protocol/src/coreSchemas.ts`
- emit it from `rayu/src/utils/messages/systemInit.ts`, beside the existing
  `claude_code_version: MACRO.VERSION`

`claude_code_version` is **retained**. It is a legacy field name still emitted by
the engine and consumed today; renaming it is a breaking change with no benefit
and is out of scope.

### Absent `protocolVersion`

An engine that omits the field is pre-contract. Treat it as version `0` and fail
the compatibility check. Do not attempt best-effort operation — a legacy engine is
precisely the case where silent drift produced the original bugs.

## 5. `build-info.json`

Generated at package time into `rayucode/packages/vscode/dist/build-info.json`
and shipped inside the VSIX beside the engine.

```jsonc
{
  "engineVersion":    "1.6.13",       // rayu/package.json version at build time
  "engineFile":       "rayu.js",      // filename, relative to dist/
  "engineSha256":     "<64 lowercase hex>",
  "protocolVersion":  1,              // PROTOCOL_VERSION the extension was built against
  "gitCommit":        "<40 lowercase hex>",
  "extensionVersion": "0.2.0",        // independent of engineVersion, by design
  "builtAt":          "2026-09-05T00:00:00.000Z"  // ISO 8601 UTC
}
```

Every field is required. A missing or malformed `build-info.json` is a hard
activation error: without it neither the integrity check nor the compatibility
check can run, and proceeding would silently discard both guarantees.

## 6. Startup checks

Two independent checks, in this order.

### 6.1 Engine integrity — before the first spawn

1. Read `dist/build-info.json`.
2. Compute SHA-256 of `dist/<engineFile>`.
3. Compare, case-insensitively, against `engineSha256`.

On mismatch: **do not spawn.** Surface an actionable error naming both the
expected and computed digest (truncated to 12 hex characters for readability) and
advising reinstallation of the extension. A mismatch means the shipped artifact
was altered or the package step was inconsistent.

The digest is computed once per activation and cached for the session. Hashing a
24 MB file on every spawn would be wasteful, and the file cannot change under a
running extension without the extension being reinstalled.

### 6.2 Protocol compatibility — on `system/init`

1. Read `protocolVersion` from the `system/init` message (absent ⇒ `0`).
2. Compare with `PROTOCOL_VERSION` from `@rayu-dev/agent-protocol`.

On mismatch: apply the **fail-safe sequence** (§7) with a message naming both
versions. Do not degrade, do not feature-detect, do not continue.

## 7. Fail-safe contract for invalid frames

This is the most important behavioural requirement in this document.

**Skipping a malformed frame is forbidden.** The control protocol is
request/response correlated: a dropped frame can be the response the UI is
awaiting, leaving the panel spinning forever with no error and no way to recover.
Silent tolerance is what makes drift bugs hard to find.

When a stdout frame fails `safeParse`, or when the compatibility check in §6.2
fails, perform **all** of the following, in order:

1. **Log** — write the offending frame to the log channel, first **redacted**
   through the existing redactor, then **truncated** to a bounded length
   (2 KiB) with an explicit `…[truncated N bytes]` marker. Include the Zod issue
   path and code. Never log the raw frame: it may carry file contents, tool
   output, or credentials.
2. **Mark the session failed** — move session state to a terminal `failed` state
   carrying a machine-readable reason
   (`protocol_decode_error` | `protocol_version_mismatch`) and a human-readable
   detail string.
3. **Terminate the child** — SIGTERM, then SIGKILL after the existing grace
   period; resolve only once the OS confirms exit. A child whose output cannot be
   parsed must not keep running with filesystem and shell access.
4. **Default-deny every pending permission request** — resolve each outstanding
   request as denied. This reuses the established default-deny-on-close path;
   it is not new policy. Never leave a permission promise unsettled.
5. **Surface an actionable UI error** — a terminal error item in the panel stating
   what failed and the single recovery action (start a new session). It must not
   be a transient toast, which the user can miss while the panel appears idle.

Ordering matters: log before terminating so the diagnostic survives, and deny
permissions before surfacing the error so no approval prompt outlives the session.

### Malformed vs unknown

These are different and must not be conflated.

| Case | Meaning | Action |
|------|---------|--------|
| Frame is not valid JSON, or fails `safeParse` against `StdoutMessageSchema` | contract violation | full fail-safe sequence (§7) |
| Valid JSON, valid envelope, but an **unrecognised `type`** | forward-compatible addition | log at debug level, ignore the message, continue |

The second case is what permits additive `PROTOCOL_VERSION`-preserving changes
(§3). It applies only when the frame parses cleanly against the union's envelope
and the sole unknown is the message kind — never as a fallback for a parse
failure.

## 8. Message inventory

Owned by `@rayu-dev/agent-protocol`. Types are `z.infer<ReturnType<typeof …>>`.

### Engine → extension (stdout)

| Schema | Purpose |
|--------|---------|
| `SDKSystemMessageSchema` | `system/init` — session announcement, carries `protocolVersion` |
| `SDKAssistantMessageSchema` | complete assistant message |
| `SDKPartialAssistantMessageSchema` | streaming content delta |
| `SDKResultMessageSchema` | terminal turn result; carries `usage`, `modelUsage`, `total_cost_usd` |
| `SDKResultSuccessSchema`, `SDKResultErrorSchema` | result subtypes |
| `SDKAssistantMessageErrorSchema` | assistant-level error detail |
| `SDKControlRequest*` | engine-initiated control requests, incl. `can_use_tool` permission requests |

### Extension → engine (stdin)

| Schema | Purpose |
|--------|---------|
| user message envelope | the prompt |
| `SDKControlInitializeRequestSchema` | session initialisation |
| `SDKControlInterruptRequestSchema` | interrupt the current turn |
| `SDKControlSetPermissionModeRequestSchema` | change permission mode |
| `SDKControlSetModelRequestSchema` | change model |
| `SDKControlPermissionRequestSchema` (response) | permission decision |
| `SDKControlMcp*`, `SDKControlReloadPlugins*`, `SDKControlRewindFiles*`, `SDKControlStopTask*`, `SDKControlGetContextUsage*`, `SDKControlSeedReadState*`, `SDKControlCancelAsyncMessage*`, `SDKControlApplyFlagSettings*` | remaining control surface |

The authoritative list is `packages/agent-protocol/src/index.ts`. This table is a
reader's aid; when they disagree, the code is correct and this table is stale.
