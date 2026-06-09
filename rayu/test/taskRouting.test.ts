import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  TASK_ROUTING_SECTION,
  getTaskRoutingSection,
} from '../src/tools/AgentTool/taskRouting.ts'

let saved: string | undefined
beforeEach(() => {
  saved = process.env.RAYU_DISABLE_SPECIALIST_AGENTS
  delete process.env.RAYU_DISABLE_SPECIALIST_AGENTS
})
afterEach(() => {
  if (saved === undefined) delete process.env.RAYU_DISABLE_SPECIALIST_AGENTS
  else process.env.RAYU_DISABLE_SPECIALIST_AGENTS = saved
})

test('routing content classifies TRIVIAL / SINGLE-DOMAIN / MULTI-DOMAIN', () => {
  expect(TASK_ROUTING_SECTION).toContain('TRIVIAL')
  expect(TASK_ROUTING_SECTION).toContain('SINGLE-DOMAIN')
  expect(TASK_ROUTING_SECTION).toContain('MULTI-DOMAIN')
  // Multi-domain must dispatch the swarm; trivial must not.
  expect(TASK_ROUTING_SECTION).toMatch(/MULTI-DOMAIN[\s\S]*swarm/)
  expect(TASK_ROUTING_SECTION).toMatch(/Never spawn specialists for trivial/i)
  // Ask-on-borderline escape.
  expect(TASK_ROUTING_SECTION).toMatch(/cannot tell|ask the user/i)
})

test('section is present when specialists enabled', () => {
  expect(getTaskRoutingSection()).toBe(TASK_ROUTING_SECTION)
})

test('section is omitted when specialists disabled', () => {
  process.env.RAYU_DISABLE_SPECIALIST_AGENTS = '1'
  expect(getTaskRoutingSection()).toBeNull()
})
