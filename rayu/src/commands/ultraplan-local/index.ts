import type { Command } from '../../commands.js'

// Local, provider-agnostic /ultraplan. Unlike the remote "Claude Code on the
// web" ultraplan (Anthropic CCR + OAuth), this runs entirely on the user's
// configured provider by injecting a deep multi-agent planning directive — the
// main agent orchestrates exploration subagents via the Agent tool, then
// presents a plan for approval. Modeled on src/commands/swarm.ts.
const command = {
  type: 'prompt',
  name: 'ultraplan',
  description:
    'Deep multi-agent planning: explore in parallel, weigh approaches, produce a step-by-step plan for approval — runs locally on your provider',
  argumentHint: '[task description]',
  contentLength: 0,
  progressMessage: 'running deep multi-agent planning',
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const task = (args ?? '').trim()
    const taskLine = task
      ? `The task to plan:\n\n${task}`
      : 'Plan the current task / the request just discussed in this conversation.'
    return [
      {
        type: 'text' as const,
        text: `You are now in ULTRAPLAN mode — extended, multi-agent planning. Produce a thorough, well-researched plan. Do NOT write or edit any code yet; planning only.

${taskLine}

## How to ultraplan
1. Decompose the problem and decide what needs investigating. Identify the unknowns: existing code/conventions to follow, constraints, integration points, risks.
2. Investigate IN PARALLEL. In a SINGLE message, dispatch multiple subagents via the Agent tool to explore different angles concurrently — prefer the Explore agent (and the general-purpose agent) for codebase research, and any relevant specialists (PA for architecture, SEC for security-sensitive work, DB/BE/FE/MOB/DO for their domains). If the Explore agent is unavailable, use general-purpose agents. Give each a focused question; do the domain research via subagents rather than doing it all yourself.
3. Synthesize the findings into a clear picture of the current state and the target state.
4. Consider MULTIPLE approaches. Lay out at least the leading 1–2 viable options with explicit tradeoffs (complexity, risk, blast radius, reversibility), then recommend one and say why.
5. Produce a concrete, step-by-step implementation plan: ordered tasks, the files/modules each touches, how each step will be verified (build/tests), and any open questions or assumptions.
6. Present the plan for approval using ExitPlanMode (do not start implementing until the user approves).

Begin by stating the decomposition and your Wave 1 parallel exploration dispatch.`,
      },
    ]
  },
} satisfies Command

export default command
