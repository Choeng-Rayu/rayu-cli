import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { parseFrontmatter } from '../src/utils/frontmatterParser.ts'
import {
  getRayuSkillDefinitions,
  registerRayuSkills,
} from '../src/skills/bundled/rayuSkills.ts'

const RAYU_DIR = 'src/skills/bundled/rayu'
const EXPECTED = [
  'rayu-algorithmic-art',
  'rayu-api-design',
  'rayu-brand-guidelines',
  'rayu-canvas-design',
  'rayu-design-system',
  'rayu-doc-export',
  'rayu-frontend-design',
  'rayu-mcp-builder',
  'rayu-theme-factory',
  'rayu-web-artifacts-builder',
  'rayu-web-testing',
]

test('every rayu skill folder has a valid SKILL.md (name matches folder + real content)', () => {
  const folders = readdirSync(RAYU_DIR)
    .filter(n => statSync(join(RAYU_DIR, n)).isDirectory())
    .sort()
  expect(folders).toEqual(EXPECTED)
  for (const folder of folders) {
    const p = join(RAYU_DIR, folder, 'SKILL.md')
    expect(existsSync(p)).toBe(true)
    const { frontmatter, content } = parseFrontmatter(readFileSync(p, 'utf8'))
    expect(frontmatter.name).toBe(folder) // name === folder
    expect(typeof frontmatter.description).toBe('string')
    expect((frontmatter.description as string).length).toBeGreaterThan(20)
    expect(content.trim().length).toBeGreaterThan(200) // substantive body
  }
})

test('getRayuSkillDefinitions returns all six with matching names + bodies', () => {
  const defs = getRayuSkillDefinitions()
  expect(defs.map(d => d.name).sort()).toEqual(EXPECTED)
  for (const d of defs) {
    expect(d.description.length).toBeGreaterThan(20)
    expect(d.body.length).toBeGreaterThan(200)
  }
})

test('rayu skill names are unique and rayu- prefixed (collision guard)', () => {
  const names = getRayuSkillDefinitions().map(d => d.name)
  expect(new Set(names).size).toBe(names.length)
  for (const n of names) expect(n.startsWith('rayu-')).toBe(true)
})

test('registerRayuSkills registers them into getBundledSkills', async () => {
  registerRayuSkills()
  const { getBundledSkills } = await import('../src/skills/bundledSkills.ts')
  const names = getBundledSkills().map(c => c.name)
  for (const e of EXPECTED) expect(names).toContain(e)
})

test('agents are wired to pick the rayu skills by domain', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  expect(
    read('src/tools/AgentTool/built-in/collaborators/frontend/index.ts'),
  ).toContain('rayu-frontend-design')
  expect(
    read('src/tools/AgentTool/built-in/collaborators/backend/index.ts'),
  ).toContain('rayu-api-design')
  expect(
    read('src/tools/AgentTool/built-in/collaborators/security/index.ts'),
  ).toContain('rayu-web-testing')
  expect(read('src/tools/AgentTool/built-in/subagents/common.ts')).toContain(
    'rayu-doc-export',
  )
  // Orchestrator prompt lists every rayu skill.
  const orch = read('src/commands/collaborator-swarm/index.ts')
  for (const e of EXPECTED) expect(orch).toContain(e)
})
