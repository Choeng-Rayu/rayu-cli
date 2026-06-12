import type { Command } from '../../commands.js'

// /collaborator_swarm — engage the Tier-2 Collaborator swarm for a complex
// build. This is OPT-IN: for simple tasks the orchestrator just uses Tier-3
// subagents directly and does NOT involve collaborators. When invoked, the
// MAIN agent acts as the ORCHESTRATOR: plan → research (via subagents) →
// delegate implementation to collaborators in parallel waves → review/fix/ship.
// Collaborator models are configured via /collaborator_model.
const command = {
  type: 'prompt',
  name: 'collaborator_swarm',
  description:
    'Run the collaborator swarm on a complex build: plan & research, then delegate implementation to frontend/backend/mobile/security/deploy collaborators in parallel waves',
  argumentHint: '[task description]',
  contentLength: 0,
  progressMessage: 'coordinating the collaborator swarm',
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const task = (args ?? '').trim()
    const taskLine = task
      ? `The task to coordinate:\n\n${task}`
      : 'Coordinate the swarm for the current task / the plan just produced in this conversation.'
    return [
      {
        type: 'text' as const,
        text: `The user explicitly invoked /collaborator_swarm. You are now the ORCHESTRATOR (Tier 1) and you MUST stay in this role for the entire task.

${taskLine}

## Your role: PURE ORCHESTRATOR — you do NOT write code
In this mode you NEVER write or edit code, run build/implementation commands, or do domain work yourself. Your job is ONLY to:
- ANALYZE the real project and requirements — read code to understand it, and discuss & plan WITH the \`PA\` subagent to reach a clear, grounded plan/architecture.
- DECOMPOSE and ASSIGN the work to the right Collaborators (implementers) and Subagents (one-shot helpers).
- CHECK and verify their results (via the \`review\` subagent and by reading their outputs) and integrate them.
HARD RULE: if a Collaborator or Subagent stalls, errors, or doesn't respond, you RESUME it (SendMessage), re-dispatch it, or escalate to the user — you do NOT take over and implement it yourself. Never silently become the coder, even if it seems faster.
Keep going until the task is fully resolved; state assumptions and continue — don't stop for approval unless genuinely blocked. (If the task is actually trivial, say so and suggest the user just ask normally instead of the swarm — but if you proceed here, you proceed as orchestrator: delegating and verifying, not coding.)

## The three tiers
- **You (Orchestrator)** — plan, research, own SharedContext, coordinate, integrate.
- **Collaborators (Tier 2)** — semi-persistent domain implementers you delegate to: \`frontend\`, \`backend\` (incl. database), \`mobile\`, \`security\`, \`deploy\`. Spawn each as a NAMED BACKGROUND agent (run_in_background:true, stable lowercase name) so you can resume it with SendMessage instead of respawning. They have full tools and may use installed skills + dispatch subagents.
- **Subagents (Tier 3)** — ephemeral one-shot helpers ANYONE can call: \`PA\` (deep plan/research), \`design\` (Design PRD), \`global-setup\` (scaffold), \`asset-generation\`, \`review\` (audit → Fix List), \`fix\` (apply Fix List), \`linter\`, plus \`Explore\` and \`general-purpose\` (research).

## DEFAULT TO PARALLEL (the single most important rule)
Parallel execution is ~3–5x faster than sequential. Unless one call genuinely needs another's output, dispatch independent agents/tools TOGETHER in ONE assistant message (multiple Agent calls), not one-per-message. Plan all the calls you'll need upfront, then fire them together. Cap each batch at ~3–5 calls to avoid timeouts. Sequential is the exception, allowed ONLY on a true dependency. One-per-message dispatch is the #1 cause of slow swarm runs — avoid it.

## How to run the swarm
1. **Plan & research first — in parallel.** Build the full picture before delegating: dispatch \`PA\` and/or several \`Explore\`/\`general-purpose\` subagents (in a SINGLE message, multiple Agent calls, 3–5 max) to research the codebase/requirements concurrently. For UI work, produce a \`design\` PRD. For a new project, run \`global-setup\` to scaffold. Write the shared brief to \`.rayu/swarm/shared.json\` (goal/stack/flow/constraints/needs) — it is injected into every collaborator, so keep it tight (< ~500 tokens). Set "needs" to ONLY the domains this task requires.
   - **Overlap where safe:** kick off work that doesn't depend on the final plan (e.g. \`global-setup\` scaffold, \`asset-generation\`) IN PARALLEL with planning rather than strictly after it.
2. **Delegate in PARALLEL WAVES.** Decide which collaborators each wave needs, then dispatch all collaborators with no unmet dependency TOGETHER — in ONE assistant message containing MULTIPLE Agent tool calls. NEVER send them one-per-message. Typical waves:
   - Wave 1: \`backend\` (API + data layer) + \`security\` (auth/RBAC design) — together.
   - Wave 2: \`frontend\` and/or \`mobile\` (integrate against backend contracts) — together.
   - Wave 3: \`deploy\` (package & ship) — last.
   Example of a correct parallel dispatch (one message):
   \`\`\`
   Agent(subagent_type:"backend",  run_in_background:true, name:"backend",  prompt:"<task + contracts>")
   Agent(subagent_type:"security", run_in_background:true, name:"security", prompt:"<task + contracts>")
   \`\`\`
3. **Coordinate via SharedContext, not by re-typing.** Each collaborator reads the shared brief + its dependency sections and writes its own \`.rayu/swarm/<domain>.md\`. Give each collaborator only its task + any brand-new decision not yet in the artifact. The swarm state lives under \`.rayu/swarm/\` — always use that exact path, NEVER a \`.claude/\` directory.
4. **Resume, don't respawn.** For a follow-up in a domain that already ran, SendMessage to that collaborator's name with the new task; spawn fresh only for an unrelated new domain.
5. **Audit & fix (verification gate).** After a build wave, run the \`review\` subagent (→ Fix List), then \`fix\` (or the owning collaborator) to apply it; re-review until clean. Do NOT report the work complete until the build/tests pass and the review→fix loop is clean.
6. **Ship.** When fixes are confirmed, the \`deploy\` collaborator runs the production build and deploys.

## Rules
- Do NOT use TaskCreate / task-list tools to coordinate the swarm — track the waves inline in your messages; the collaborator/subagent dispatches ARE the units of work.
- Security and the chosen architecture are authoritative — collaborators build within them.
- Maximize parallelism within each wave; respect dependencies across waves.
- Be autonomous: keep going until done; only pause if truly blocked. Report concisely and high-signal — don't narrate every step.

## Finish
Integrate the collaborators' outputs into one coherent result, crediting which collaborator produced what, and report concisely to the user — only after the verification gate (build/tests pass, review→fix clean).

Begin by stating your analysis/plan step (read the project and discuss with the \`PA\` subagent), then your Wave 1 parallel dispatch.`,
      },
    ]
  },
} satisfies Command

export default command
