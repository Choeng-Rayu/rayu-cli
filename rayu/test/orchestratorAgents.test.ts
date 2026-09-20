import { describe, expect, test } from 'bun:test'
import { AGENT_TOOL_NAME } from '../src/tools/AgentTool/constants.ts'
import { GENERAL_PURPOSE_AGENT } from '../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
import {
  SUBAGENTS,
  SUBAGENT_TYPES,
} from '../src/tools/AgentTool/built-in/subagents/index.ts'

describe('Orchestrator agent architecture', () => {
  test('planner is the only specialist subagent', () => {
    expect(SUBAGENT_TYPES).toEqual(['planner'])
    expect(SUBAGENTS.map(agent => agent.agentType)).toEqual(['planner'])

    const removed = [
      'design',
      'backend-design',
      'global-setup',
      'asset-generation',
      'builder',
      'review',
      'fix',
      'linter',
    ]
    for (const type of removed) expect(SUBAGENT_TYPES).not.toContain(type)
  })

  test('planner cannot implement and emits bounded worker packets', () => {
    const planner = SUBAGENTS[0]!
    const denied = planner.disallowedTools ?? []
    expect(denied).toContain('Edit')
    expect(denied).toContain('Write')
    expect(denied).toContain('NotebookEdit')
    expect(denied).toContain('Bash')

    const prompt = planner.getSystemPrompt?.({} as never) ?? ''
    expect(prompt).toContain('Explore')
    expect(prompt).toContain('Worker packets')
    expect(prompt).toMatch(/non-overlapping file/i)
    expect(prompt).not.toContain('.rayu/swarm')
  })

  test('general-purpose is the universal, non-delegating implementation worker', () => {
    expect(GENERAL_PURPOSE_AGENT.tools).toEqual(['*'])
    expect(GENERAL_PURPOSE_AGENT.disallowedTools).toContain(AGENT_TOOL_NAME)
    expect(GENERAL_PURPOSE_AGENT.whenToUse).toMatch(
      /frontend, backend, mobile, security, infrastructure, tests, review, fixes/i,
    )

    const prompt = GENERAL_PURPOSE_AGENT.getSystemPrompt?.({} as never) ?? ''
    expect(prompt).toMatch(/file ownership as a hard boundary/i)
    expect(prompt).toMatch(/Do not delegate again or spawn nested agents/i)
    expect(prompt).toMatch(/focused tests/i)
  })
})
