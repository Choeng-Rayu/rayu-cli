# RAYU Orchestrator and Agents — Architecture Summary

> Verified directly from source code on 2026-09-20. The old domain-persona
> architecture has been removed. Orchestrator is a permission/UI mode, not a
> spawnable agent type.

## Orchestrator mode

Orchestrator is a distinct permission/UI mode that uses the same execution
semantics as `fullManage`, so delegated workers can edit files and run commands
without repeated approval prompts. Full Access and Full Manage remain separate
selectable modes. The main agent is prompt-constrained to coordination only:
understand the goal, plan, divide ownership, delegate implementation and
verification, integrate the results, and report back.

Users can enter it in three ways:

- Select **Orchestrator** with Shift+Tab in the CLI.
- Select **Orchestrator** from Rayucode's permission-mode control.
- Run `/orchestrator [task]`.

Confirming a plan also enters Orchestrator automatically. Selecting another
mode or running `/normal` exits it.

## Orchestrator child-agent set

| Type | Role | Writes code? | Can delegate? |
|---|---|---:|---:|
| `planner` | Researches and returns a decision-complete execution graph with bounded worker packets | No | May use read-only `Explore` agents |
| `Explore` | Read-only repository discovery | No | No |
| `general-purpose` | Universal implementation, review, fix, lint, test, and build worker | Yes | No |

The planner is the only specialist registered in `SUBAGENTS`. Implementation is
delegated to one or more named `general-purpose` workers. Independent workers
receive exact non-overlapping file ownership and can run concurrently;
dependent work is sequenced. Fresh workers perform review and verification.

There are no built-in `frontend`, `backend`, `mobile`, `security`, or `deploy`
personas. The former `design`, `backend-design`, `global-setup`,
`asset-generation`, `builder`, `review`, `fix`, and `linter` specialist types
are also absent.

## Registry counts

`getBuiltInAgents()` assembles the registry as follows outside coordinator-mode
replacement:

| Category | Count | Types |
|---|---:|---|
| Always registered | 2 | `general-purpose`, `statusline-setup` |
| Orchestrator specialist | 0–1 | `planner` (non-SDK, unless specialists are disabled) |
| Other conditional helpers | 0–3 | `Explore`, `rayu-code-guide`, `verification` |
| Domain collaborator personas | 0 | none |

That produces **2–6 built-in child-agent types**, depending on entrypoint,
feature flags, and environment settings. A normal interactive CLI session has
`general-purpose`, `statusline-setup`, `planner`, and `rayu-code-guide`, plus
`Explore` and `verification` when their gates are enabled.

The main Orchestrator itself adds one coordinating agent at runtime but is not
part of the child-agent registry.

## Source of truth

- `src/commands/orchestrator/index.ts` — explicit mode-entry prompt
- `src/utils/orchestratorMode.ts` — distinct mode state transition
- `src/utils/messages.ts` — per-turn main-agent Orchestrator reminder
- `src/tools/AgentTool/builtInAgents.ts` — child-agent registry assembly
- `src/tools/AgentTool/built-in/subagents/planner.ts` — planner definition
- `src/tools/AgentTool/built-in/generalPurposeAgent.ts` — universal worker
- `src/vscode/shared/permissionModes.ts` — Rayucode mode selector
