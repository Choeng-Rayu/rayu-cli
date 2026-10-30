# Orchestrator reliability: test tasks

This file lists the checks for the Orchestrator work, task by task. Run them in the order given and send back the report described at the end. Tasks 1–3 were verified when they were written. Tasks 4 and 5 were written without running anything, so expect their first run to find problems.

Run everything from the repository root:

```bash
cd /home/rayu/rayu/rayu-cli/rayu
```

## Baselines (measured before this work)

| Check | Baseline |
|---|---|
| `bun test` (full suite) | 4266 pass, 21 skip, 13 fail, 3 errors. The 13 failure names are in `/tmp/rayu-baseline-fails.txt` |
| Type errors (`tsc`) | 1539 errors, saved in `/tmp/rayu-tsc-baseline.txt` |

`/tmp/rayu-tsc-diff.sh` runs `tsc` and prints only error signatures that are not in the baseline (line numbers are ignored). If `/tmp` was cleared, use `bun run typecheck` and report the total error count instead.

Use the `./` prefix in `bun test ./test/...` paths. Without it, Bun sometimes reports "did not match any test files" for new files.

To debug a failing end-to-end test, set `RAYU_KEEP_HARNESS_DIR=1`. The test then keeps its temporary project, home and config directories, and prints nothing extra.

---

## Task 3: plan approval names the mode it sets, and workers losing approval are announced

Already verified: 644 related tests passed, the e2e test passed, and there were 0 new type errors. Re-run it once, because Tasks 4 and 5 changed shared files.

```bash
bun test ./test/orchestratorPlanApproval.test.ts ./test/vscodePlanApproval.test.tsx ./test/vscodePermissions.test.ts ./test/webBridgePlanApprovalMode.test.ts ./test/vscodeWebBridgeApprovals.test.ts ./test/vscodeWebviewDispatch.test.ts
```

Expected: all pass (15 + 13 + 10 + 2 + the existing web-bridge and dispatch tests).

Manual check, CLI:
1. Start `bun run dev`, press Shift+Tab until Plan mode, and ask for a small change.
2. When the plan dialog opens, the first "Yes" option should be **"Yes, and orchestrate with parallel workers"**. Pick "Yes, auto-accept edits" instead.
3. The model's next message must not claim Orchestrator mode, and the mode indicator should show Accept edits.

Manual check, Rayucode (after `bun run build:vscode` and installing the `.vsix`):
1. Get a plan card the same way. It should have four buttons: "Keep planning", "Approve · Ask", "Approve · Auto-edit" and "Approve · Orchestrator" (the last one highlighted).
2. Each Approve button should leave the mode pill on the mode it names.
3. In Orchestrator mode, while a background worker is running, switch the pill to Ask. A notice should say the worker is still running and cannot get approval.

---

## Task 4: what the Orchestrator is told matches the tools it has

What changed:
- Orchestrator mode now has **SendMessage** to continue its own workers, even without agent teams. The new variant is in `src/tools/SendMessageTool/OrchestratorSendMessageTool.ts`, and `getTools` adds it in `src/tools.ts`. It accepts only plain text to a worker of this session, by name or agent ID. It does not support broadcast, `uds:` or `bridge:` addresses, or shutdown and plan-approval messages. Workers never get it.
- The in-process routing in `SendMessageTool.call` moved into `messageLocalAgent()` and `resolveLocalAgentRecipient()`, which both tools use. The full tool's behavior should be unchanged.
- The Agent tool's `name` parameter is now visible to the model without agent teams. It was removed from the schema before, even though the Orchestrator was told to name its workers.
- The Agent tool now mentions SendMessage only where the caller has it: in its prompt ("If the SendMessage tool is available…") and in launch and completion results.
- The planner now runs on the Orchestrator's model (`model: 'inherit'`). Before, it ran on the provider's small/fast model for non-Anthropic providers. Its prompt no longer tells it to launch `Explore` agents, which subagents cannot do.
- The headless engine (Rayucode and `--print`) now rebuilds its tool list between tool rounds (`refreshTools` in `QueryEngine` and `print.ts`), as the REPL already does. A plan approval that enters Orchestrator mode mid-turn therefore offers SendMessage on the next request.

Unit tests:

```bash
bun test ./test/orchestratorSendMessage.test.ts ./test/orchestratorAgents.test.ts ./test/subagentModel.test.ts ./test/agentModel.test.ts ./test/agentModelTargets.test.ts ./test/subagentModelDisplay.test.ts
```

Expected: all pass. Of these, `orchestratorSendMessage.test.ts` is new, and one test was added to `subagentModel.test.ts` ("the planner runs on the Orchestrator model"). The test in `orchestratorAgents.test.ts` was updated: it used to assert the old "Explore" instruction.

End-to-end (spawns the real engine against a local scripted model, so no network is needed; about 1 minute in total):

```bash
bun test ./test/orchestratorE2E.test.ts
```

Expected: 6 tests pass:
1. `baseline: parallel workers without a contract produce code that does not fit, and nothing flags it`. This test deliberately asserts today's buggy behavior. Tasks 9 and 10 will change it.
2. `the Orchestrator role reaches every turn after a mid-conversation switch, and /normal leaves it`
3. `switching to a prompting mode while a background worker runs emits a warning frame`
4. `approving a plan mid-turn offers SendMessage on the very next request` (new, Task 4)
5. `a finished worker is continued with SendMessage and keeps its context` (new, Task 4)
6. `the Orchestrator main agent cannot change files itself, while its workers can` (new, Task 5)

If test 5 fails, include whether the SendMessage result said "had no active task" or "is registered but has no transcript". That tells me whether the worker's transcript was missing on disk in `--print` mode.

Manual check (CLI or Rayucode, in Orchestrator mode):
1. Ask for a change that needs one worker. When it finishes, say "send the types worker a follow-up: also export the type".
2. The Orchestrator should call **SendMessage** with `to` set to the worker's name, rather than starting a new worker. The worker should resume, and a second completion notice should arrive.
3. With a non-Anthropic provider and no `/subagent_models` choice, the planner's model in the task list should be the main model, not the small/fast one.

---

## Task 5: the Orchestrator's own main agent cannot change files

What changed:
- `src/orchestrator/mainThreadPolicy.ts` is new. In Orchestrator mode it denies Edit, Write (except the session plan file), NotebookEdit, and shell commands the shell tool does not consider read-only. This applies to the main agent only; workers keep auto-approval. The denial message tells the model to delegate, and mentions SendMessage when it is available.
- The rule is checked in `hasPermissionsToUseToolInner`, before the step that allows everything in Orchestrator mode. It is also checked in `checkRuleBasedPermissions`, the PreToolUse-hook allow path, so a hook cannot bypass it.
- `isSessionPlanFile` moved from `utils/permissions/filesystem.ts` to `utils/plans.ts` (now exported) to avoid an import cycle. The plan-file rules in `filesystem.ts` should behave the same.

```bash
bun test ./test/orchestratorMainThreadPolicy.test.ts ./test/fullManageInteractive.test.ts ./test/orchestratorMode.test.ts ./test/externalAgentsPermissions.test.ts ./test/composeBridgePermissionCallbacks.test.ts
```

Expected: all pass. `orchestratorMainThreadPolicy.test.ts` is new. The e2e scenario for Task 5 is test 6 above.

Manual check (CLI, Orchestrator mode):
1. Say "edit README.md yourself, add one line, do not use workers".
2. The Edit or Write call should be denied with "Orchestrator mode: the main agent coordinates and does not edit files itself…", and the model should then delegate.
3. Read-only commands such as `git status` should still run without a prompt.
4. A worker's edits should still apply without prompts.

---

## Whole-repo checks (run once, after the task checks)

Type check (only new error signatures are printed; an empty list is the goal):

```bash
timeout 900 /tmp/rayu-tsc-diff.sh
```

Full test suite, compared with the baseline failures:

```bash
bun test 2>&1 | tee /tmp/rayu-tests-now.log | grep -E '^\(fail\)' | sed -E 's/ \[[0-9.]+m?s\]$//' | sort -u > /tmp/rayu-fails-now.txt
grep -E '^ *[0-9]+ (pass|fail|skip)|^ *[0-9]+ errors?|Ran ' /tmp/rayu-tests-now.log | tail -6
echo '--- failures not in the baseline:'
comm -13 <(sort -u /tmp/rayu-baseline-fails.txt) /tmp/rayu-fails-now.txt
```

Expected: no failures outside the baseline. Your own work in progress (for example the Rayucode settings files) may add failures that are not mine. List them anyway and I will sort them out.

Builds (optional now; required before the final task):

```bash
bun run build
bun run build:vscode
```

---

## What to send back

For each command above:
- the pass/fail/skip counts;
- for every failing test, its name and the first 30 lines of its error;
- for the type check, the full "NEW error signatures" list;
- for each manual check you ran, what you saw where it differed from the expected result.

When everything passes, I continue with Task 6 (a shared change ledger, extracted from the external-agents change tracker). After that come the contract tool and `/orchestrator-status` (Task 7).
