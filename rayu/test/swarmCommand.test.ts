import { expect, test } from 'bun:test'

test('/swarm command directive mentions artifact, per-domain write-back, and resume-by-name', async () => {
  const mod = await import('../src/commands/swarm.ts')
  const command = mod.default
  expect(command.name).toBe('swarm')
  expect(command.type).toBe('prompt')
  const blocks = await command.getPromptForCommand('build an app', {} as never)
  const text = blocks.map((b: { text?: string }) => b.text ?? '').join('\n')
  // task is interpolated
  expect(text).toContain('build an app')
  // shared-context artifact + per-domain write-back
  expect(text).toContain('.rayu/swarm/shared.json')
  expect(text).toContain('.rayu/swarm/<AGENT>.md')
  // named background agents
  expect(text).toContain('run_in_background')
  // persistent sessions / resume-by-name
  expect(text).toContain('RESUME')
  expect(text).toContain('SendMessage')
})
