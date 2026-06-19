# 12. Collaborator Agent Swarm

Rayu ships a "developer family" of specialist agents and subagents that the **main agent orchestrates** to build complex, multi-domain projects in parallel. This is called the **Collaborator Agent Swarm** (`/collaborator_swarm`), adapted natively from the ruflo/agent-swarm patterns (with no external harness, no HNSW/SONA infra).

You can engage the Tier-2 Collaborator swarm for any complex build by running the slash command:
```
/collaborator_swarm [task description]
```
Running this command puts your session into **swarm mode** (an indicator appears under the input; `/normal` exits).

---

## Swarm Architecture: The Three Tiers

The swarm is organized into three distinct hierarchical tiers to separate concerns, prevent drift, and maximize speed:

1. **Tier 1: Orchestrator (Main Agent)**
   - Decomposes the user's request, coordinates the work, maintains the shared context, and integrates collaborator outputs.
   - **Does not write or edit code.** It delegates all implementation.
2. **Tier 2: Collaborators (Domain Implementers)**
   - Semi-persistent, specialized agents spawned in the **background** (resumable via `SendMessage` rather than respawned).
   - They have full access to tools within their domain and write production-ready code.
3. **Tier 3: Subagents (Ephemeral Helpers)**
   - One-shot helper agents spawned in the **foreground** for atomic planning, generating, auditing, or fixing tasks.

---

## Tier 2: The Collaborators

There are five domain collaborators. Architecture/stack is owned by the **`planner`** (a Tier-3 subagent — the swarm's "queen") which runs FIRST and writes the shared brief (`.rayu/swarm/shared.json`) the collaborators build from. The data layer (schema/migrations) is part of **backend** — there is no separate database collaborator.

| Collaborator | Owns / Specializes In | Authority |
|--------------|-----------------------|-----------|
| **`backend`** | API routes, services, business logic, middleware, AND the data layer (schema, models, migrations) | Owns the API contract |
| **`frontend`** | Web pages/components, state, design-system tokens, API integration | Web UI/UX |
| **`mobile`** | Mobile screens, navigation, mobile API/auth layer, offline | Mobile UI/UX |
| **`security`** | Auth flow, RBAC, validation, encryption, sensitive data, vuln audit | **Security decisions are FINAL** |
| **`deploy`** | Dockerfiles, CI/CD, environments, build + deployment | DevOps (runs last) |

Each collaborator implements its domain and fans out parallel **`builder`** subagents (see below) for disjoint slices.

### Anti-Drift Guardrails
Collaborators stay strictly within their defined domain. If a task needs work outside their scope, they don't silently do it — they flag the cross-domain need and the Orchestrator routes it to the right collaborator. `planner` (stack/architecture) and `security` decisions are authoritative.

---

## Tier 3: Ephemeral Subagents & Specialization Matrix

Subagents are one-shot helpers, domain-locked so each collaborator can only invoke the helpers that match its specialty. The key implementer is **`builder`** — a swarm-native one-shot agent that builds ONE disjoint slice in a non-overlapping file area; collaborators dispatch several builders at once for intra-domain parallelism.

* **Orchestrator:** `planner`, `global-setup`, `design`, `backend-design`, `builder`, `asset-generation`, `review`, `fix`, `linter`, `Explore`, `general-purpose`.
* **frontend:** `design`, `asset-generation`, `builder`, `review`, `fix`, `linter`, `Explore`. *(No backend-design)*
* **backend:** `backend-design`, `builder`, `review`, `fix`, `linter`, `Explore`. *(No design / asset-generation)*
* **mobile:** `design`, `asset-generation`, `backend-design`, `builder`, `review`, `fix`, `linter`, `Explore`.
* **security:** `backend-design`, `builder`, `review`, `fix`, `linter`, `Explore`.
* **deploy:** `builder`, `review`, `fix`, `linter`, `Explore`.

> **`general-purpose` is NOT in any collaborator's scope.** It is reserved for the Orchestrator on **non-web/mobile** work (CLI tools, scripts, libraries, data pipelines). Web/mobile implementation always goes through the collaborators + their `builder` subagents.
>
> **Note:** `planner` and `global-setup` are strictly **Orchestrator-only** — collaborators implement; they never re-plan or re-scaffold.

### Intra-domain parallelism (the `builder` fan-out)
The `planner` writes a per-domain **slice plan** into `.rayu/swarm/shared.json` (`slices`): each slice has a `name`, a one-line `task`, and a disjoint `area` (the file globs it owns). A collaborator lays its foundation first (frontend/mobile → `design`; backend → `backend-design`; security → the auth spec), then dispatches **one `builder` per slice in parallel** — capped at `RAYU_SWARM_MAX_PARALLEL` concurrent writers per wave (default **5**; the planner may set `cap` in the brief). Read-only research is unbounded; only parallel *writers* are capped, and disjoint file areas keep them conflict-free. More slices than the cap → successive waves.

---

## Bundled Swarm Skills

Rayu preloads original specialized skills that the orchestrator and collaborators can call via the `Skill` tool:
* **UI/Design/Brand:** `rayu-frontend-design`, `rayu-design-system`, `rayu-theme-factory`, `rayu-brand-guidelines`
* **Generative Art/Graphics:** `rayu-canvas-design`, `rayu-algorithmic-art`
* **Backend/Integration:** `rayu-api-design`, `rayu-mcp-builder`
* **QA & Verification:** `rayu-web-testing`
* **Deliverables:** `rayu-doc-export` (creates `docx`, `xlsx`, `pptx`, or `pdf` deliverables)

---

## The 3-Phase Swarm Build Flow

### Phase 1 — Scope & Research (Foreground)
- The Orchestrator clarifies requirements, asks for missing scopes, and recommends 2–3 concrete tech stacks to the user.
- If there are open implementation choices (e.g., payment gateways), the Orchestrator dispatches the `planner` subagent to research the real, available options in the codebase and presents them to the user.

### Phase 2 — Aligned Plan (Planner → Orchestrator → User)
- The Orchestrator feeds the gathered context to the `planner` subagent.
- The `planner` produces one cohesive, aligned plan spanning backend, frontend, database, and API contracts.
- This plan is presented to the user for final confirmation (approving leaving Plan Mode auto-starts the build).

### Phase 3 — Build & Parallel Implementation
1. **Setup Gate:** If a brand-new project, `global-setup` scaffolds folders and tooling.
2. **Design Block (3-Way Parallel):** Orchestrator dispatches `design` (UI/UX) ∥ `backend-design` (API & Schema) ∥ `global-setup` together in a single step.
3. **Implementation Block (parallel waves):**
   - **Backend + Security:** Dispatch `backend` (API + data layer from the design PRD) ∥ `security` (auth/RBAC, endpoint hardening) in parallel. Each fans out `builder`s across its slices (≤ cap per wave) on disjoint file areas.
   - **Frontend & Mobile:** Once the backend contract (`.rayu/swarm/BACKEND.md`) lands, dispatch `frontend` ∥ `mobile`, each fanning out `builder`s per route-group / screen slice and integrating against the published API routes.
   - **Integration check:** After the waves, verify the frontend/mobile API calls match the backend's published routes; reconcile mismatches before review.
4. **Shared Context Communication:** Collaborators synchronize via a project-local context brief (`.rayu/swarm/shared.json`) and write their respective domain sections to `.rayu/swarm/<domain>.md`.
5. **Verification Gate (Audit & Fix):** Orchestrator dispatches the `review` subagent to audit implementation outputs against the Design PRD and generate a structured Fix List. The `fix` subagent (or the owner collaborator) applies precise edits, repeating until builds/tests pass cleanly.
6. **Ship:** The `deploy` collaborator runs the production build and ships the app.

---

## Key Swarm Rules

* **Default to Parallel:** To minimize execution time, all independent tool and agent calls must be dispatched together in a **single assistant message** rather than sequentially.
* **Foreground Subagents:** All ephemerals (`planner`, `design`, `review`, etc.) must run in the foreground so their output streams directly into your CLI session.
* **Background Collaborators:** Semi-persistent collaborators (`frontend`, `backend`, etc.) must run in the background to remain fully resumable via `SendMessage` throughout the session.
