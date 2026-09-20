/**
 * `/subagent_models` and `/webfetch_model` as Rayucode host commands.
 *
 * The parser is the risky part and it is pure, so it is tested directly. The single most
 * important property is the FALL-THROUGH: a prompt that merely mentions one of these names
 * must reach the model unchanged, because intercepting it would silently swallow the user's
 * message.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _resetRayuConfigCache } from '../src/utils/rayuConfig.js'
import {
  applySelection,
  buildChooser,
  describeReset,
  describeSelection,
  parseModelSettingCommand,
} from '../src/vscode/host/models/modelSettingCommands.js'

const AGENTS = ['planner', 'builder', 'review']

describe('parsing', () => {
  test('a bare command opens the picker', () => {
    expect(parseModelSettingCommand('/subagent_models', AGENTS)).toEqual({
      kind: 'choose',
      target: 'subagent',
    })
    // Old spellings remain compatibility aliases.
    expect(parseModelSettingCommand('/model_subagent', AGENTS)).toEqual({
      kind: 'choose',
      target: 'subagent',
    })
    expect(parseModelSettingCommand('/subagent_model', AGENTS)).toEqual({
      kind: 'choose',
      target: 'subagent',
    })
    expect(parseModelSettingCommand('/webfetch_model', AGENTS)).toEqual({
      kind: 'choose',
      target: 'webfetch',
    })
    // Trailing whitespace is still a bare command.
    expect(parseModelSettingCommand('  /webfetch_model   ', AGENTS)).toEqual({
      kind: 'choose',
      target: 'webfetch',
    })
  })

  test('the CLI reset and show keywords are all accepted', () => {
    for (const word of ['default', 'reset', 'clear']) {
      expect(parseModelSettingCommand(`/webfetch_model ${word}`, AGENTS)).toEqual({
        kind: 'reset',
        target: 'webfetch',
      })
    }
    for (const word of ['show', 'info', 'status']) {
      expect(parseModelSettingCommand(`/webfetch_model ${word}`, AGENTS)).toEqual({
        kind: 'show',
        target: 'webfetch',
      })
    }
    // Case-insensitive, as the CLI lowercases its sub-command.
    expect(parseModelSettingCommand('/webfetch_model SHOW', AGENTS)).toEqual({
      kind: 'show',
      target: 'webfetch',
    })
  })

  test('an agent type may precede the sub-command, resolved case-insensitively', () => {
    expect(parseModelSettingCommand('/subagent_models builder', AGENTS)).toEqual({
      kind: 'choose',
      target: 'subagent',
      agentType: 'builder',
    })
    expect(parseModelSettingCommand('/subagent_models BUILDER show', AGENTS)).toEqual({
      kind: 'show',
      target: 'subagent',
      agentType: 'builder',
    })
    expect(parseModelSettingCommand('/subagent_models review default', AGENTS)).toEqual({
      kind: 'reset',
      target: 'subagent',
      agentType: 'review',
    })
  })

  test('an unrecognised argument returns usage rather than being sent to the model', () => {
    const result = parseModelSettingCommand('/subagent_models nonsense', AGENTS)
    expect(result?.kind).toBe('usage')
    expect(result?.kind === 'usage' && result.message).toContain('/subagent_models [AGENT] [show|default]')
    // The known agent list is offered, so the user can see what a valid token looks like.
    expect(result?.kind === 'usage' && result.message).toContain('planner, builder, review')
  })

  test('runtime-defined agent types are unknown before the engine reports them', () => {
    // With no runtime list, a custom agent name is indistinguishable from a bad
    // sub-command, so usage is safer than silently treating it as a global change.
    const result = parseModelSettingCommand('/subagent_models builder', [])
    expect(result?.kind).toBe('usage')
  })

  test('built-in agent types are available before the engine reports custom agents', () => {
    expect(parseModelSettingCommand('/subagent_models general-purpose', [])).toEqual({
      kind: 'choose',
      target: 'subagent',
      agentType: 'general-purpose',
    })
  })

  test('ordinary prompts are NOT intercepted', () => {
    // This is the property that matters most: a false positive eats the user's message.
    for (const text of [
      'how do I use /subagent_models?',
      'explain webfetch_model to me',
      '/model',
      '/model_subagents',
      '/webfetch_models show',
      'tell me about the /webfetch_model command',
      '',
      'hello',
    ]) {
      expect(parseModelSettingCommand(text, AGENTS)).toBeNull()
    }
  })
})

describe('persistence', () => {
  let dir: string
  let previous: string | undefined
  let previousAuthConfigDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayucode-model-setting-'))
    previous = process.env.RAYU_CONFIG_DIR
    previousAuthConfigDir = process.env.RAYU_AUTH_CONFIG_DIR
    delete process.env.RAYU_AUTH_CONFIG_DIR
    process.env.RAYU_CONFIG_DIR = dir
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify({
        activeProvider: 'openai',
        providers: [{ id: 'openai', kind: 'openai-compatible', defaultModel: 'gpt-4o' }],
      }),
      { mode: 0o600 },
    )
    _resetRayuConfigCache()
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = previous
    if (previousAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = previousAuthConfigDir
    _resetRayuConfigCache()
    rmSync(dir, { recursive: true, force: true })
  })

  test('WebFetch stores the bare model, without a provider prefix', () => {
    // getWebFetchModel() resolves it against the active provider, so a prefix here would
    // be a second, conflicting routing decision.
    expect(applySelection('webfetch', 'openai\u0000gpt-4o-mini')).toContain('gpt-4o-mini')
    expect(describeSelection('webfetch')).toBe('WebFetch model: gpt-4o-mini')
    expect(buildChooser('webfetch').current).toBe('gpt-4o-mini')
  })

  test('a subagent stores provider AND model, because it may run elsewhere', () => {
    expect(applySelection('subagent', 'anthropic\u0000claude-haiku-4-5')).toContain('anthropic')
    expect(describeSelection('subagent')).toBe('all agents model: claude-haiku-4-5 (anthropic)')
  })

  test('a subagent choice with no provider prefix is refused, not half-written', () => {
    // Half a routing decision is worse than none: the engine would need both.
    expect(applySelection('subagent', 'claude-haiku-4-5')).toBeNull()
    expect(describeSelection('subagent')).toContain('default')
  })

  test('per-agent overrides are independent, and clearing one falls back to the global', () => {
    applySelection('subagent', 'anthropic\u0000global-model')
    applySelection('subagent', 'openai\u0000builder-model', 'builder')
    expect(describeSelection('subagent')).toContain('global-model')
    expect(describeSelection('subagent', 'builder')).toContain('builder-model')

    // Clearing the agent override leaves the GLOBAL default in place, and the agent then
    // reports that — which is the CLI's own fallback chain (per-agent → global → the
    // provider's instant model), not a stale read.
    applySelection('subagent', null, 'builder')
    expect(describeSelection('subagent', 'builder')).toContain('global-model')
    expect(describeSelection('subagent')).toContain('global-model')

    // Only once the global is cleared too does either report the built-in default.
    applySelection('subagent', null)
    expect(describeSelection('subagent', 'builder')).toContain('default')
    expect(describeSelection('subagent')).toContain('default')
  })

  test('reset wording names the actual fallback, not just the word "default"', () => {
    expect(describeReset('webfetch')).toContain('instant/small-fast model')
    expect(describeReset('subagent')).toContain('each agent uses its built-in default')
    expect(describeReset('subagent', 'builder')).toContain('global agent model')
  })

  test('the chooser carries the current selection and the default explanation', () => {
    applySelection('subagent', 'openai\u0000o4-mini')
    const chooser = buildChooser('subagent')
    expect(chooser.target).toBe('subagent')
    expect(chooser.current).toBe('o4-mini')
    expect(chooser.tip).toContain('overkill')
    expect(chooser.defaultNote).toBeTruthy()
    expect(chooser.title).toContain('all agents')
    expect(chooser.agentTypes).toEqual([
      'general-purpose',
      'Explore',
      'planner',
    ])
    const scopedChooser = buildChooser('subagent', 'builder', ['builder'])
    expect(scopedChooser.title).toContain('builder')
    expect(scopedChooser.agentTypes).toContain('builder')
    expect(buildChooser('webfetch').agentTypes).toBeUndefined()
  })
})
