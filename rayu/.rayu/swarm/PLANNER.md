The plan and shared brief are written. Here's the summary.

## Objective

Remove the redundant "Thinking" toggle from the Rayucode VS Code webview and add live **Thinking / Thought for Ns / Working** status indicators — without rendering the full thinking text and without touching the CLI or the engine↔host protocol.

## Key insight

The hard part is already done. `sessionHandle.ts:934-939` already relays `thinking_delta` to the webview as `appendPartial(kind:'thinking')`, and `webviewProtocol.ts:60` already types it. The **only** reason nothing shows is `reducer.ts:184`, which drops thinking deltas (`if (action.kind === 'thinking') return state`). No protocol or host changes are needed.

## Stack decision

Pure frontend — browser-only React webview bundle. `needs: ["frontend"]` only.

## Approach

Track **ephemeral thinking metadata in the webview reducer** (same pattern as `workspaceFiles`, which already survives `init` resyncs) and render a status indicator in the transcript. Duration is measured client-side via `Date.now()` between the first thinking delta and the first text delta. I rejected host-driven events (unnecessary protocol change) and accumulating/rendering thinking text (explicitly prohibited).

## Implementation (6 files)

1. **`reducer.ts`** — add `ThinkingState { entryId, active, startedAt, durationMs }`; start on `appendPartial kind:'thinking'`, finalize duration on `appendPartial kind:'text'` and `completeMessage`, reset on `init`. Still drops thinking text from visible answer.
2. **`InferenceControls.tsx`** — remove the thinking toggle button + `BrainIcon()` + `onSetThinking` prop; render only the effort dropdown.
3. **`Composer.tsx`** — drop `onSetThinking` prop/wiring; light toolbar tidy (bounded — no full rework).
4. **`TranscriptEntryView.tsx`** — new `ThinkingIndicator` component (Thinking… / Thought for Ns / generic pulse) + browser-safe `formatThinkingDuration`; wire into `AssistantEntry`.
5. **`App.tsx`** — remove `onSetThinking` wire; add a "Working…" status row in `Transcript` when `turnRunning && no streaming entry` (the gap before the first delta).
6. **`copilot.css`** — add `.rc-thinking` / `.rc-thinking-text` / `.rc-thinking-done` / `.rc-thinking-working`, reusing the existing `rc-pulse-dot` animation. **Zero hex literals** (existing contract).

## Critical risks to verify

- **Host wiring**: confirm `chatViewProvider.ts` maps `onPartial` → `appendPartial` postMessage for the `thinking` kind without filtering. If it's filtered on the host, that wiring must be unblocked (the one place a host change might actually be needed).
- **"Thought for Ns" persistence**: it shows only while the entry is `streaming` — confirm this window is acceptable vs. persisting into settled history.
- **Resync restarts duration**: a mid-think webview recreation resets the timer; acceptable for a transient indicator.
- No vscode test suite exists yet — verification is `typecheck` + manual + optionally a new reducer test.

Full detail is in the plan at `/home/rayu/.rayu/plans/silly-hopping-matsumoto-agent-a05efbc1a8cc13507.md` and the brief at `.rayu/swarm/shared.json`.
