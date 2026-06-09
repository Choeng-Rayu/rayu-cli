import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { buildStackAwarenessFragment } from '../src/tools/AgentTool/built-in/stackAwareness.ts'
import { PA_AGENT } from '../src/tools/AgentTool/built-in/specialists.ts'

function paPrompt(cwd: string): string {
  return runWithCwdOverride(cwd, () =>
    (PA_AGENT.getSystemPrompt as (p?: unknown) => string)({}),
  )
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-pa-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('fragment: existing stack → RESPECT / do not redesign + the detected stack', () => {
  const f = buildStackAwarenessFragment({
    languages: ['typescript'],
    frameworks: ['nextjs'],
    packageManager: 'bun',
    hasExistingStack: true,
    manifests: ['package.json'],
  })
  expect(f).toMatch(/RESPECT/)
  expect(f).toMatch(/do not redesign/i)
  expect(f).toContain('typescript')
  expect(f).toContain('nextjs')
})

test('fragment: greenfield → CHOOSE the stack', () => {
  const f = buildStackAwarenessFragment({
    languages: [],
    frameworks: [],
    hasExistingStack: false,
    manifests: [],
  })
  expect(f).toMatch(/CHOOSE the stack/)
  expect(f).toMatch(/greenfield/i)
})

test('PA prompt respects an existing stack when manifests are present', () => {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { next: '14' }, devDependencies: { typescript: '5' } }),
  )
  const p = paPrompt(dir)
  expect(p).toMatch(/RESPECT|do not redesign/i)
  expect(p).toContain('typescript')
})

test('PA prompt chooses a stack on a greenfield project', () => {
  const p = paPrompt(dir)
  expect(p).toMatch(/greenfield|CHOOSE the stack/i)
})
