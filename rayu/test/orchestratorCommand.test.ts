import { expect, test } from 'bun:test'
import command from '../src/commands/orchestrator/index.ts'

test('/orchestrator delegates implementation and verification to bounded workers', async () => {
  expect(command.name).toBe('orchestrator')
  expect(command.type).toBe('prompt')

  const blocks = await command.getPromptForCommand('build an app', {} as never)
  const text = blocks.map(block => block.text).join('\n')

  expect(text).toContain('build an app')
  expect(text).toContain('ORCHESTRATOR')
  expect(text).toContain('planner')
  expect(text).toContain('Explore')
  expect(text).toContain('general-purpose')
  expect(text).toContain('run_in_background:true')
  expect(text).toContain('SendMessage')
  expect(text).toMatch(/MUST NOT implement, edit files/i)
  expect(text).toMatch(/exact non-overlapping file ownership/i)
  expect(text).toMatch(/fresh general-purpose agents/i)
  expect(text).not.toContain('.rayu/swarm')
  expect(text).not.toContain('Collaborators')
})
