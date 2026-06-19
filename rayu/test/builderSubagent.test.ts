import { describe, expect, test } from 'bun:test'
import { BUILDER_SUBAGENT } from '../src/tools/AgentTool/built-in/subagents/builder.ts'
import {
  SUBAGENTS,
  SUBAGENT_TYPES,
} from '../src/tools/AgentTool/built-in/subagents/index.ts'

describe('builder subagent', () => {
  test('is registered as a Tier-3 subagent', () => {
    expect(SUBAGENT_TYPES).toContain('builder')
    expect(SUBAGENTS.some(a => a.agentType === 'builder')).toBe(true)
  })

  test('is a full read-write implementer (no Edit/Bash denylist)', () => {
    expect(BUILDER_SUBAGENT.tools).toEqual(['*'])
    expect(BUILDER_SUBAGENT.disallowedTools ?? []).toEqual([])
  })

  test('prompt is ephemeral + swarm-context-aware (one disjoint slice, reads the contract)', () => {
    const p = (BUILDER_SUBAGENT.getSystemPrompt as (x?: unknown) => string)({})
    // Ephemeral one-shot framing.
    expect(p).toMatch(/one-shot/i)
    expect(p).toMatch(/NO memory/i)
    // Swarm-aware: reads the shared brief + builds a disjoint slice to the contract.
    expect(p).toContain('.rayu/swarm/shared.json')
    expect(p).toMatch(/ONE slice|disjoint/i)
    expect(p).toMatch(/contract/i)
    // Self-verifies before reporting done.
    expect(p).toMatch(/build\/lint\/tests/i)
  })
})
