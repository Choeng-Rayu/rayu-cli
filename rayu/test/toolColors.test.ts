import { expect, test } from 'bun:test'
import { getTheme, THEME_NAMES, type Theme } from '../src/utils/theme.ts'
import { getToolNameColor } from '../src/utils/toolColors.ts'

test('execution tools map to toolExecute', () => {
  expect(getToolNameColor('Bash')).toBe('toolExecute')
  expect(getToolNameColor('PowerShell')).toBe('toolExecute')
  expect(getToolNameColor('REPL')).toBe('toolExecute')
})

test('read/inspect tools map to toolRead', () => {
  expect(getToolNameColor('Read')).toBe('toolRead')
  expect(getToolNameColor('LSP')).toBe('toolRead')
})

test('search/discovery tools map to toolSearch', () => {
  expect(getToolNameColor('Grep')).toBe('toolSearch')
  expect(getToolNameColor('Glob')).toBe('toolSearch')
  expect(getToolNameColor('WebSearch')).toBe('toolSearch')
  expect(getToolNameColor('ToolSearch')).toBe('toolSearch')
  expect(getToolNameColor('ListMcpResourcesTool')).toBe('toolSearch')
})

test('edit/write tools map to toolEdit', () => {
  expect(getToolNameColor('Edit')).toBe('toolEdit')
  expect(getToolNameColor('Write')).toBe('toolEdit')
  expect(getToolNameColor('NotebookEdit')).toBe('toolEdit')
  expect(getToolNameColor('TodoWrite')).toBe('toolEdit')
})

test('web/generative tools map to toolWeb', () => {
  expect(getToolNameColor('WebFetch')).toBe('toolWeb')
  expect(getToolNameColor('GenerateImage')).toBe('toolWeb')
  expect(getToolNameColor('GenerateVideo')).toBe('toolWeb')
})

test('orchestration tools map to toolTask', () => {
  expect(getToolNameColor('Agent')).toBe('toolTask')
  expect(getToolNameColor('Task')).toBe('toolTask') // legacy alias
  expect(getToolNameColor('TaskCreate')).toBe('toolTask')
  expect(getToolNameColor('TaskList')).toBe('toolTask')
  expect(getToolNameColor('TeamCreate')).toBe('toolTask')
  expect(getToolNameColor('SendMessage')).toBe('toolTask')
  expect(getToolNameColor('Skill')).toBe('toolTask')
  expect(getToolNameColor('InstallSkill')).toBe('toolTask')
})

test('uncategorized tools and empty input return undefined (default color)', () => {
  expect(getToolNameColor('Config')).toBeUndefined()
  expect(getToolNameColor('AskUserQuestion')).toBeUndefined()
  expect(getToolNameColor('mcp')).toBeUndefined()
  expect(getToolNameColor('EnterPlanMode')).toBeUndefined()
  expect(getToolNameColor('Unknown-Tool')).toBeUndefined()
  expect(getToolNameColor('')).toBeUndefined()
  expect(getToolNameColor(undefined)).toBeUndefined()
})

test('tool-category tokens are defined (non-empty string) in every theme', () => {
  const tokens: (keyof Theme)[] = [
    'toolExecute',
    'toolRead',
    'toolSearch',
    'toolEdit',
    'toolWeb',
    'toolTask',
  ]
  for (const name of THEME_NAMES) {
    const theme = getTheme(name)
    for (const token of tokens) {
      expect(typeof theme[token]).toBe('string')
      expect(theme[token].length).toBeGreaterThan(0)
    }
  }
})

test('getToolNameColor only returns keys that exist on every theme', () => {
  const sampleTools = [
    'Bash',
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'WebFetch',
    'Agent',
    'Skill',
  ]
  for (const name of THEME_NAMES) {
    const theme = getTheme(name)
    for (const toolName of sampleTools) {
      const key = getToolNameColor(toolName)
      expect(key).toBeDefined()
      expect(typeof theme[key as keyof Theme]).toBe('string')
    }
  }
})
