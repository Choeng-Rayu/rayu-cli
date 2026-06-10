import { expect, test } from 'bun:test'
import {
  PA_AGENT,
  BE_AGENT,
  SEC_AGENT,
  DB_AGENT,
  DO_AGENT,
  FE_AGENT,
  MOB_AGENT,
} from '../src/tools/AgentTool/built-in/specialists.ts'

const ALL = [PA_AGENT, DB_AGENT, BE_AGENT, SEC_AGENT, FE_AGENT, MOB_AGENT, DO_AGENT]

/** A specialist can use a tool when its allowlist permits it (['*'] or the
 *  name) AND it isn't in the denylist. */
function canUse(agent: { tools?: string[]; disallowedTools?: string[] }, tool: string): boolean {
  const allow = agent.tools ?? ['*']
  const allowed = allow.includes('*') || allow.includes(tool)
  const denied = (agent.disallowedTools ?? []).includes(tool)
  return allowed && !denied
}

test('every specialist can use the Skill tool (empowerment)', () => {
  for (const a of ALL) {
    expect(canUse(a, 'Skill')).toBe(true)
  }
})

test('every specialist can use ToolSearch', () => {
  for (const a of ALL) {
    expect(canUse(a, 'ToolSearch')).toBe(true)
  }
})

test('SEC is audit-only: cannot Edit or run Bash, but CAN use Skill + Write', () => {
  expect(canUse(SEC_AGENT, 'Edit')).toBe(false)
  expect(canUse(SEC_AGENT, 'Bash')).toBe(false)
  expect(canUse(SEC_AGENT, 'Skill')).toBe(true)
  expect(canUse(SEC_AGENT, 'Write')).toBe(true)
  expect(canUse(SEC_AGENT, 'Read')).toBe(true)
})

test('PA cannot Edit code or run Bash, but CAN use Skill + Write the brief', () => {
  expect(canUse(PA_AGENT, 'Edit')).toBe(false)
  expect(canUse(PA_AGENT, 'Bash')).toBe(false)
  expect(canUse(PA_AGENT, 'Skill')).toBe(true)
  expect(canUse(PA_AGENT, 'Write')).toBe(true)
})

test('implementer specialists have the full toolset (incl. Edit/Bash/Skill)', () => {
  for (const a of [DB_AGENT, BE_AGENT, FE_AGENT, MOB_AGENT, DO_AGENT]) {
    for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill']) {
      expect(canUse(a, tool)).toBe(true)
    }
  }
})

test('only PA and SEC are tool-restricted (least-privilege kept where it matters)', () => {
  for (const a of ALL) {
    const restricted = (a.disallowedTools ?? []).length > 0
    if (a === PA_AGENT || a === SEC_AGENT) expect(restricted).toBe(true)
    else expect(restricted).toBe(false)
  }
})

test('per-specialist skills wiring: DO preloads the bundled verify skill', () => {
  expect(DO_AGENT.skills).toContain('verify')
})
