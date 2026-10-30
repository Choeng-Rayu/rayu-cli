export const AGENT_TOOL_NAME = 'Agent'
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions)
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'
// Built-in agent types Orchestrator mode delegates to. The definitions live in
// built-in/; these names are the contract prompts and reminders refer to.
export const GENERAL_PURPOSE_AGENT_TYPE = 'general-purpose'
export const PLANNER_AGENT_TYPE = 'planner'
export const EXPLORE_AGENT_TYPE = 'Explore'

// Built-in agents that run once and return a report — the parent never
// SendMessages back to continue them. Skip the agentId/SendMessage/usage
// trailer for these to save tokens (~135 chars × 34M Explore runs/week).
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
