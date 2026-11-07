import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import command from '../src/commands/orchestrator/index.ts'
import { getDefaultAppState, type AppState } from '../src/state/AppStateStore.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { ORCHESTRATOR_NO_GIT_NOTE } from '../src/utils/orchestratorMode.ts'

test('/orchestrator enters the mode and frames the task; the rules come from the reminder', async () => {
  expect(command.name).toBe('orchestrator')
  expect(command.type).toBe('prompt')

  let state: AppState = getDefaultAppState()
  const context = { getAppState: () => state, setAppState: (f: (s: AppState) => AppState) => { state = f(state) } }
  const blocks = await command.getPromptForCommand('build an app', context as never)
  const text = blocks.map(block => block.text).join('\n')

  expect(state.toolPermissionContext.mode).toBe('orchestrator')
  expect(text).toContain('build an app')
  expect(text).toContain('ORCHESTRATOR')
  expect(text).toMatch(/rules in the system reminder/)
  expect(text).toMatch(/Do not edit files yourself/)
  expect(text).toMatch(/may run shell commands/)
  expect(text).toContain('/normal')
  // The rules live in one place (src/orchestrator/reminder.ts), not in this prompt.
  expect(text).not.toContain('run_in_background')
  expect(text).not.toContain('.rayu/swarm')
  expect(text).not.toContain('Collaborators')
})

test('/orchestrator without a task orchestrates what the conversation established', async () => {
  const blocks = await command.getPromptForCommand('', {} as never)
  expect(blocks.map(block => block.text).join('\n')).toMatch(/plan already established/)
  // This test runs from the git checkout, so the no-git note is not shown.
  expect(blocks.map(block => block.text).join('\n')).not.toContain(ORCHESTRATOR_NO_GIT_NOTE)
})

test('/orchestrator tells the user when the directory is not a git repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayu-orchestrator-nogit-'))
  try {
    const blocks = await runWithCwdOverride(dir, () => command.getPromptForCommand('ship it', {} as never))
    const text = blocks.map(block => block.text).join('\n')
    expect(text).toContain('ship it')
    expect(text).toContain(ORCHESTRATOR_NO_GIT_NOTE)
    expect(text).toMatch(/Note for the user/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
