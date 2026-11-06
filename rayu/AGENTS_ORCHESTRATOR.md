# RAYU Orchestrator and Agents — Architecture Summary

> Verified from source after the Orchestrator reliability work (Tasks 1–17). The
> engine code lives in `src/orchestrator/` and is shared by the CLI and Rayucode.

## Orchestrator mode

Orchestrator is a permission/UI mode with Full Manage's execution semantics, so
workers can edit files and run commands without repeated prompts. The main agent
coordinates only, and that is enforced, not just asked for: in Orchestrator mode the
main thread cannot use Edit, Write or NotebookEdit or run commands that change files
(`src/orchestrator/mainThreadPolicy.ts`, checked before mode auto-approval and before
hooks). Its workers keep auto-approval.

Ways in: Shift+Tab (CLI), the Rayucode mode control, `/orchestrator [task]`, and the
"Orchestrator" choice when approving a plan. Ways out: another mode, or `/normal`.
The role reminder is attached on the first turn after entering the mode, a short form
on every later turn, a full one every 10th, and an exit notice when the mode is left
(`src/orchestrator/reminder.ts`).

## Child agents

| Type | Role | Writes code? | Delegates? |
|---|---|---:|---:|
| `planner` | Research and a decision-complete plan with worker packets | No | No |
| `general-purpose` | Implementation, fixes, review, tests, builds — one contract packet each | Yes | No |
| `verifier` | Runs the contract's required checks and probes the seams between packets; PASS/FAIL/PARTIAL with command evidence | No (guarded) | No |
| `Explore` | Read-only discovery, when its gate is on | No | No |

`planner` and `verifier` are `SUBAGENTS` (`src/tools/AgentTool/built-in/subagents/`).
They are registered for the CLI, `-p` and the Rayucode engine (all non-SDK or
`sdk-cli` entrypoints); only the programmatic SDKs (`sdk-ts`, `sdk-py`) and
`RAYU_DISABLE_SPECIALIST_AGENTS` leave them out.

## A run, end to end

1. **Contract** (`OrchestrationContract` tool, `src/orchestrator/contract.ts`). The
   Orchestrator publishes packets (objective, owned paths, acceptance, `dependsOn`,
   isolation `shared` or `worktree`), shared interfaces with exact definitions and
   owners, and required checks (plus `orchestrator.checkCommands` from settings).
   Ownership of packets that can run at the same time must not overlap. Paths are
   relative to the **project root**: the git root, or the directory the session works in
   when the project is not in git (`runWorkspace.ts`). The root is recorded on the run,
   and the contract result names it; an absolute path inside it is converted, not
   refused. Sibling repositories are outside it, so work spanning several projects needs
   a session started above all of them or one contract per project. `*`, `?` and
   `{a,b}` are wildcards; route groups and dynamic segments (`app/(main)/`,
   `app/[slug]/`) are literal directories (`ownership.ts`). Check commands may be up to
   2,000 characters.
   Publishing again creates a new version; started packets cannot be dropped. Contract v1
   starts a run and takes a baseline of the project:
   - in git, a snapshot of the working tree (`gitSnapshot.ts`), kept under
     `refs/rayu/orchestration/<session>/<run>/` without touching the user's index, HEAD
     or stash;
   - outside git, a scan of file sizes and modification times (`fileManifest.ts`), held
     in memory. It skips `node_modules`, build output and caches, and gives up on a tree
     over 150,000 files or 8 s. Worktree packets are refused (they are git worktrees).
   `treeTracker.ts` answers "what is the project's state, and what changed" for either
   backend, so checkpoints, the verifier guard and the gate do not care which it is.
2. **Workers** (`spawnPolicy.ts`, `workerBriefing.ts`). A writing agent launched by
   the Orchestrator must name a packet. It is refused while the packet's dependencies
   have not completed, while another worker of the packet runs, while
   `orchestrator.maxParallelWriters` writers run, or in the foreground when background
   tasks exist. Each worker is briefed with the contract and its packet. The packet's
   isolation decides the worktree; worktree packets start from the baseline snapshot.
   A packet worker always runs in the background (a foreground request is not refused),
   and a worker's paths are relative to the run's project root, or to its own worktree,
   never to wherever its shell is.
3. **Checking changes** (`attribution.ts`, `shellChanges.ts`, `checkpoint.ts`). Every
   file-tool change and every writing shell command of a worker is checked against its
   packet: `outside-packet`, `unowned` and `overlap` problems are recorded, told to the
   worker in its tool result, and shown to the Orchestrator. Changes are reported, not
   blocked. At the start of each Orchestrator turn when nothing runs, a checkpoint
   compares the whole tree with the baseline and raises anything no worker accounts for
   as `untraced`, and workers that ended early as `interrupted`.
4. **Worktree packets** (`worktreeIntegration.ts`, `worktreeMerge.ts`, `merge3.ts`).
   When the worker completes, the packet is `merging`: its changes are merged 3-way
   into the main tree, all or nothing, written synchronously after checking that no
   target file changed since the plan was made, recorded for `/undo` and the review
   card, and the worktree is removed. Binary files, symlinks, submodules, LFS files,
   delete/modify and add/add are conflicts, never guesses. On conflict nothing is
   written; the worktree gets the main tree's changes with conflict markers, the
   packet is `conflicted` (its dependents wait), and the Orchestrator is told to
   continue the worker with SendMessage. After 3 failed attempts each conflict is a
   `merge-conflict` problem.
5. **Verification** (`verifierGuard.ts`, `verification.ts`). The verifier may start
   only when no packet runs or merges. It is briefed with the contract. Its shell
   commands and their outcomes are recorded, and the tree is compared before and after
   (a changed file is a `verifier-change` problem). A PASS is accepted only when every
   required check was run by the verifier and succeeded (the recorded commands are the
   evidence, a report block that says FAIL overrides), the verdict is PASS, and nothing
   changed. The verifier's own side probes that no recorded command backs up are notes
   on the record, not reasons to reject. The record says whether the project itself
   failed (`failed`) and names the tree it covers (none for an untracked project).
6. **Gate** (`gate.ts`, called from `query.ts` after stop hooks). When the
   Orchestrator's turn ends with nothing running and no worker notice waiting, the run
   is done only if every packet completed, no problem is open, and an accepted
   verification covers the current contract version and the current tree. With
   `orchestrator.verificationGate: "hard"` (default) a closed gate sends the
   Orchestrator back with the reasons (twice per unchanged set of reasons), then once
   tells it not to claim success; after `orchestrator.maxRepairRounds` verifications that
   found the project failing (counted per contract version) it asks for that report at
   once. Having said its last word for a set of reasons, the gate keeps that state: asking
   again neither repeats the reminders nor the status line. `"soft"` only reports. The status
   line reaches the REPL transcript and Rayucode (an `informational` frame).

Problems close when the change is undone (checkpoint), a new contract version gives
the file to the packet, a later merge succeeds, or the user accepts them with
`/orchestrator-status accept <id> [note]`. Leaving Orchestrator mode archives the run
and deletes its snapshot refs.

## Where the user sees it

- `/orchestrator-status` — packets, workers, worktrees, problems, verification and the
  gate. `contract` prints the contract, `accept <id> [note]` accepts a problem, and
  `diff <id>` shows the change recorded with it.
- CLI background-tasks dialog — an Orchestrator section with every packet (also those
  whose workers left the task list) and a worker's packet, conflicts and problems in
  its detail view (`src/components/tasks/Orchestration*.tsx`).
- Rayucode background-work panel — the same run as a section, badges per row and
  details (`src/vscode/webview/components/OrchestrationBoard.tsx`), from the
  `orchestration` view on each task and `task_orchestration` frames, which also update
  rows that have already finished (`src/orchestrator/orchestrationView.ts`).
- Audit history — `{plansDir}/{slug}-orchestration/run-<n>/`: `run.json`,
  `events.jsonl` (contract versions, problems with diffs, checkpoints, merges,
  verifications, gate decisions), `contract-v<N>.json|md`. Directories 0700, files 0600.

## Settings (`orchestrator` in settings.json)

| Key | Default | Meaning |
|---|---|---|
| `verificationGate` | `hard` | `hard` sends an unfinished run back to work; `soft` only reports |
| `maxRepairRounds` | 3 | Verifications under one contract version that found the project failing, before the gate stops asking for repairs. Rejections that were not the project's fault do not count |
| `maxParallelWriters` | 4 | Writing workers that may run at once |
| `checkCommands` | `[]` | Checks required in every run, in addition to the contract's |

## Source of truth

- `src/orchestrator/` — contract, run state, snapshots, spawn policy, attribution,
  checkpoints, worktree merge, verifier guard, gate, views, audit, reminder
- `src/tools/OrchestrationContractTool/` — the contract tool
- `src/tools/SendMessageTool/OrchestratorSendMessageTool.ts` — continuing workers
- `src/commands/orchestrator-status/` — `/orchestrator-status`
- `src/tools/AgentTool/AgentTool.tsx` — packet claims, briefing, worktrees, verifier hooks
- `src/tools/AgentTool/built-in/subagents/{planner,verifier}.ts` — specialist definitions
- `src/query.ts` — the gate's continuation; `src/services/tools/toolExecution.ts` —
  attribution and verifier evidence hooks
- `test/orchestrator*.test.ts`, `test/orchestratorE2E.test.ts` — unit and headless
  end-to-end scenarios (scripted model, `test/helpers/orchestratorHarness.ts`)
