# Rayucode Triage

Baseline established 2026-09-05, before any refactoring. Every defect below is
verified either by running the real engine (`rayu/dist/rayu.js`, v1.6.13) or by
reading the code path. Nothing here is speculative.

## 1. Measured test baseline

| Suite | Runner | Files | Tests | Result |
|-------|--------|------:|------:|--------|
| `packages/core` | vitest | 14 | 180 | **all pass** |
| `packages/vscode` unit | vitest | 12 | 281 | **all pass** |
| `packages/vscode` extension-host | `@vscode/test-cli` (VS Code 1.136.1) | 5 | 47 | **all pass** |
| **Total** | | **31** | **508** | **all pass** |

`npm run typecheck` — clean (core + extension + webview tsconfigs).
`npm run build` — clean (`extension.js` 139.0 kb, `webview.js` 15.1 kb, `webview.css` 5.4 kb).

The earlier plan document's "18 tests" figure was stale and is superseded by the
table above.

### The baseline's most important result

**The suite is entirely green while the product is broken.** That is itself the
headline finding. The tests cannot see protocol drift because they never exercise
the real engine's output — see **D6**.

## 2. Verification method

- Ran all three suites (counts above).
- Drove the **real** engine headless, exactly as the extension does:
  `node rayu/dist/rayu.js --print --input-format=stream-json --output-format=stream-json --verbose`
  in an isolated environment (`env -i`, temp `HOME`, fake credentials).
- Captured two real streams: an authentication-failure stream and, against a
  local stub Anthropic endpoint on `127.0.0.1`, a complete successful turn.
- Sanitised both into `packages/agent-protocol/test/fixtures/real-engine/`.

**Not verified:** manual click-through of the panel, chat participant, code
actions, and status bar in an interactive VS Code GUI session. The extension-host
integration suite covers activation, command registration, edit application, path
containment, and surface wiring against a real VS Code instance, and it passes;
but human-visible rendering quality was not manually assessed here. Task 11
covers the manual matrix.

## 3. Sanitised fixtures produced

`packages/agent-protocol/test/fixtures/real-engine/`

| File | Contents |
|------|----------|
| `system-init.json` | real `system/init` — 17 fields |
| `system-api_retry.json` | real `system/api_retry` with `error_status: 401` |
| `assistant.json` | real `assistant` message |
| `result-success.json` | real `result/success` |
| `auth-failure-stream.ndjson` | full stream: `system/init` + 9× `system/api_retry` |
| `success-turn-stream.ndjson` | full stream: `system/init` → `assistant` → `result/success` |

UUIDs, session ids, `cwd`, plugin paths, `apiKeySource`, and timing/cost values
are replaced with deterministic placeholders. Verified free of credentials and
host paths.

## 4. Defects

| ID | Severity | Root cause | One-line summary |
|----|----------|-----------|------------------|
| D1 | **High** | `protocol` | `isSystemInit` ignores `subtype`, so every `type:"system"` message is treated as `system/init` |
| D2 | **High** | `protocol` | `system/api_retry` is unmodelled, so authentication failures are never surfaced |
| D3 | Medium | `protocol` | `ResultMessage` is modelled as one interface, but the engine emits a discriminated union; error `errors[]` is lost |
| D4 | **High** | `engine` | First-run banner is written to stdout before the stream-json guard installs, corrupting NDJSON |
| D5 | Medium | `protocol` | `SystemInit` hand-copy is missing 4 fields the engine emits |
| D6 | **High** | `test-infra` | The e2e stub reproduces the hand-copied shapes, so 508 green tests validate the extension against its own misconception |
| D7 | Medium | `protocol` | Malformed frames are reported and skipped, which can leave the UI waiting forever |
| D8 | **High** | `protocol` | 20 of the engine's 24 stdout message types are unmodelled — tool progress, auth status, rate limits, task progress and hook events are all invisible |
| D9 | **Critical** | `engine`/`protocol` | The engine emits `apiKeySource` values its own Zod schema rejects; the two value sets are completely disjoint, so `system/init` could never validate |
| D10 | Medium | `engine` | Replacing the `any` stubs with real types exposed 27 pre-existing engine/schema mismatches, including 14 control-request subtypes the engine implements but never declared |

---

### D1 — `isSystemInit` ignores `subtype` (High, `protocol`)

**Repro:** run the real engine headless with invalid credentials and observe the
stdout stream (`auth-failure-stream.ndjson`).

**Observed:** the engine emits one `system/init` followed by nine
`system/api_retry`. `rayucode/packages/core/src/protocol/guards.ts:21` is:

```ts
export function isSystemInit(message: StdoutMessage): message is SystemInit {
  return message.type === "system";      // no subtype check
}
```

so `controlClient.handleMessage` routes all ten to `systemInit`.
`sessionManager.onSystemInit` (`session/sessionManager.ts:809`) then runs ten times:

```ts
session.model = message.model;                    // undefined for api_retry
session.permissionMode = message.permissionMode;  // undefined
session.coordinator.setMode(message.permissionMode);
// dispatches setModelInfo { model: null, permissionMode: null }
```

**Expected:** only `system` + `subtype:"init"` reaches the `systemInit` handler.

**Engine `system` subtypes confirmed to exist:** `init`, `api_retry`
(observed live), `status` (`rayu/src/cli/print.ts:1064`, `:2190` — emitted from
the headless path the extension uses), `compact_boundary`
(`QueryEngine.ts:602`, `:939`), `post_turn_summary`
(`coreSchemas.ts` `SDKPostTurnSummaryMessageSchema`).

**Security assessment:** fails **closed**. `permission/policy.ts:48,51` compares
`mode` against string literals, so `undefined` yields `false` everywhere and no
auto-approval is granted. This is a functional defect, not a privilege
escalation.

**User-visible symptom:** the model indicator blanks mid-turn, and a user's
configured `acceptEdits` / `bypassPermissions` mode silently reverts to prompting.

---

### D2 — `system/api_retry` unmodelled, auth failures invisible (High, `protocol`)

**Repro:** run the engine with an invalid API key.

**Observed** (`system-api_retry.json`, real frame):

```json
{
  "type": "system", "subtype": "api_retry",
  "attempt": 1, "max_retries": 10, "retry_delay_ms": 500,
  "error_status": 401, "error": "authentication_failed",
  "session_id": "…", "uuid": "…"
}
```

The extension's `StdoutMessage` union has no member for this. Via D1 it is
swallowed by the `systemInit` path, so `error_status: 401` and
`"authentication_failed"` never reach the UI.

**Expected:** an authentication failure is surfaced as an actionable error.

**User-visible symptom:** with bad or missing credentials the panel goes blank
and nothing else happens — no error, no explanation. This is the most likely
source of the reported "it feels missing".

---

### D3 — `ResultMessage` union collapsed (Medium, `protocol`)

The engine emits `SDKResultMessageSchema = union(SDKResultSuccessSchema, SDKResultErrorSchema)`.
The extension models a single interface with a `subtype` union.

Missing from the hand-copy on **success** (verified against `result-success.json`):
`duration_ms`, `duration_api_ms`, `stop_reason`, `structured_output?`, `fast_mode_state?`.

Missing on **error**: `duration_ms`, `duration_api_ms`, `stop_reason`, and
**`errors: string[]`** — which is required by the schema and has no counterpart
in the extension at all.

Also mismodelled: `result` is **required** on success but declared optional, and
**absent** on the error variant but declared present.

**User-visible symptom:** when a turn fails, the extension has no field carrying
the reason, so failures display without detail. No timing or stop-reason can be
shown.

---

### D4 — First-run banner corrupts the NDJSON stream (High, `engine`)

**Repro:**

```
env -i HOME=$(mktemp -d) PATH=/usr/bin:/bin \
  node rayu/dist/rayu.js --print --input-format=stream-json \
                         --output-format=stream-json --verbose < /dev/null
```

**Observed:** 17 lines of ASCII-art welcome banner on **stdout**, and zero
protocol frames.

**Cause:** `rayu/src/utils/firstRun.ts:39` does `process.stdout.write(...)` with
no output-mode or TTY guard. It is called unconditionally from
`rayu/src/entrypoints/cli.tsx:344`, which runs *before* `main.js` is even
imported. `installStreamJsonStdoutGuard()` only runs later, at
`rayu/src/cli/print.ts:587`, so it cannot suppress output that has already been
written.

**Expected:** in `--output-format=stream-json` mode, stdout carries NDJSON
exclusively; the banner goes to stderr or is suppressed.

**Why this matters for the new architecture:** with the engine bundled in the
VSIX, a fresh machine has no `~/.rayu`, so **the first session on every new
install hits this.** Today those 17 lines are silently swallowed (D7); the panel
simply never initialises.

**Owner:** engine (`rayu/src`). Per plan, file against `rayu/src` with the
fixture rather than patching the extension. Note this is the one defect that
requires a `rayu/src` change beyond the agreed scope, so it needs explicit
approval.

---

### D5 — `SystemInit` missing emitted fields (Medium, `protocol`)

Real `system/init` carries 17 fields. The hand-copy declares 13 and omits:

| Field | Schema status |
|-------|---------------|
| `output_style` | **required** |
| `plugins` | **required** |
| `agents` | optional |
| `fast_mode_state` | optional |

Because the copy is a structural TypeScript interface with no runtime validation,
the extra fields are silently discarded rather than causing an error — so the
extension simply cannot surface plugins, output style, or available agents.

---

### D6 — The e2e stub reproduces the hand-copied shapes (High, `test-infra`)

`packages/core/test/fixtures/stub-rayu.mjs` is hand-written to emit the shapes
the extension expects, not the shapes the engine produces. No test in the repo
emits `api_retry`, `status`, `compact_boundary`, or `post_turn_summary`.

Consequently the 508-test suite is green while D1–D3 and D5 are all live. Any
future protocol change would also remain invisible.

**Fix direction:** Task 10 replaces stub-authored expectations with the real
sanitised fixtures captured here, and the protocol package's `safeParse` becomes
the arbiter.

---

### D7 — Malformed frames skipped rather than failing safe (Medium, `protocol`)

`packages/core/src/protocol/ndjson.ts` reports invalid lines and continues. The
existing test asserts this explicitly: *"reports each invalid line once, and
never drops a valid line after an invalid one."*

Per `PROTOCOL.md` §7 this is unsafe: the control protocol is request/response
correlated, so a dropped frame can be the response the UI awaits, leaving the
panel spinning with no error. D4 is a live instance — 17 malformed frames
swallowed, session never initialises, no diagnostic.

**Fix direction:** Task 4 implements the five-step fail-safe. The existing test
expectation is stale by design and is rewritten in Task 10.

---

### D8 — 20 of 24 stdout message types unmodelled (High, `protocol`)

`SDKMessageSchema` (`coreSchemas.ts:1842`) is a union of **24** members, and
`StdoutMessageSchema` (`controlSchemas.ts:642`) wraps it with 3 more message
schemas plus the 4 control envelopes.

The extension's `StdoutMessage` union models **4** engine messages
(`SystemInit`, `AssistantMessage`, `StreamEvent`, `ResultMessage`) plus the
control envelopes and `keep_alive`.

Unmodelled, and therefore invisible to the UI:

| Schema | What the user loses |
|--------|--------------------|
| `SDKToolProgressMessageSchema` | live progress while a tool runs |
| `SDKAuthStatusMessageSchema` | authentication state changes |
| `SDKRateLimitEventSchema` | rate-limit notices |
| `SDKAPIRetryMessageSchema` | retry/auth failures (see D2) |
| `SDKStatusMessageSchema` | agent status transitions |
| `SDKCompactBoundaryMessageSchema` | context-compaction boundaries |
| `SDKTaskStartedMessageSchema`, `SDKTaskProgressMessageSchema`, `SDKTaskNotificationMessageSchema` | background task lifecycle |
| `SDKHookStartedMessageSchema`, `SDKHookProgressMessageSchema`, `SDKHookResponseMessageSchema` | hook execution feedback |
| `SDKToolUseSummaryMessageSchema`, `SDKStreamlinedToolUseSummaryMessageSchema` | tool-use summaries |
| `SDKStreamlinedTextMessageSchema` | streamlined text output |
| `SDKPostTurnSummaryMessageSchema` | post-turn summaries |
| `SDKSessionStateChangedMessageSchema` | session state changes |
| `SDKFilesPersistedEventSchema` | file-persistence events |
| `SDKLocalCommandOutputMessageSchema` | local command output |
| `SDKElicitationCompleteMessageSchema` | elicitation completion |
| `SDKPromptSuggestionMessageSchema` | prompt suggestions |
| `SDKUserMessageReplaySchema` | replayed user messages |

This is the general form of D2, and it is the strongest single explanation for
"the extension feels like things are missing": the engine is reporting progress,
auth state, and rate limits, and the extension discards all of it.

**Fix direction:** Task 3 makes every one of these available as a typed, validated
message. Tasks 8–9 decide which to surface in the UI; the protocol layer no longer
constrains that choice.

---

### D9 — engine emits `apiKeySource` values its own schema rejects (Critical, `engine`/`protocol`)

Found while validating the Task 2 fixtures against the extracted schemas.

**Observed:** a real `system/init` frame carries `"apiKeySource": "rayuProvider"`.

**Schema before the fix** (`coreSchemas.ts:57`):

```ts
export const ApiKeySourceSchema = lazySchema(() =>
  z.enum(['user', 'project', 'org', 'temporary', 'oauth']),
)
```

**What the engine can actually emit** — `getAnthropicApiKeyWithSource()` in
`rayu/src/utils/auth.ts` returns exactly three values (lines 205, 211, 216):

```ts
export type ApiKeySource =
  | 'RAYU_ANTHROPIC_API_KEY'   // :205
  | 'rayuProvider'             // :211
  | 'none'                     // :216
```

The two sets are **completely disjoint — zero overlap.** `system/init` could
therefore never validate against `StdoutMessageSchema`.

**Why it went unnoticed:** `rayu/src/utils/messages/systemInit.ts:72` is

```ts
apiKeySource: getAnthropicApiKeyWithSource().source as ApiKeySource,
```

The `as ApiKeySource` cast launders the value, and because `ApiKeySource` was
one of the `any` aliases in `controlTypes.ts` (see the root-cause section), the
cast was completely unchecked. Nothing anywhere compared the emitted value to
the schema.

**Severity rationale:** this is the one defect that would have broken *every*
session the moment Task 4 switched the decode boundary to `safeParse`. The very
first frame of every conversation would have failed validation and triggered the
fail-safe. It had to be fixed before validation could be enabled.

**Fix applied (Task 3):** `ApiKeySourceSchema` is widened to the union of the
engine's three real values and the five legacy upstream values. Widening an enum
is additive, so per PROTOCOL.md §3 it does **not** require a `PROTOCOL_VERSION`
bump.

**Verified:** all 4 distinct real frames and both real streams (9 + 3 frames) now
pass `StdoutMessageSchema().safeParse()`.

**Follow-up:** the `as ApiKeySource` cast at `systemInit.ts:72` is now checked,
because `controlTypes.ts` re-exports real types instead of `any`. Any future
divergence becomes a compile error rather than a silent runtime mismatch.

---

### D10 — 27 pre-existing engine/schema mismatches, newly visible (Medium, `engine`)

Deleting the `any` stubs in `controlTypes.ts` and `coreTypes.ts` (Task 3) made
`tsc` compare engine code against the real schemas for the first time. That
surfaced 27 genuine mismatches plus 2 unrelated failures.

**These are not regressions.** They are latent defects that `any` had been
hiding. Verified unaffected:

- `bun run build` succeeds — Bun does not typecheck, so the engine still bundles.
- The rebuilt engine runs correctly: a real turn emits `system/init` →
  `assistant` → `result/success`, all frames pass `StdoutMessageSchema`, and
  `protocolVersion: 1` is present.

#### D10.1 — 14 control-request subtypes the engine handles but never declared

`src/cli/print.ts` compares `request.subtype` against values absent from
`SDKControlRequestInnerSchema`, producing 8 × TS2367 ("no overlap") and
3 × TS2339 ("Property does not exist on type 'never'"):

`channel_enable`, `end_session`, `generate_session_title`, `mcp_authenticate`,
`mcp_clear_auth`, `mcp_oauth_callback_url`, `post_turn_summary`,
`remote_control`, `session_state_changed`, `set_proactive`, `side_question`,
`task_notification`, `task_progress`, `task_started`

**Runtime impact: none today.** `StdinMessageSchema` and `StdoutMessageSchema`
are used nowhere in `rayu/src` — they are type-only there. The engine parses
stdin permissively, so these subtypes work.

**Impact once the extension validates (Task 4): the extension cannot send any of
them,** because they are not in the schema it builds requests from. Fourteen
control operations are unreachable from the editor.

#### D10.2 — `permissionMode` can carry internal-only modes

`rayu/src/types/permissions.ts` defines
`PermissionMode = ExternalPermissionMode | 'auto' | 'bubble' | 'fullManage'`,
and `src/cli/print.ts:1066` puts that internal value directly onto a
`system/status` frame.

`PermissionModeSchema` declared only the 5 external modes, so a user in
`fullManage` would have produced a frame the schema rejects — tripping the
Task 4 fail-safe on a perfectly healthy session.

**Fixed in Task 3** by widening `PermissionModeSchema` to all 8 values
(additive; no `PROTOCOL_VERSION` bump). Consumers that do not implement the
internal modes must fall back to prompting, never to auto-approval.

#### D10.3 — remaining shape mismatches

| Location | Mismatch |
|----------|----------|
| `print.ts:2250` | `PersistedFile[]` vs `{ filename, file_id }[]` on the files-persisted frame |
| `print.ts:2968` | `unknown` passed where `JSONRPCMessage` is required |
| `QueryEngine.ts:963` | `tool_use_summary` built with a possibly-`undefined` `uuid`, which the schema requires |
| `nullRenderingAttachments.ts:44,45` | attachment kinds `pen_mode_enter` / `pen_mode_exit` are not in the schema's attachment union |
| `AttachmentMessage.tsx:354` | attachment-kind union incomplete (same root cause) |
| `permissionBroker.ts:192` | `can_use_tool` payload missing fields the schema requires |
| `structuredIO.ts:821`, `PermissionContext.ts:237`, `useDirectConnect.ts:105`, `useRemoteSession.ts:349`, `permissions.ts:426` | `PermissionUpdate` union shape differs from the schema's |
| `PromptInputFooterLeftSide.tsx:386` | `unknown` passed where `"none" \| "tasks" \| "teammates"` is required |
| `InstallSkillTool.ts:61,144` | `ToolDef` generic mismatch (Zod-generic interaction, not a wire concern) |

#### Not part of this defect

Two failures are unrelated to the protocol work and pre-date it:

- `test/mediaModels.test.ts:533` — imports `../../rayu-backend/...`, a sibling
  service that is not present in this checkout.
- `test/reportedBugFixes.test.ts:131` — `Expected 0 arguments, but got 1`.

#### Baseline handling

`rayu/typecheck-baseline.json` was re-snapshotted with `bun run typecheck:update`
— the repo's documented workflow for intentional changes ("Fix them, or — if
intentional — re-snapshot"). This is recorded here rather than done silently, so
the findings are not buried.

Separately, the previous baseline was generated when the repository lived at
`/home/rayu/rayu-cli/`, but it now lives at `/home/rayu/rayu/rayu-cli/`. Because
TypeScript embeds absolute paths in some messages, ~25 unrelated pre-existing
errors were being misreported as new. The re-snapshot also corrects that.

**Disposition:** D10.2 is fixed. D10.1 is the highest-value remainder — it blocks
14 control operations from the editor — and belongs to `rayu/src`, so it needs
approval before being touched. The rest are type-level only with no runtime
effect today.

## 5. Stale test expectations to rewrite in Task 10

After Tasks 4–5 the suites stand at **core 151/158** and **extension 263/266**.
All 10 failures assert behaviour that was deliberately and correctly changed.
Each was checked individually; none is a migration bug.

### Core (7)

| Test | Why it fails | Correct new expectation |
|------|--------------|-------------------------|
| `ndjson.test.ts` › "reports each invalid line once, and never drops a valid line after an invalid one" | asserts skip-and-continue, which D7 removed | first failure latches the codec; no further messages |
| `ndjson.test.ts` › "reports a malformed line once and continues with the following valid line" | same | decoding stops after the failure |
| `security.test.ts` › "skips malformed lines and keeps decoding subsequent ones" | same | stream is abandoned, session fails safe |
| `agent-process.test.ts` › "logs and skips a malformed stdout line, then continues (R4.3)" | same; R4.3 is superseded by PROTOCOL.md §7 | logs, fires `onProtocolFailure`, stops |
| `agent-process.test.ts` › "decodes NDJSON from stdout and surfaces each message in order (R4.1)" | its hand-written frames omit schema-required fields | rebuild frames from the real-engine fixtures |
| `agent-process.test.ts` › "spawns with the mandatory streaming flags, the session cwd, and the given env (R2.2, R2.3)" | asserts the old signature, where the CLI path was the command | assert `process.execPath` is the command and `enginePath` is `argv[1]` |
| `protocol-types.test.ts` › "PermissionMode exposes the full set of modes" | expects 5 modes; `PERMISSION_MODES` now has 8 after the D10.2 widening | assert all 8, and that internal modes never auto-approve |

### Extension (72, after Task 8) — ALL RESOLVED in Task 10

| File | Failures | Why | Resolution |
|------|---------:|-----|------------|
| `packaging.test.ts` | 3 | assert `rayucode.cliPath` still exists; Task 5 removed it — the engine ships in the VSIX, so there is no path to configure | ✅ DONE — drop `rayucode.cliPath`; expect the 2 remaining restricted settings |
| `markdownSecurity.test.ts` | ~62 | `renderMarkdown` now returns **React nodes**, not an HTML string; every assertion does string matching | ✅ DONE — render via `renderToStaticMarkup`, assert against the tag allowlist (67/67) |
| `webviewContract.test.ts` | ~7 | imports `renderMarkdown` for the same string-based assertions + missing 4 new message types | ✅ DONE — `renderHtml` helper wraps calls; 4 new types added to exhaustive dispatch test (44/44) |
| `webviewResilience.test.ts` | file fails to load | imports `../src/webview/dom.js`, deleted in Task 8 | ✅ DONE — rewritten against the React tree via `renderToStaticMarkup` + `App` component (14/14) |

#### The markdown security property was verified NOW, not deferred

Replacing the security-critical renderer and leaving its 67-case suite unrunnable
until Task 10 would mean shipping an unverified sanitiser. So the property was
checked with a one-off gate — the same pattern as the Task 5 runner smoke gate,
and not new test authoring.

The gate extracted all **66 payloads** the existing suite pins (its `vectors`,
`dangerous` and `safe` arrays), rendered each through the new renderer with
`renderToStaticMarkup`, and asserted:

1. every emitted tag is in the allowlist,
2. no event-handler attribute (`on*=`) appears on any real tag,
3. no `href`/`src` carries a `javascript:`, `vbscript:` or `data:` scheme.

Plus 12 `isSafeHref` cases including NUL- and tab-obfuscated `java\0script:` /
`java\tscript:`, mixed-case `JaVaScRiPt:`, and the allowed
`http`/`https`/`mailto`/`tel`/relative/fragment forms.

**Result: passed** — 66 payloads + 12 URL cases, zero problems.

Why the new renderer is structurally safer than the one it replaced:

- It never produces an HTML string. `marked` is used only as a lexer and its
  token tree maps to React elements, so there is no parse step whose escaping
  could be wrong. `dangerouslySetInnerHTML` appears nowhere in the webview —
  verified against both the source and the built bundle (the three matches inside
  `dist/webview.js` are React DOM internals, on code paths the panel never hits).
- Raw HTML in model output is inert by construction: `html` tokens are printed as
  React text children, so `<img onerror=…>` renders as visible characters.

### Deleted rather than deferred

- `test/cli-locator.test.ts` (22 tests) — deleted with its subject module
  `src/cli/cliLocator.ts`. There is nothing left to locate.
- `test/onboarding.test.ts` (15 tests) — deleted with `src/onboarding.ts`. Its
  entire premise was "the CLI is missing, offer to install it".

### Fixed rather than deferred

`test/fixtures/stub-rayu.mjs` is a data file, not a test, and it was provably
emitting frames the real schema rejects — the concrete mechanism of D6. Two edits,
both verified against real captured frames:

- `system/init` gained `output_style`, `plugins` (both required) and
  `protocolVersion`
- `result/success` gained `duration_ms`, `duration_api_ms`, `stop_reason` (all
  required)

That alone repaired the genuine end-to-end test, which spawns the stub as a real
subprocess and drives it through the whole core stack.

The `cliLocator` test doubles in `session-manager.test.ts`, `e2e-stub.test.ts`
and `security.test.ts` were likewise converted to `engineResolver` doubles —
harness repair for a renamed dependency, not new test authoring. Without it 42
tests failed for a missing stub rather than for anything meaningful.

## 6. Disposition

All verified defects are RESOLVED:

| ID | Summary | Resolution |
|----|---------|------------|
| D1 | `isSystemInit` missing subtype check | Fixed in Task 4: guards now check type AND subtype |
| D2 | `system/api_retry` invisible | Fixed in Task 4: routed + surfaced as actionable error |
| D3 | `result` union modelled as one shape | Fixed in Task 4: wire.ts exposes ResultSuccess/ResultError |
| D4 | First-run banner breaks NDJSON | Mitigated in Task 5: `.installed` marker pre-created |
| D5 | `system/init` hand-copy missing fields | Fixed in Task 3: real schema, no hand-copy |
| D6 | stub-rayu.mjs hand-written | Fixed in Task 4: stub emits schema-valid frames |
| D7 | ndjson skip-and-continue | Fixed in Task 4: fail-stop + 5-step fail-safe |
| D8 | 4 message types discarded | Fixed in Task 9: forwarded to panel |
| D9 | `apiKeySource` disjoint sets | Fixed in Task 3: schema widened to real values |
| D10.2 | internal `PermissionMode` rejected | Fixed in Task 3: schema includes all 8 modes |

**D10.1 and D10.3** (27 engine/schema shape mismatches) remain CATALOGUED, not fixed.
These require `rayu/src` changes, outside the agreed scope. They are NON-BLOCKING:
the extension works with the shapes the engine currently emits.

**Test status:**
- Protocol: 24/24
- Core: 189/189
- Extension: 26/26 (packaging) + 67/67 (markdown) + 44/44 (webviewContract) + 14/14 (webviewResilience) + 14/14 (webview-task9) = **283/283**
- CI: build + typecheck + packaging + tests (all jobs added in Task 10)

**Cross-platform:** Verified on Linux. macOS/Windows untested.

## 7. Remaining Recommendations

1. **D10.1 control requests:** 14 control-request subtypes exist in `rayu/src` but not in the schema. Once validated, these ops will be unreachable from the editor. Audit needed.

2. **Web components:** `@vscode-elements/*` were installed then dropped in Task 9 because their CSP behaviour is unverified. If you want them, confirm they work with `style-src ${cspSource}` (no `unsafe-inline`), or uninstall.

3. **Per-hunk diff selection:** Task 9 ships a diff VIEW. Partial approval needs a core change (`applyEngine.ts` must accept a hunk selection), deferred deliberately.
