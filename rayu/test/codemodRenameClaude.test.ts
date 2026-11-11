import { describe, expect, test } from 'bun:test'
import {
  applyEdits,
  detectNameCollisions,
  isExcludedFile,
  isValidNewName,
  mapIdentifierName,
  waveOf,
  type Overrides,
} from '../scripts/codemod-rename-claude.ts'

describe('mapIdentifierName', () => {
  test('case-preserving mechanical mapping', () => {
    expect(mapIdentifierName('getClaudeMds')).toBe('getRayuMds')
    expect(mapIdentifierName('claudeMd')).toBe('rayuMd')
    expect(mapIdentifierName('CLAUDE_AI_OAUTH_SCOPES')).toBe('RAYU_AI_OAUTH_SCOPES')
    expect(mapIdentifierName('ClaudeError')).toBe('RayuError')
  })
  test('compounds map as whole tokens', () => {
    expect(mapIdentifierName('ClaudeCodeAdapter')).toBe('RayuCodeAdapter')
    expect(mapIdentifierName('claudeCodeHints')).toBe('rayuCodeHints')
    expect(mapIdentifierName('CLAUDE_CODE_PROVIDER')).toBe('RAYU_CODE_PROVIDER')
    expect(mapIdentifierName('CLAUDEAI_SUCCESS_URL')).toBe('RAYUAI_SUCCESS_URL')
    expect(mapIdentifierName('claudeAiLimits')).toBe('rayuAiLimits')
  })
  test('names without claude are unchanged', () => {
    expect(mapIdentifierName('getRayuConfigHomeDir')).toBe('getRayuConfigHomeDir')
    expect(mapIdentifierName('plainName')).toBe('plainName')
  })
})

describe('isValidNewName', () => {
  test('accepts valid identifiers without claude', () => {
    expect(isValidNewName('rayuMd')).toBe(true)
    expect(isValidNewName('RayuCodeAdapter')).toBe(true)
    expect(isValidNewName('$rayu_1')).toBe(true)
  })
  test('rejects claude remnants and invalid identifiers', () => {
    expect(isValidNewName('rayuClaude')).toBe(false)
    expect(isValidNewName('CLAUDE_X')).toBe(false)
    expect(isValidNewName('1rayu')).toBe(false)
    expect(isValidNewName('rayu-md')).toBe(false)
    expect(isValidNewName('')).toBe(false)
  })
})

describe('isExcludedFile', () => {
  const prefixes = ['src/types/generated/', 'un-use-code/', 'dist/', 'node_modules/']
  test('excludes generated and dead-code trees', () => {
    expect(isExcludedFile('src/types/generated/events_mono/claude_code/v1/x.ts', prefixes)).toBe(true)
    expect(isExcludedFile('un-use-code/commands/good-claude/index.ts', prefixes)).toBe(true)
    expect(isExcludedFile('node_modules/typescript/lib/typescript.d.ts', prefixes)).toBe(true)
  })
  test('keeps normal source', () => {
    expect(isExcludedFile('src/utils/claudemd.ts', prefixes)).toBe(false)
    expect(isExcludedFile('test/memoryFiles.test.ts', prefixes)).toBe(false)
  })
  test('normalizes windows separators', () => {
    expect(isExcludedFile('src\\types\\generated\\x.ts', prefixes)).toBe(true)
  })
})

describe('applyEdits', () => {
  test('splices back-to-front without offset drift', () => {
    const text = 'const claudeMd = getClaudeMds()'
    const out = applyEdits(text, [
      { start: 6, end: 14, text: 'rayuMd' },
      { start: 17, end: 29, text: 'getRayuMds' },
    ])
    expect(out).toBe('const rayuMd = getRayuMds()')
  })
  test('handles prefix/suffix text for shorthand properties', () => {
    const text = '{ claudeMd }'
    const out = applyEdits(text, [{ start: 2, end: 10, text: 'claudeMd: rayuMd' }])
    expect(out).toBe('{ claudeMd: rayuMd }')
  })
  test('empty edit list is identity', () => {
    expect(applyEdits('unchanged', [])).toBe('unchanged')
  })
})

describe('detectNameCollisions', () => {
  test('flags collision with an existing binding', () => {
    const problems = detectNameCollisions(new Set(['rayu']), [
      { oldName: 'claude', newName: 'rayu' },
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('collides')
  })
  test('flags two symbols mapping to one name', () => {
    const problems = detectNameCollisions(new Set(), [
      { oldName: 'claudeDir', newName: 'rayuDir' },
      { oldName: 'claudeDirectory', newName: 'rayuDir' },
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('both map')
  })
  test('no collision when the name is the symbol itself', () => {
    expect(detectNameCollisions(new Set(['rayuMd']), [{ oldName: 'rayuMd', newName: 'rayuMd' }])).toHaveLength(0)
  })
  test('clean renames pass', () => {
    expect(
      detectNameCollisions(new Set(['other']), [
        { oldName: 'claudeMd', newName: 'rayuMd' },
        { oldName: 'getClaudeMds', newName: 'getRayuMds' },
      ]),
    ).toHaveLength(0)
  })
})

describe('waveOf', () => {
  const ov = {
    wave4Symbols: ['claudeCodeHints', 'CLAUDE_AI_OAUTH_STORAGE_KEY'],
    wave3Globs: ['src/externalAgents/', 'src/commands/agent/'],
    wave2Globs: ['src/services/', 'src/utils/config.ts', 'src/main.tsx'],
  } as unknown as Overrides

  test('persisted members are wave 4 regardless of file', () => {
    expect(waveOf('src/utils/config.ts', 'claudeCodeHints', ov)).toBe(4)
    expect(waveOf('src/services/oauth/claudeAiTokens.ts', 'CLAUDE_AI_OAUTH_STORAGE_KEY', ov)).toBe(4)
  })
  test('external agents are wave 3', () => {
    expect(waveOf('src/externalAgents/adapters/claudeCode/protocol.ts', 'buildClaudeArgs', ov)).toBe(3)
    expect(waveOf('src/commands/agent/index.ts', 'agentCommand', ov)).toBe(3)
  })
  test('engine/services are wave 2', () => {
    expect(waveOf('src/services/api/claude.ts', 'queryModel', ov)).toBe(2)
    expect(waveOf('src/utils/config.ts', 'getManagedClaudeRulesDir', ov)).toBe(2)
    expect(waveOf('src/main.tsx', 'enableClaudeInChrome', ov)).toBe(2)
  })
  test('everything else is wave 1', () => {
    expect(waveOf('src/utils/heatmap.ts', 'claudeOrange', ov)).toBe(1)
    expect(waveOf('src/components/ModelPicker.tsx', 'claudeStatus', ov)).toBe(1)
    expect(waveOf('test/memoryFiles.test.ts', 'claudeDir', ov)).toBe(1)
  })
  test('exact-file globs do not match siblings', () => {
    expect(waveOf('src/utils/configHelpers.ts', 'someClaudeFn', ov)).toBe(1)
  })
})