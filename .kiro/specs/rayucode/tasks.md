# Implementation Plan: rayucode

## Overview

This plan implements the `rayucode` VS Code extension as a two-package monorepo following the design in #[[file:design.md]] and requirements in #[[file:requirements.md]].

The work proceeds bottom-up: first the editor-agnostic `packages/core` (process lifecycle, NDJSON protocol, session state, permission and edit logic — zero `vscode` imports), then `packages/vscode` (the concrete `VSCodeAdapter`, webview, activation, manifest, and `.vsix` packaging). Pure, input-varying logic (codec, ordering reducer, streaming assembler, permission policy, edit isolation, conflict detection, redaction, request correlation) is validated by the 12 property-based tests defined in the design; VS Code-bound surfaces are validated by example/integration tests.

The extension spawns the existing `rayu` binary headless with `--print --input-format=stream-json --output-format=stream-json --verbose` and drives it over the bidirectional NDJSON control protocol. It does not reimplement the agent.

Property tests use fast-check, run a minimum of 100 iterations, and each is tagged with a comment in the form `Feature: rayucode, Property {n}: {property_text}`.

## Tasks

- [ ] 1. Set up two-package monorepo and shared protocol types
  - [x] 1.1 Scaffold the workspace and `packages/core` package
    - Create a monorepo root with workspaces and the `packages/core` directory structure (`src/`, `test/`)
    - Configure `packages/core/package.json` with NO `vscode` dependency (build-enforceable invariant for R13.5), TypeScript, and fast-check as a dev dependency
    - Configure `tsconfig.json`, build script, and a test runner that executes with no `vscode` package present
    - _Requirements: 13.1, 13.5_

  - [x] 1.2 Define protocol message and control envelope types in core
    - Create TypeScript types for inbound `StdoutMessage` union (`system/init`, `assistant`, `stream_event`, `result`, `control_request`, `control_response`, `control_cancel_request`, `keep_alive`) and outbound `StdinMessage` union (`user`, `control_request`, `control_response`, `keep_alive`, `update_environment_variables`), grounded in the schemas cited in #[[file:design.md]]
    - Define `ControlRequestInner` subtypes used by rayucode (`can_use_tool`, `interrupt`, `set_model`, `set_permission_mode`, `mcp_status`, `initialize`, `get_context_usage`) and the `PermissionToolOutput` allow/deny payload
    - Define `PermissionMode` enum (`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`) and `SessionState`/`ConversationItem` shapes
    - _Requirements: 2.2, 5.2, 5.3, 7.3, 12.5_

  - [x] 1.3 Define the `EditorAdapter` interface and supporting data types in core
    - Declare the `EditorAdapter` interface with every operation from the design: `showAgentPanel`, `applyFileEdits`, `readFileSnapshot`, `getWorkspaceContext`, `isPathIgnored`, `registerCommand`, `getSecret`, `storeSecret`, `log`, `showActionableMessage`, `getSetting`
    - Define `FileEditChange`, `FileEditPlan`, `ApplyResult`, `FileSnapshot`, `WorkspaceContext`, `ContextOptions`, `AgentPanelHandle`, and `Disposable` types
    - _Requirements: 13.3, 13.4_

- [ ] 2. Implement the NDJSON codec
  - [x] 2.1 Implement `NdjsonCodec` encode/decode
    - Implement `encode(message)` → JSON + `\n` (relying on `JSON.stringify` to escape embedded newlines so a record is never split)
    - Implement streaming `decode`: accumulate chunks, split on `\n`, JSON-parse each complete line, buffer trailing partial line until next chunk or EOF
    - Implement the `onMalformedLine(raw, error)` callback path: a line that fails to parse is reported once and decoding continues with subsequent lines
    - _Requirements: 4.1, 4.3_

  - [x]* 2.2 Write property test for NDJSON round-trip
    - **Property 1: For any sequence of protocol messages, encoding each message to an NDJSON line and decoding the concatenated stream yields exactly the original sequence of messages in the same order.**
    - **Validates: Requirements 4.1**

  - [x]* 2.3 Write property test for decoder robustness and continuation
    - **Property 2: For any byte stream containing a mix of valid JSON lines and invalid lines in any order, the decoder emits exactly the valid messages in order, reports each invalid line once via the malformed-line callback, and never drops a valid line that follows an invalid one.**
    - **Validates: Requirements 4.3**

  - [x]* 2.4 Write property test for chunk-boundary invariance
    - **Property 3: For any NDJSON byte stream and any partition into arbitrary chunks, feeding the chunks in order produces the same message sequence as feeding the whole stream at once.**
    - **Validates: Requirements 4.1, 4.3**

- [ ] 3. Implement the control protocol client with request/response correlation
  - [x] 3.1 Implement `ControlProtocolClient` inbound dispatch and outbound requests
    - Dispatch inbound messages by `type`: `system/init` (model, tools, mcp_servers, slash_commands, skills, permissionMode, session_id), `assistant`, `stream_event`, `result`, `control_request` with `subtype: 'can_use_tool'`, `control_response`, and error subtypes / assistant `error` field
    - Implement host-initiated outbound `control_request` correlation using a `Map<request_id, PendingRequest>`: `interrupt`, `set_model`, `set_permission_mode`, `mcp_status`, `initialize`
    - On stream close or `control_cancel_request`, reject every still-pending request exactly once
    - Emit typed events the SessionManager/webview consume (assistant message, partial delta, result/usage, permission request, control error)
    - _Requirements: 3.2, 3.6, 4.4, 7.2, 7.3, 7.4, 11.2, 15.2_

  - [x]* 3.2 Write property test for request/response correlation integrity
    - **Property 12: For any interleaving of host-initiated control requests and their responses, each response resolves exactly the pending request bearing the same `request_id`, and a stream close or cancel rejects every still-pending request exactly once.**
    - **Validates: Requirements 7.3, 7.4, 15.2**

  - [x]* 3.3 Write unit tests for control-request serialization
    - Test concrete serialization of `interrupt`, `set_model`, `set_permission_mode`, and `mcp_status` requests
    - Test that an error `control_response` resolves/rejects the correlated pending request and surfaces error text
    - _Requirements: 3.6, 7.3, 15.2_

- [x] 4. Implement the conversation reducer and streaming assembler
  - [x] 4.1 Implement the message-ordering reducer and streaming assembly
    - Assign a monotonic receive-sequence number to each protocol message as the codec yields it; render conversation items strictly in receive order
    - Append `stream_event` deltas to the in-progress message by `parent`/sequence; mark the in-progress item complete exactly when the terminal `result` is processed
    - Carry `usage`/`total_cost_usd`/`modelUsage` from the `result` for usage display
    - _Requirements: 3.3, 3.4, 4.1, 4.2, 4.4_

  - [x]* 4.2 Write property test for message ordering preservation
    - **Property 4: For any sequence of inbound protocol messages, the conversation reducer renders items in the same relative order in which the messages were received from the stream.**
    - **Validates: Requirements 3.4**

  - [x]* 4.3 Write property test for streaming assembly equals final message
    - **Property 5: For any assistant turn expressed as a sequence of `stream_event` deltas followed by a terminal `result`, the text assembled by appending the deltas equals the final assembled content, and the in-progress item is marked complete exactly when the `result` is processed.**
    - **Validates: Requirements 4.1, 4.2**

- [x] 5. Implement the permission coordinator
  - [x] 5.1 Implement `shouldAutoApprove` policy and the `PermissionCoordinator`
    - Implement the pure function `shouldAutoApprove(mode, toolCategory) -> boolean` matching the design's mode/category table (`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`)
    - On inbound `can_use_tool`: auto-approve with an `allow` `control_response` when the policy says so; otherwise surface the request (tool name, parameters, and exact bash command string) for user decision
    - Build allow (`{ behavior: 'allow', updatedInput }`) and deny (`{ behavior: 'deny', message }`) responses; forward tool-action results and running indicators to history
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 10.1, 10.2, 10.3, 10.4_

  - [x] 5.2 Implement default-deny-on-close for pending permissions
    - When a session closes, issue exactly one `deny` `control_response` for every still-pending permission request, and ensure all deny responses are issued before the agent process is terminated
    - _Requirements: 5.5_

  - [x]* 5.3 Write property test for permission default-deny on session close
    - **Property 6: For any set of pending permission requests at the moment a session is closed, every pending request receives exactly one `deny` response, and all deny responses are issued before the agent process is terminated.**
    - **Validates: Requirements 5.5**

  - [x]* 5.4 Write property test for auto-approval policy
    - **Property 7: For any permission mode and any tool-action category, the coordinator auto-approves without prompting if and only if `shouldAutoApprove(mode, category)` is true; otherwise it surfaces a prompt (or denies under `dontAsk`).**
    - **Validates: Requirements 5.4, 10.4**

  - [x]* 5.5 Write property test for allow response carrying approved input
    - **Property 8: For any approved permission request, the emitted `control_response` has `behavior: 'allow'` and its `updatedInput` equals the input the user approved.**
    - **Validates: Requirements 5.2**

- [x] 6. Implement the edit proposal model and apply logic
  - [x] 6.1 Implement `EditProposalModel` and a pure edit-apply engine
    - Convert approved/aggregated Write/Edit tool actions into a `FileEditPlan` with per-change `baseContentHash` captured when the proposal was generated
    - Implement a pure apply engine over an in-memory file model that classifies a change as a conflict when the current content hash differs from `baseContentHash`, applies each file independently, and records `applied`/`failed`/`conflicts` in `ApplyResult`
    - Ensure partial-failure isolation: a failure on one file leaves all other files (applied or not-yet-attempted) untouched
    - _Requirements: 6.1, 6.3, 6.5, 6.6_

  - [x]* 6.2 Write property test for file-edit partial-failure isolation
    - **Property 9: For any file-edit plan in which an arbitrary subset of changes fails to apply, every non-failing change's target ends in its intended post-edit state and every file not in the plan is unchanged, regardless of which subset failed.**
    - **Validates: Requirements 6.6**

  - [x]* 6.3 Write property test for conflict detection on stale base
    - **Property 10: For any edit change whose target's current on-disk content hash differs from the change's captured base hash, the apply step classifies that change as a conflict and does not modify the file without explicit confirmation.**
    - **Validates: Requirements 6.3**

- [x] 7. Implement the credential redaction filter
  - [x] 7.1 Implement the redaction filter in front of panel and log sinks
    - Implement a pure filter that, given a configured credential set, removes any matching value from text routed to the Agent_Panel and to the log channel, in any form including masked or partial forms
    - Wire the filter so both the panel sink and the `log` channel pass through it
    - _Requirements: 8.4, 15.5_

  - [x]* 7.2 Write property test for credentials never appearing in surfaced output
    - **Property 11: For any protocol message or stderr line whose content includes a value matching the configured credential set, the text routed to the Agent_Panel and to the log channel does not contain that value in any form, including masked or partial forms.**
    - **Validates: Requirements 8.4, 15.5**

- [ ] 8. Checkpoint - core pure logic complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement CLI location and the agent process
  - [x] 9.1 Implement `CliLocator`
    - Resolve the executable in order: explicit `rayucode.cliPath` setting (via adapter `getSetting`), then system PATH
    - On success, run `<path> --version`, capture the reported version, and compute `belowMinimum` against `MINIMUM_RAYU_VERSION`; return a `CliResolution`
    - No executable resolved ⇒ no version comparison performed
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_

  - [x]* 9.2 Write unit tests for `CliLocator`
    - Test resolution ordering (setting wins over PATH), version capture, and version-compare boundaries (at, above, below minimum), and that no version message path is taken when nothing is resolved
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_

  - [x] 9.3 Implement `AgentProcess`
    - Spawn the child with `--print --input-format=stream-json --output-format=stream-json --verbose`, `cwd` = session workspace root, inheriting `HOME`/`RAYU` resolution so the default `~/.rayu` config dir and configured MCP servers are used (never overriding the config dir)
    - Pipe `stdout` through `NdjsonCodec` into the protocol client; pipe `stderr` line-buffered into the `lifecycle`/`error` log channel only (never the conversation)
    - Emit a `processExited` event with code/signal on exit; implement `terminate()` to send SIGTERM, await exit with a bounded grace period, escalate to SIGKILL, and resolve only after confirmed exit
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.1, 8.2, 11.1, 11.3_

  - [x]* 9.4 Write unit tests for `AgentProcess`
    - Using a stub child, test that spawn flags/cwd/env are correct, stderr routes only to the log channel, exit emits code/signal, and `terminate()` resolves only after confirmed exit
    - _Requirements: 2.2, 2.3, 2.4, 2.6_

- [x] 10. Implement session state and the session manager
  - [x] 10.1 Implement `SessionStore`
    - Maintain in-memory ordered history per active session that survives panel close/reopen (lives in host, not webview); allocate fresh independent history on new session
    - Record the latest `session_id` seen on any SDK message as the resumable identifier
    - Provide a `restoreHistory` snapshot that yields empty history (rather than throwing) if reconstruction fails
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x]* 10.2 Write unit tests for `SessionStore`
    - Test history retention across reopen, new-session independence, resumable-id capture, and empty-on-failure restore
    - _Requirements: 12.1, 12.3, 12.4, 12.5_

  - [x] 10.3 Implement `SessionManager` wiring core components together
    - Compose `AgentProcess`, `NdjsonCodec`, `ControlProtocolClient`, `PermissionCoordinator`, `EditProposalModel`, redaction filter, and `SessionStore` into a per-session unit; expose the single entry point the Editor_Host calls (open panel, submit prompt, interrupt, select model, approve/deny permission, approve edit/confirm conflict, new session, close session)
    - Invoke all editor operations exclusively through the injected `EditorAdapter` (no editor-specific dependency); build prompts with `WorkspaceContext` (workspace root, opt-in active file/selection, ignore-aware), sending without root when it cannot be determined
    - Implement unresponsiveness timeout: if no protocol activity advances a pending prompt within `rayucode.unresponsiveTimeoutMs`, surface an unresponsive notice with interrupt/restart; surface spawn failure with retry, unexpected-exit with restart, auth failure, and model-unavailable handling
    - On session close, drive default-deny of pending permissions before terminating the process
    - _Requirements: 2.1, 2.5, 3.2, 3.5, 3.6, 4.4, 5.5, 7.1, 7.3, 7.4, 8.3, 9.1, 9.2, 9.3, 9.4, 9.6, 11.2, 11.5, 13.4, 15.1, 15.2, 15.4_

  - [x]* 10.4 Write unit tests for `SessionManager` against a fake `EditorAdapter`
    - Test prompt+context assembly (root present/absent, opt-in file/selection, ignored-file exclusion), close-session ordering (deny before terminate), and that no `vscode` symbol is referenced
    - _Requirements: 9.1, 9.2, 9.6, 5.5, 13.1, 13.4_

- [ ] 11. Checkpoint - core integration complete and builds with no vscode dependency
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Scaffold `packages/vscode` and the VS Code adapter
  - [x] 12.1 Scaffold `packages/vscode`
    - Create `packages/vscode` with a `package.json` depending on both `packages/core` and `vscode`, build/bundle scripts, and a `tsconfig.json`
    - _Requirements: 13.2_

  - [ ] 12.2 Implement `VSCodeAdapter` non-edit operations
    - Implement `showAgentPanel` (via `createWebviewPanel`), `getWorkspaceContext`/`isPathIgnored` (via `vscode.workspace`), `registerCommand`, `getSecret`/`storeSecret` (via `context.secrets`), `log` (via `OutputChannel`), `showActionableMessage` (via `window.showX` with action buttons), and `getSetting` (via `getConfiguration`)
    - _Requirements: 1.2, 2.5, 8.4, 9.1, 9.3, 9.4, 9.6, 13.2, 13.3, 15.1, 15.3_

  - [ ]* 12.3 Write integration tests for `VSCodeAdapter` non-edit operations
    - In the extension host against a temp workspace: secret storage round-trip, command registration, workspace-context queries, and ignore-aware path checks
    - _Requirements: 8.4, 9.6, 13.2_

  - [ ] 12.4 Implement `VSCodeAdapter.applyFileEdits` and `readFileSnapshot`
    - Read the current on-disk snapshot per change, compare hash to `baseContentHash`, and report mismatches as `conflicts` without applying; apply each file via a single `WorkspaceEdit` (open-buffer aware) and create new files with `WorkspaceEdit.createFile` at the workspace-relative path
    - Apply each file independently so a failure records in `failed` and leaves other files untouched
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 12.5 Write integration tests for edit application
    - In the extension host against a temp workspace: modify an open buffer, create a new file, detect a conflict on a stale base, and verify partial-failure isolation across multiple files
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 13. Implement the Agent_Panel webview
  - [ ] 13.1 Build the webview view and message-passing contract
    - Implement the bundled webview with strict `postMessage` contracts — host→webview (`appendPartial`, `addMessage`, `completeMessage`, `showPermissionRequest`, `showToolAction`, `updateToolStatus`, `showUsage`, `setModelInfo`, `setMcpStatus`, `showError`, `restoreHistory`) and webview→host (`submitPrompt`, `interrupt`, `approvePermission`, `denyPermission`, `approveEdit`, `confirmConflict`, `selectModel`, `openModelList`, `newSession`)
    - Render assistant text as sanitized Markdown with monospaced fenced code blocks and File_Edit_Proposals as per-file before/after diffs, under a strict CSP that loads no remote content; render strictly in host-assigned receive order
    - Show in-progress indicator + interrupt while a turn is active; render permission requests (with exact bash command), tool-action output + running indicator, usage, current provider/model, MCP status/failures, and errors
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.7, 4.1, 4.2, 4.4, 5.1, 5.6, 6.1, 7.1, 7.2, 7.4, 10.1, 10.2, 10.3, 11.2, 11.5, 12.2, 15.2_

  - [ ]* 13.2 Write unit tests for the webview message contract
    - Test serialization/handling of each host→webview and webview→host message type and that render order follows the host-assigned sequence
    - _Requirements: 3.4, 5.1, 7.2_

- [ ] 14. Implement extension activation, manifest, and command wiring
  - [ ] 14.1 Author the extension manifest contributions
    - Declare commands `rayucode.openPanel` and `rayucode.addSelectionToPrompt`; settings `rayucode.cliPath`, `rayucode.includeActiveFile`, `rayucode.includeSelection`, `rayucode.permissionMode`, `rayucode.diagnosticLogging`, `rayucode.unresponsiveTimeoutMs`; `engines.vscode` minimum version; and lazy `activationEvents` (`onCommand:rayucode.openPanel`, `onCommand:rayucode.addSelectionToPrompt`)
    - _Requirements: 14.1, 14.3, 14.6_

  - [ ] 14.2 Implement `extension.ts` activate/deactivate
    - On activate, construct `VSCodeAdapter`, inject it into `SessionManager`, and register commands so `rayucode.openPanel` is invocable from the command palette; catch and log a command-registration failure and continue activation
    - Implement `rayucode.addSelectionToPrompt` to insert a reference to the selected text and its file path into the panel input
    - On `deactivate` (window close), terminate every `AgentProcess` the extension started
    - _Requirements: 2.7, 9.5, 14.4, 14.5_

  - [ ]* 14.3 Write integration tests for activation and commands
    - In the extension host: open-panel command registers and is invocable, registration-failure path logs and continues, add-selection inserts a reference, and deactivate terminates spawned processes
    - _Requirements: 2.7, 14.4, 14.5_

- [ ] 15. Integration smoke test and packaging
  - [ ] 15.1 Implement an end-to-end smoke test with a stub rayu
    - Spawn a stub `rayu` that emits canned NDJSON (`system/init`, `stream_event` deltas, `result`, a `can_use_tool` control_request) and verify end-to-end rendering, permission round-trip, and usage display through the real Core_Integration + `VSCodeAdapter`
    - _Requirements: 3.2, 3.3, 4.1, 4.2, 5.1, 5.2_

  - [ ]* 15.2 Write config/packaging smoke tests and produce the `.vsix`
    - Assert the manifest declares the required commands, settings, and `engines.vscode`; verify `vsce package` produces a single installable `.vsix` artifact
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 16. Final checkpoint - ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they are test sub-tasks (property, unit, integration). Core implementation tasks are never marked optional.
- Each of Properties 1–12 from #[[file:design.md]] is implemented by exactly one property-based test (tasks 2.2, 2.3, 2.4, 3.2, 4.2, 4.3, 5.3, 5.4, 5.5, 6.2, 6.3, 7.2), placed next to the code it validates so errors are caught early.
- Property tests use fast-check with a minimum of 100 iterations and are tagged `Feature: rayucode, Property {n}: {property_text}`. The edit-isolation and conflict properties (9, 10) test the pure apply engine against an in-memory file model so they stay pure and cheap and run with no `vscode` dependency present (reinforcing R13.5).
- Each task references the specific requirement clauses it implements for traceability.
- Checkpoints (tasks 8, 11, 16) ensure incremental validation at package boundaries.
- The core package (`packages/core`) is built and tested with no `vscode` package present, making R13.5 a build-enforceable invariant.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "9.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "3.1", "4.1", "5.1", "6.1", "7.1", "9.2"] },
    { "id": 4, "tasks": ["3.2", "3.3", "4.2", "4.3", "5.2", "5.4", "5.5", "6.2", "6.3", "7.2", "9.3"] },
    { "id": 5, "tasks": ["5.3", "9.4", "10.1"] },
    { "id": 6, "tasks": ["10.2", "10.3"] },
    { "id": 7, "tasks": ["10.4", "12.1"] },
    { "id": 8, "tasks": ["12.2", "12.4", "13.1", "14.1"] },
    { "id": 9, "tasks": ["12.3", "12.5", "13.2", "14.2"] },
    { "id": 10, "tasks": ["14.3", "15.1"] },
    { "id": 11, "tasks": ["15.2"] }
  ]
}
```
