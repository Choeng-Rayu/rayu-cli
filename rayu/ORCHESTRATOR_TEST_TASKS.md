# Orchestrator reliability: how it is tested

All 17 tasks are implemented, and every check below was run on this tree. Use this file
to re-run them. `AGENTS_ORCHESTRATOR.md` describes the design.

Run everything from the repository root:

```bash
cd /home/rayu/rayu/rayu-cli/rayu
```

Use the `./` prefix in `bun test ./test/...` paths; without it Bun sometimes reports
"did not match any test files" for new files. To keep an end-to-end scenario's temporary
project, home and config directories, set `RAYU_KEEP_HARNESS_DIR=1`.

## Unit tests, by task

| Task | What | Test files |
|---|---|---|
| 1 | Scripted model and headless harness | `scriptedProvider` |
| 2 | Role reminder on every turn | `orchestratorReminder`, `orchestratorMode`, `orchestratorCommand` |
| 3 | Plan approval modes, worker-approval-loss warning | `orchestratorPlanApproval`, `vscodePlanApproval.tsx` |
| 4 | SendMessage for the Orchestrator, planner model | `orchestratorSendMessage`, `orchestratorAgents` |
| 5 | Main thread cannot change files | `orchestratorMainThreadPolicy` |
| 6 | Shared change ledger | `agentChangeLedger` (+ `externalAgents*` as regression) |
| 7 | Contract, run state, audit, `/orchestrator-status` | `orchestratorContract` |
| 8 | Working-tree snapshots | `orchestratorGitSnapshot` |
| 9 | Spawn policy, briefing, packet progress | `orchestratorSpawnPolicy` |
| 10 | Attribution of file changes | `orchestratorAttribution` |
| 11 | Shell commands and checkpoints | `orchestratorCheckpoint`, `orchestratorRunLifecycle` |
| 12 | 3-way merge of worktree packets | `orchestratorMerge3`, `orchestratorWorktreeIntegration` |
| 13 | Verifier and its evidence | `orchestratorVerification` |
| 14 | Verification gate | `orchestratorGate` |
| 15 | Rayucode board (`task_orchestration`) | `orchestrationBoard.tsx`, `vscodeBackgroundTasks` |
| 16 | CLI board, `/orchestrator-status diff` | `orchestratorCliBoard.tsx` |
| 17 | Tool surfaces, workspace, git runner | `orchestratorToolSurfaces` |

```bash
bun test $(ls test/orchestrat*.test.ts* | grep -v E2E | sed 's|^|./|') ./test/agentChangeLedger.test.ts ./test/vscodeBackgroundTasks.test.ts ./test/originManifest.test.ts
```

Last run: 234 pass, 0 fail (with `agentModelTargets` and `subagentModelDisplay`).

## End-to-end scenarios

```bash
bun test ./test/orchestratorE2E.test.ts
```

The real engine runs headless over stream-json (Rayucode's protocol) with a scripted
model, in a throwaway git repository with the fixture `test/fixtures/orchestrator-app`.
Last run: 15 pass, three times in a row (about 40–70 s each).

1. without a contract, the Orchestrator cannot launch implementation workers
2. with a contract, workers are briefed with it, and a write outside a packet is reported
3. the Orchestrator role reaches every turn after a mid-conversation switch, and /normal leaves it
4. switching to a prompting mode while a background worker runs emits a warning frame
5. approving a plan mid-turn offers SendMessage on the very next request
6. a finished worker is continued with SendMessage and keeps its context (gate set to `soft`)
7. the Orchestrator main agent cannot change files itself, while its workers can
8. the Orchestrator publishes a contract, and /orchestrator-status shows the run
9. a dependent packet waits for its dependency, and a packet gets only one running worker
10. a worker command writing outside its packet, and a change no worker made, are both raised
11. a worktree packet is merged back; a conflict goes back to its worker, and the resolved work is merged
12. the verifier is briefed with the contract, and only a PASS backed by commands it ran is accepted
13. the gate sends an unverified "done" back to work, and opens once the verifier accepts the run
14. a full run: parallel packets, a worktree merge, a failed verification, a fix, and an accepted one
15. when verification keeps failing, the gate stops the repairs and the Orchestrator reports the failure

Tests 4, 6 and 9 depend on timing between workers; run the file a few times after
changes near them.

## Whole-repo checks

```bash
bun run typecheck:ci
bun test 2>&1 | tee /tmp/rayu-tests-now.log | grep -E '^\(fail\)' | sed -E 's/ \[[0-9.]+m?s\]$//' | sort -u
bun test --isolate vscode webBridge
bun run build
bun run build:vscode
```

Last results:
- `typecheck:ci`: no new errors (1539 known). Four baseline entries in
  `src/components/messages/AttachmentMessage.tsx` and `nullRenderingAttachments.ts` were
  replaced by the same errors with longer type previews (the attachment union gained
  `orchestrator_checkpoint`); only those signatures were swapped, nothing re-snapshotted.
- `bun test`: 4963 pass, 20 skip, 14 fail. The failures are the 13 known ones (codex
  adapter, `detectGcpProjectAndRegion`, "analyzer sees the graph tsc sees", "React
  coupling > exactly 637 engine files…", 2 "movability", 2 "type debt", 4 path-resolve)
  plus "React coupling > the two non-src react importers are tests", which fails on HEAD
  already: seven `test/vscode*.test.ts` files committed in `4216fb4` and `f0ff988` import
  React.
- `bun test --isolate vscode webBridge`: 1150 pass, 0 fail.
- `bun run build`: `dist/rayu.js`, runs (`--version`). `bun run build:vscode`:
  `dist/rayucode-2.4.1.vsix` (6.85 MB); the staged `engine.mjs` runs under node.

### Coverage of the new modules

`bun test --coverage` cannot load test files that import `SendMessageTool.ts` or
`ToolSearchTool/prompt.ts`: both import `isReplBridgeActive`, which
`src/bootstrap/state.ts` does not export (a TS2305 in the baseline; normal runs tolerate
it, coverage runs do not). Coverage was measured with a one-line export added to
`state.ts` for the measurement and removed afterwards. All 34 new modules are at 80% or
more of lines, 94% on average; the lowest are `gate.ts` (82%), `checkpoint.ts` (84%) and
`attribution.ts` (85%).

## Manual checks (CLI or Rayucode, Orchestrator mode)

1. Ask for a change across two dependent areas, for example "add a displayName field to
   the User type and show it in the UI". The Orchestrator publishes a contract, then
   launches one worker per packet with `name` set to the packet.
2. `git status`, `git stash list` and `git diff --cached` are unchanged by the run's
   snapshots; `git for-each-ref refs/rayu/` lists the run's refs, and is empty after
   `/normal` and one more message.
3. Open a worker in the background-tasks dialog (CLI) or Rayucode's background-work
   panel: the run section lists every packet; the worker shows its packet, and any
   problems or merge conflicts.
4. If a worker edits a file of another packet, its tool result says so, and
   `/orchestrator-status` lists the problem; `/orchestrator-status diff p1` shows the
   change.
5. When the workers finish, the Orchestrator should launch `verifier`. If it reports the
   work done without one, the transcript shows "Orchestrator gate for run-1 is closed"
   and the Orchestrator is sent back to work.

## Open questions

- In Full Manage and Orchestrator modes the permission check approves a tool before it
  looks at your settings' deny rules, so deny rules do not apply to those modes or their
  workers. This predates this work and is unchanged. Should deny rules always apply?
