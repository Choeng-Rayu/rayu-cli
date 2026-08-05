import { describe, expect, test } from 'bun:test'
import {
  filterToolsForMcp,
  findExposedTool,
  isToolExposedOverMcp,
  MCP_EXCLUDED_TOOL_REASONS,
  MCP_EXPOSED_TOOL_NAMES,
} from '../src/plugins/mcpServer/toolAdapter.ts'
import type { Tool, Tools } from '../src/Tool.ts'

/**
 * Minimal stand-in for a RAYU tool. Only `name`/`aliases` matter here —
 * filterToolsForMcp is a pure name-based filter, so building real tools would
 * drag the whole registry (and its side effects) into the test.
 */
function fakeTool(name: string, aliases?: string[]): Tool {
  return { name, aliases } as unknown as Tool
}

describe('MCP capability boundary', () => {
  test('exposes the tools the plan requires', () => {
    for (const name of [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'Skill',
      // The billing-gated tool required by the acceptance criteria.
      'GenerateImage',
    ]) {
      expect(isToolExposedOverMcp(name)).toBe(true)
    }
  })

  test('hides session-coupled and TUI-only tools', () => {
    for (const name of [
      'ExitPlanMode',
      'EnterPlanMode',
      'EnterWorktree',
      'ExitWorktree',
      'TestingPermission',
      'AskUserQuestion',
      'TodoWrite',
      'TaskCreate',
      'TaskUpdate',
      'TaskList',
      'TaskGet',
      'TaskStop',
      'TaskOutput',
      'SendMessage',
      'TeamCreate',
      'TeamDelete',
      'ToolSearch',
      'Config',
    ]) {
      expect(isToolExposedOverMcp(name)).toBe(false)
    }
  })

  test('is an allowlist: unknown tools are hidden by default', () => {
    expect(isToolExposedOverMcp('SomeFutureSessionTool')).toBe(false)
    expect(isToolExposedOverMcp('')).toBe(false)
  })

  test('every documented exclusion is actually excluded', () => {
    for (const name of Object.keys(MCP_EXCLUDED_TOOL_REASONS)) {
      expect(isToolExposedOverMcp(name)).toBe(false)
    }
  })

  test('the allowlist has no duplicates', () => {
    expect(new Set(MCP_EXPOSED_TOOL_NAMES).size).toBe(
      MCP_EXPOSED_TOOL_NAMES.length,
    )
  })
})

describe('filterToolsForMcp', () => {
  const tools: Tools = [
    fakeTool('Read'),
    fakeTool('Bash'),
    fakeTool('ExitPlanMode'),
    fakeTool('TodoWrite'),
    fakeTool('GenerateImage'),
    fakeTool('NotARealTool'),
  ]

  test('keeps only allowlisted tools, preserving order', () => {
    expect(filterToolsForMcp(tools).map(t => t.name)).toEqual([
      'Read',
      'Bash',
      'GenerateImage',
    ])
  })

  test('resolves alias-bearing tools (Agent/Task)', () => {
    const withAlias: Tools = [fakeTool('Task', ['Agent'])]
    expect(filterToolsForMcp(withAlias).map(t => t.name)).toEqual(['Task'])
  })

  test('returns an empty list when nothing is exposed', () => {
    expect(filterToolsForMcp([fakeTool('TodoWrite')])).toEqual([])
  })
})

describe('findExposedTool', () => {
  const tools: Tools = [fakeTool('Read'), fakeTool('ExitPlanMode')]

  test('finds an exposed tool', () => {
    expect(findExposedTool(tools, 'Read')?.name).toBe('Read')
  })

  test('refuses a tool that exists but is outside the boundary', () => {
    expect(findExposedTool(tools, 'ExitPlanMode')).toBeUndefined()
  })

  test('returns undefined for an unknown name', () => {
    expect(findExposedTool(tools, 'Nope')).toBeUndefined()
  })

  test('does not resolve an allowlisted name that is not registered', () => {
    expect(findExposedTool(tools, 'Bash')).toBeUndefined()
  })
})
