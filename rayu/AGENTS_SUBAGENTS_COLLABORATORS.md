# RAYU Agents, Subagents & Collaborators — Architecture Summary

> Verified directly from source code on 2026-09-11. No user-defined custom
> agents exist in this workspace (`.claude/agents/`, `.rayu/agents/` are
> absent) — everything below is the **built-in** registry assembled by
> `getBuiltInAgents()` in `src/tools/AgentTool/builtInAgents.ts`.

---

## The 3-tier model

RAYU's swarm architecture (defined in `src/commands/collaborator-swarm/index.ts`,
the `/collaborator_swarm` command) organizes work into three tiers:

- **Tier 1 — Orchestrator.** The main agent itself (not a spawnable type).
  Scopes, plans, decomposes, delegates, integrates. In swarm mode it never
  writes code or does domain work directly.
- **Tier 2 — Collaborators.** Semi-persistent domain implementers with the
  FULL toolset, native project memory, and shared `.rayu/swarm/` context.
  Spawned as **named background agents** (resumable via `SendMessage`).
- **Tier 3 — Subagents.** Ephemeral, one-shot specialists with no memory —
  single task packet in, concise result out. Run in the **foreground** so
  their work streams inline.

---

## Tier 2 — Collaborators (5 total)

Source: `src/tools/AgentTool/built-in/collaborators/`

| # | agentType | Owns | Allowed subagents |
|---|-----------|------|--------------------|
| 1 | `frontend` | UI/UX implementation | design, asset-generation, review, fix, linter, Explore, general-purpose |
| 2 | `backend` | API + database | backend-design, review, fix, linter, Explore, general-purpose |
| 3 | `mobile` | Mobile app implementation | design, asset-generation, backend-design, review, fix, linter, Explore, general-purpose |
| 4 | `security` | Auth/authz, validation, sensitive-data handling (authoritative) | backend-design, review, fix, linter, Explore, general-purpose |
| 5 | `deploy` | Production build & shipping | review, fix, linter, Explore, general-purpose |

Key traits (from `collaborators/common.ts`):
- Full toolset (`tools: ['*']`), no denylist.
- Persistent per-project memory (search-before / store-after via `MEMORY.md`).
- Share the same `.rayu/swarm/` `SharedContext` as the rest of the swarm.
- May proactively use installed skills relevant to their domain.
- May fan out `builder` subagents in parallel for disjoint file slices.
- Model defaults to `inherit` from the orchestrator; overridable per
  collaborator via `/collaborator_model`.

---

## Tier 3 — Subagents (9 total)

Source: `src/tools/AgentTool/built-in/subagents/index.ts`, listed in
pipeline order:

| # | agentType | Role |
|---|-----------|------|
| 1 | `planner` | Deep plan/research — orchestrator-only |
| 2 | `design` | UI/UX + component PRD |
| 3 | `backend-design` | API contract + data model PRD |
| 4 | `global-setup` | Scaffold new project structure — orchestrator-only |
| 5 | `asset-generation` | Image/asset generation |
| 6 | `builder` | Implements one disjoint slice (dispatched by collaborators in parallel waves) |
| 7 | `review` | Audits work → produces a Fix List |
| 8 | `fix` | Applies a Fix List |
| 9 | `linter` | Lint pass |

Traits (from `subagents/common.ts`):
- Ephemeral: fresh session, no memory of past or future work.
- Receive one self-contained task packet, do exactly one job, return a
  concise structured result — never write to shared project state directly.
- Encouraged to batch independent reads/greps into parallel tool calls.
- May use installed/bundled skills relevant to the task.

---

## Other built-in agents (registry, not part of the tiers above)

From `getBuiltInAgents()`:

| agentType | Included when |
|-----------|----------------|
| `general-purpose` | Always |
| `statusline-setup` | Always |
| `Explore` | `areExplorePlanAgentsEnabled()` is true (feature flag + A/B gate) |
| `rayu-code-guide` (a.k.a. Code Guide agent) | Non-SDK entrypoints |
| `verification` | `feature('VERIFICATION_AGENT')` AND growthbook `tengu_hive_evidence` flag |

Opt-outs: `RAYU_DISABLE_SPECIALIST_AGENTS=1` removes all subagents AND
collaborators from the registry; `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`
clears the whole built-in set for non-interactive SDK sessions.

---

## The swarm (1 total)

| Command | Effect |
|---------|--------|
| `/collaborator_swarm` | Enters persistent, session-wide swarm mode. Main agent becomes the Orchestrator and runs the 3-phase flow: (1) scope & research, (2) one aligned plan (confirmed by user), (3) delegate by specialty to the 5 collaborators. `/normal` exits. |
| `/collaborator_model` | Sets/overrides the model used per collaborator (default: inherit from main agent). |

There is exactly **one** collaborator swarm mode — it is a session-wide
orchestration mode, not a spawnable agent type itself.

---

## Totals

| Category | Count |
|----------|-------|
| Collaborators (Tier 2) | **5** |
| Subagents (Tier 3) | **9** |
| Always-on utility agents | **2** (`general-purpose`, `statusline-setup`) |
| Conditional agents | **0–3** (`Explore`, `rayu-code-guide`, `verification`, depending on flags/env) |
| Collaborator swarms | **1** (`/collaborator_swarm`) |
| **Built-in agent types, grand total** | **16–19** (depending on feature flags at runtime) |
| User/project custom agents in this workspace | **0** (none found under `.claude/agents/` or `.rayu/agents/`) |

---

## Evidence trail (files read to verify this document)

- `src/tools/AgentTool/builtInAgents.ts` — `getBuiltInAgents()`, the exact assembly function
- `src/tools/AgentTool/built-in/collaborators/index.ts` — `COLLABORATORS` array
- `src/tools/AgentTool/built-in/collaborators/common.ts` — collaborator spec/behavior
- `src/tools/AgentTool/built-in/subagents/index.ts` — `SUBAGENTS` array
- `src/tools/AgentTool/built-in/subagents/common.ts` — ephemeral framing
- `src/tools/AgentTool/constants.ts` — one-shot agent types
- `src/tools/AgentTool/loadAgentsDir.ts` — agent definition types/loading
- `src/commands/collaborator-swarm/index.ts` — the `/collaborator_swarm` command and tier/matrix definitions
- `src/commands/collaborator-model/index.ts` — the `/collaborator_model` command
- Filesystem check: no `.claude/agents/` or `.rayu/agents/` directories present in this project
