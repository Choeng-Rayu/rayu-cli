# Specialist Agent Swarm

Rayu ships a "developer family" of specialist subagents that the **main agent
orchestrates** to build multi-domain projects in parallel — adapted natively
from the ruflo / agent-swarm patterns (no external harness, no HNSW/SONA infra).

## The specialists

| Agent | Owns | Authority |
|-------|------|-----------|
| `PA-AGENT` | Tech stack, architecture, phases, task breakdown | **Queen** — stack/architecture decisions are FINAL |
| `DB-AGENT` | Schema, tables, indexes, naming convention | Owns data-layer naming |
| `BE-AGENT` | API routes, services, middleware | Owns the API contract |
| `SEC-AGENT` | Auth flow, RBAC, validation, sensitive data | **Security decisions are FINAL** |
| `FE-AGENT` | Web pages/components, state, design tokens | UI/UX |
| `MOB-AGENT` | Mobile screens, navigation, mobile API/auth layer | Mobile |
| `DO-AGENT` | Dockerfile, CI/CD, env, deploy target | DevOps (runs last) |

Each specialist has: a tight role prompt, **anti-drift guardrails** (a
`DRIFT_FLAG:` protocol re-injected every turn), **native persistent memory**
(`memory: project` → `.claude/agent-memory/<AGENT>/MEMORY.md`, the
"search-before / store-after" pattern), and no hard-coded model.

## How it runs (orchestrator / executor split)

- The **main agent is the orchestrator**: it decomposes the request, decides
  which specialists are needed, and dispatches them **in parallel** (a single
  message with multiple `Agent` tool calls). It does not do the domain work
  itself; the specialists do.
- Specialists run in dependency **waves** (PA → DB/FE → BE/SEC → MOB/DO).
  Within a wave, calls are sent together so they execute concurrently.
- After each wave the orchestrator passes the new contracts (stack, schema, API
  routes, auth flow) to the next wave, then **synthesizes** one coherent result.
- **Conflicts** resolve by authority: `SEC > PA > DB-naming > BE-contract > FE/MOB/DO`.
  A specialist that hits out-of-scope work emits `DRIFT_FLAG: …` instead of
  drifting; the orchestrator routes it.

## Triggering the swarm

- **Automatic (judgment-based):** the main agent dispatches specialists when a
  task is multi-domain — including right after a plan (e.g. leaving plan mode),
  without the user having to ask. Trivial/single-file tasks are handled directly.
- **Explicit:** run `/swarm <task>` to frame a request for the swarm flow.
- Users do **not** pick specialists — the main agent does. Disable the whole set
  with `RAYU_DISABLE_SPECIALIST_AGENTS=1`.

## Choosing models (speed / cost)

Specialists default to the **subagent model**, set with `/model_subagent`:

- `/model_subagent` — set the global subagent model (used by all specialists).
- `/model_subagent BE-AGENT` — set the model for one specialist only.
- `/model_subagent BE-AGENT show` / `… default` — show / reset one specialist.

This lets you run the main agent on a strong model (e.g. Claude Opus on Bedrock)
while the specialists run on a cheap/fast model (e.g. NVIDIA stepfun) **in
parallel** — faster wall-clock and lower token cost. When unset, a specialist
uses the main provider's instant/small-fast model.

## Overriding a specialist

Drop a project agent file at `agents/<AGENT>.md` (e.g. `agents/BE-AGENT.md`) with
matching frontmatter `name: BE-AGENT` to override the built-in prompt/tools for
your project — project agents take precedence over built-ins.
