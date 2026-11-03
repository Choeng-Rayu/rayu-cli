export const EXTERNAL_AGENT_TOOL_NAME = 'ExternalAgent'

export const DESCRIPTION =
  'Delegate coding work to an external agent CLI (Codex, Claude Code, OpenCode) and talk to it.'

/**
 * The tool prompt deliberately spends most of its length on what NOT to do.
 *
 * The failure modes here are expensive: launching a second agent when one is
 * already running, polling in a busy loop, or delegating work that would be
 * faster done directly. Each is cheap to prevent with an explicit instruction
 * and hard to recover from once the model has committed.
 */
export function getExternalAgentPrompt(): string {
  return `Delegate work to a separate agent CLI installed on this machine and hold a conversation with it.

Each external agent is its OWN process with its OWN conversation, model and permission settings. It is not a subagent of this session: it keeps working after this turn ends, and its output arrives asynchronously.

Actions:
- \`list\` — which providers are installed and which agent instances are already connected. Call this FIRST unless you already know the agent id.
- \`delegate\` — assign work. Give \`provider\` to start a fresh instance, or \`agent_id\` to reuse a connected one. Returns a task id.
- \`send\` — continue the conversation with a connected agent. Requires \`agent_id\`.
- \`orchestrate\` — run several steps under a policy. Unlike the others, this WAITS for the whole plan to finish.

Orchestrate policies (\`mode\`):
- \`parallel\` — every step at once. One failing does not stop the others.
- \`sequential\` — in order, stopping at the first failure, because later steps usually depend on earlier ones. Remaining steps come back as \`skipped\`.
- \`race\` — the same work to several targets; the first success wins and the losers are cancelled. Cancelling stops future work but does NOT undo edits already written, so every racing step needs \`isolate: true\` — or \`allow_shared_workspace_race: true\` if you genuinely accept interleaved half-applied edits.
- Per step, \`retry_attempts\` retries only TRANSIENT failures (rate limit, disconnect, timeout). Repeating a prompt the agent already could not do just burns tokens; use \`fallback_provider\` to try a different agent instead.
- \`review_provider\` + \`review_prompt\` send a summary of the completed work to a fresh reviewer. Skipped when no step completed.

Reading results:
- \`delegate\` and \`send\` return immediately with a task id. They do NOT wait for the agent to finish.
- \`orchestrate\` is the exception: it waits, because the policies only mean something once the steps resolve. Each step is still its own task, so its output is readable with TaskOutput while the plan runs.
- Use the TaskOutput tool with that task id to read what the agent has produced so far. Use TaskGet to check status.
- You will also be notified automatically when the task completes, fails, or the agent needs approval. Do not poll in a loop waiting for it.
- Use TaskStop to cancel the work. That interrupts the agent's current turn; it does not shut the agent down.

When to delegate:
- The work is substantial and independent, and running it in parallel with your own work is genuinely useful.
- The user explicitly asked for that agent.
- The task suits a different model or a different tool set than this session has.

When NOT to delegate:
- Anything you can do directly in a few tool calls. Delegating is slower and costs a second model's tokens.
- Work that needs your own conversation context — the external agent cannot see this conversation.
- A second instance of a provider that already has an idle instance connected. Reuse it with \`agent_id\`.

Important behaviour:
- If the agent is mid-turn, your input is QUEUED and dispatched when it goes idle. That is normal and the result says so; do not resend.
- Some agents cannot be interrupted or steered. The result tells you what actually happened rather than assuming the request took effect.
- Approvals the agent raises are shown to the USER, not to you. A task may sit waiting for a human.
- Two agents editing the same files can clobber each other. Pass \`isolate: true\` to give the agent its own git worktree when the work overlaps with yours or another agent's.`
}
