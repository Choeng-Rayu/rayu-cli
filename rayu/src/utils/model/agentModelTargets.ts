export const AGENT_MODEL_COMMAND_NAMES = [
  'subagent_models',
  'model_subagent',
  'subagent_model',
] as const

export const CORE_CONFIGURABLE_AGENT_TYPES = [
  'general-purpose',
  'Explore',
  'planner',
] as const

export function getConfigurableAgentTypes(
  reportedAgentTypes: readonly string[] = [],
): string[] {
  const seen = new Set<string>()
  return [...CORE_CONFIGURABLE_AGENT_TYPES, ...reportedAgentTypes].filter(
    agentType => {
      const key = agentType.trim().toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    },
  )
}

export function describeConfigurableAgent(agentType: string): string {
  switch (agentType.toLowerCase()) {
    case 'general-purpose':
      return 'Implementation, review, commands, and tests'
    case 'explore':
      return 'Read-only code search and analysis'
    case 'planner':
      return 'Planning and delegation packets'
    default:
      return 'Set the model for this agent'
  }
}

export type AgentModelTargetMatch = {
  query: string
  tokenStart: number
}

/** Match the first agent argument while it is being typed after the command. */
export function matchAgentModelTarget(
  input: string,
  cursorOffset: number,
): AgentModelTargetMatch | null {
  if (cursorOffset !== input.length) return null
  const beforeCursor = input.slice(0, cursorOffset)
  const match = /^\/([a-z_]+)\s+([^\s]*)$/i.exec(beforeCursor)
  if (!match) return null
  const commandName = match[1]?.toLowerCase()
  if (
    !commandName ||
    !(AGENT_MODEL_COMMAND_NAMES as readonly string[]).includes(commandName)
  ) {
    return null
  }
  return {
    query: match[2] ?? '',
    tokenStart: beforeCursor.lastIndexOf(' ') + 1,
  }
}

export function matchingAgentModelTargets(
  input: string,
  cursorOffset: number,
  reportedAgentTypes: readonly string[] = [],
): string[] {
  const match = matchAgentModelTarget(input, cursorOffset)
  if (!match) return []
  const query = match.query.toLowerCase()
  return getConfigurableAgentTypes(reportedAgentTypes).filter(agentType =>
    agentType.toLowerCase().startsWith(query),
  )
}

export function applyAgentModelTarget(
  input: string,
  cursorOffset: number,
  agentType: string,
): { input: string; cursorOffset: number } | null {
  const match = matchAgentModelTarget(input, cursorOffset)
  if (!match) return null
  const nextInput = `${input.slice(0, match.tokenStart)}${agentType} `
  return { input: nextInput, cursorOffset: nextInput.length }
}
