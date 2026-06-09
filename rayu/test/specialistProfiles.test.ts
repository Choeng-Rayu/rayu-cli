import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { _resetRayuConfigCache } from '../src/utils/rayuConfig.ts'
import {
  PA_AGENT,
  DB_AGENT,
  MOB_AGENT,
} from '../src/tools/AgentTool/built-in/specialists.ts'
import {
  getProfileFragment,
  loadProfile,
} from '../src/tools/AgentTool/built-in/profiles.ts'

let cfgDir: string
let cwd: string
let savedCfg: string | undefined

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'rayu-prof-cfg-'))
  cwd = mkdtempSync(join(tmpdir(), 'rayu-prof-cwd-'))
  savedCfg = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = cfgDir
  _resetRayuConfigCache()
})
afterEach(() => {
  if (savedCfg === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedCfg
  _resetRayuConfigCache()
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function writeConfig(obj: unknown) {
  writeFileSync(join(cfgDir, 'providers.json'), JSON.stringify(obj))
  _resetRayuConfigCache()
}
function writeShared(constraints: string[]) {
  const d = join(cwd, '.rayu', 'swarm')
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'shared.json'),
    JSON.stringify({ goal: '', stack: '', flow: '', constraints }),
  )
}
function prompt(agent: typeof PA_AGENT): string {
  return runWithCwdOverride(cwd, () =>
    (agent.getSystemPrompt as (p?: unknown) => string)({}),
  )
}

test('default profile: no locale bias in PA/DB/MOB prompts', () => {
  expect(getProfileFragment('PA-AGENT')).toBeNull()
  expect(prompt(PA_AGENT)).not.toMatch(/Bakong|KHQR/i)
  expect(prompt(DB_AGENT)).not.toMatch(/KHR|utf8mb4/i)
  expect(prompt(MOB_AGENT)).not.toMatch(/Khmer/i)
})

test('config projectProfile=cambodia injects locale fragments', () => {
  writeConfig({ providers: [], projectProfile: 'cambodia' })
  expect(prompt(PA_AGENT)).toMatch(/Bakong|KHQR/)
  const db = prompt(DB_AGENT)
  expect(db).toMatch(/KHR/)
  expect(db).toMatch(/utf8mb4/)
  expect(prompt(MOB_AGENT)).toMatch(/Khmer/)
})

test('auto-selects cambodia from shared.json constraints', () => {
  writeShared(['Targets the Cambodia market'])
  expect(prompt(PA_AGENT)).toMatch(/Bakong|KHQR/)
})

test('loadProfile falls back to no-bias default for unknown names', () => {
  expect(loadProfile('atlantis').name).toBe('default')
  expect(Object.keys(loadProfile('atlantis').fragmentsByAgent)).toHaveLength(0)
})
