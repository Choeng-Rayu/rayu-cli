import type { Command } from '../commands.js'

// /swarm — frame the current request for the specialist swarm. This injects an
// orchestration directive so the MAIN agent acts as the coordinator: decompose
// the task by domain, dispatch the relevant specialists IN PARALLEL (one Agent
// tool call each, in a single message), honor PA/SEC authority + DRIFT_FLAGs,
// then synthesize. Specialists are picked by the main agent (the user does not
// choose them); their model is configured via /model_subagent.
const command = {
  type: 'prompt',
  name: 'swarm',
  description:
    'Run the specialist swarm on a task: decompose by domain and dispatch PA/BE/FE/DB/SEC/DO/MOB specialists in parallel',
  argumentHint: '[task description]',
  contentLength: 0,
  progressMessage: 'coordinating the specialist swarm',
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const task = (args ?? '').trim()
    const taskLine = task
      ? `The task to coordinate:\n\n${task}`
      : 'Coordinate the swarm for the current task / the plan just produced in this conversation.'
    return [
      {
        type: 'text' as const,
        text: `You are now the SWARM ORCHESTRATOR for this task. Coordinate the specialist subagents — do not do the domain work yourself; dispatch it.

${taskLine}

## How to run the swarm
1. Briefly decompose the work by domain and decide which specialists are needed. Only spawn the ones the task actually requires:
   - PA-AGENT (planner/architecture — run FIRST for new projects/features; its stack & architecture decisions are FINAL)
   - DB-AGENT (schema), BE-AGENT (API), SEC-AGENT (security — its decisions are FINAL), FE-AGENT (web UI), MOB-AGENT (mobile), DO-AGENT (devops, usually LAST)
2. Respect dependencies, but maximize parallelism: dispatch specialists with no unmet dependency TOGETHER, in a SINGLE message with multiple Agent tool calls. Spawn each as a NAMED BACKGROUND agent (run_in_background:true, stable lowercase name pa/db/be/sec/fe/mob/do) so you can resume it later. Typical waves:
   - Wave 1: PA-AGENT (+ Explore for research)
   - Wave 2: DB-AGENT, FE-AGENT
   - Wave 3: BE-AGENT, SEC-AGENT
   - Wave 4: MOB-AGENT, DO-AGENT
   Within each wave, send all the calls in one message so they run concurrently.
3. Shared context is carried by an artifact, not by you re-typing it: PA-AGENT writes .rayu/swarm/shared.json (goal/stack/flow/constraints) + .rayu/swarm/PA.md; each other specialist automatically receives the shared brief plus only its dependency sections, and writes its own .rayu/swarm/<AGENT>.md. So give each specialist just the task plus any brand-new decision not yet in the artifact — do NOT paste the whole schema/routes/auth into every prompt.
4. Persistent sessions: keep each specialist alive. For a follow-up or the next task in a domain that already ran, RESUME it with SendMessage (to: its name) carrying only the new task + changed contracts — do NOT spawn a fresh one. Resuming keeps that specialist's full working context and auto-refreshes its shared context; spawn fresh only for an unrelated new domain.
5. After each wave, integrate results and let the next wave read the updated artifact.

## Conflict & drift handling
- If specialists conflict, resolve by authority: SEC-AGENT (security) and PA-AGENT (architecture/stack) decisions win; DB-AGENT owns data-layer naming; BE-AGENT owns API contracts (FE/MOB adapt).
- If a specialist emits "DRIFT_FLAG: ...", route that item to the right specialist (or handle it yourself) rather than letting the flagging agent do out-of-scope work.

## Finish
- Synthesize a single coherent result: the integrated plan/implementation, in dependency order, crediting which specialist produced what. Keep it tight.

Begin by stating the decomposition and Wave 1 dispatch.`,
      },
    ]
  },
} satisfies Command

export default command
