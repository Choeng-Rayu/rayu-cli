import { expect, test } from 'bun:test'

test('/collaborator_swarm directive covers tiers, shared context, parallel waves, and resume-by-name', async () => {
  const mod = await import('../src/commands/collaborator-swarm/index.ts')
  const command = mod.default
  expect(command.name).toBe('collaborator_swarm')
  expect(command.type).toBe('prompt')
  const blocks = await command.getPromptForCommand('build an app', {} as never)
  const text = blocks.map((b: { text?: string }) => b.text ?? '').join('\n')
  // task is interpolated
  expect(text).toContain('build an app')
  // shared-context artifact + per-domain write-back
  expect(text).toContain('.rayu/swarm/shared.json')
  expect(text).toContain('.rayu/swarm/<domain>.md')
  // named background agents + resume-by-name
  expect(text).toContain('run_in_background')
  expect(text).toContain('SendMessage')
  // 3-tier framing + parallel-wave dispatch
  expect(text).toContain('ORCHESTRATOR')
  expect(text).toContain('Collaborators')
  expect(text.toLowerCase()).toContain('parallel')
})
