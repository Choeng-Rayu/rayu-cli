/**
 * The composer's slash menu is built from the engine's command descriptors, and `/clear`
 * (with `/reset` and `/new`) is answered by the host.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildSlashItems } from '../src/vscode/webview/components/slashCommandMenu.ts'
import { parseClearCommand } from '../src/vscode/host/panel/clearCommand.ts'
import type {
  RuntimeCommandView,
  SlashCommandView,
} from '../src/vscode/shared/webviewProtocol.ts'

const ROOT = resolve(import.meta.dir, '..')

function descriptor(
  name: string,
  overrides: Partial<RuntimeCommandView> = {},
): RuntimeCommandView {
  return {
    name,
    description: `${name} description`,
    aliases: [],
    argumentHint: '',
    executionKind: 'local',
    surface: 'action',
    origin: 'builtin',
    available: true,
    workflow: false,
    sensitive: false,
    ...overrides,
  }
}

const commands: SlashCommandView[] = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'compact', description: 'Compact the conversation', argumentHint: '[instructions]' },
  { name: 'doctor', description: 'Diagnose setup' },
  { name: 'effort', description: 'Set effort' },
  { name: 'btw', description: 'Side question' },
]

const runtime: RuntimeCommandView[] = [
  descriptor('clear', { aliases: ['reset', 'new'] }),
  descriptor('compact', { argumentHint: '[instructions]' }),
  descriptor('doctor', { available: false, unavailableReason: 'No Rayucode surface yet.' }),
  descriptor('effort', { argumentHint: '[low|medium|high]' }),
]

const labels = (items: ReturnType<typeof buildSlashItems>): string[] =>
  items.map(item => item.label)

describe('buildSlashItems', () => {
  test('hides commands the descriptors mark unavailable', () => {
    expect(labels(buildSlashItems('', commands, runtime))).not.toContain('/doctor')
    expect(labels(buildSlashItems('doc', commands, runtime))).toEqual([])
  })

  test('shows a command that has no descriptor as-is', () => {
    // `btw` has no descriptor: the window before the first runtime snapshot, or an older
    // attached CLI. It must still be offered.
    expect(labels(buildSlashItems('btw', commands, runtime))).toEqual(['/btw'])
    expect(labels(buildSlashItems('', commands, []))).toContain('/doctor')
  })

  test('carries the argument hint from the command or its descriptor', () => {
    const items = buildSlashItems('', commands, runtime)
    expect(items.find(item => item.label === '/compact')?.hint).toBe('[instructions]')
    // `effort` only has the hint on the descriptor.
    expect(items.find(item => item.label === '/effort')?.hint).toBe('[low|medium|high]')
    expect(items.find(item => item.label === '/clear')?.hint).toBeUndefined()
  })

  test('matches an alias and resolves it to the canonical command', () => {
    const [item, ...rest] = buildSlashItems('new', commands, runtime)
    expect(rest).toEqual([])
    expect(item?.label).toBe('/clear')
    expect(item?.insertText).toBe('/clear ')
    expect(item?.description).toContain('/new → /clear')
  })

  test('does not annotate a direct name match', () => {
    const [item] = buildSlashItems('cle', commands, runtime)
    expect(item?.label).toBe('/clear')
    expect(item?.description).toBe('Clear the conversation')
  })

  test('ranks prefix matches before substring matches, names before aliases', () => {
    const list: SlashCommandView[] = [
      { name: 'recompact', description: '' },
      { name: 'plan', description: '' },
      { name: 'compact', description: '' },
      { name: 'cleanup', description: '' },
    ]
    const described = [descriptor('plan', { aliases: ['comp-plan'] })]
    // `compact` (name prefix) < `plan` (alias prefix) < `recompact` (name substring).
    expect(labels(buildSlashItems('comp', list, described))).toEqual([
      '/compact',
      '/plan',
      '/recompact',
    ])
  })

  test('is case-insensitive and keeps the engine order within a rank', () => {
    expect(labels(buildSlashItems('C', commands, runtime))).toEqual(['/clear', '/compact'])
  })
})

describe('parseClearCommand', () => {
  test.each(['/clear', '/reset', '/new', '  /clear  ', '/new\n'])('accepts %j', text => {
    expect(parseClearCommand(text)).toBe(true)
  })

  test.each(['/clearfoo', '/clear x', '/clea', 'clear', '/news', '/', '', 'please /clear'])(
    'rejects %j',
    text => {
      expect(parseClearCommand(text)).toBe(false)
    },
  )
})

describe('Rayucode wiring', () => {
  const source = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

  test('the host answers /clear only for its own engine, before the other host commands', () => {
    const host = source('src/vscode/host/extension.ts')
    const clear = host.indexOf('parseClearCommand(text)')
    expect(clear).toBeGreaterThan(-1)
    expect(host.slice(clear - 20, clear)).toContain('!cli &&')
    expect(clear).toBeLessThan(host.indexOf('rayucodeHostSlashCommand(text)'))
    expect(host).toContain('startFreshConversation(entry)')
  })

  test('clear is listed up front and no longer a hardcoded fallback duplicate', () => {
    const handle = source('src/vscode/host/panel/sessionHandle.ts')
    const defaults = handle.slice(handle.indexOf('const RAYUCODE_SLASH_COMMANDS'))
    expect(defaults).toContain("name: 'clear'")
    expect(defaults.match(/name: 'clear'/g)).toHaveLength(1)
    // The host-answered editor screens are offered before initialize, exactly once.
    const listed = defaults.slice(0, defaults.indexOf('function withRayucodeSlashCommands'))
    for (const name of [
      'permissions',
      'memory',
      'doctor',
      'status',
      'stats',
      'hooks',
      'add-dir',
      'export',
      'help',
    ]) {
      expect(listed.match(new RegExp(`name: '${name}'`, 'g'))).toHaveLength(1)
    }
  })
})
