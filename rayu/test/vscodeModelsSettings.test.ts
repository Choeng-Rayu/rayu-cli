/**
 * Settings → Models: the untrusted-tab boundary and the section's reads and writes.
 *
 * The write path is exercised against a real temp `providers.json` (as
 * `vscodeModelSettingCommands.test.ts` does), because the point is that the tab goes through
 * the CLI's own setters rather than keeping a second copy of the settings.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _resetRayuConfigCache } from '../src/utils/rayuConfig.js'
import type { ModelOptionView } from '../src/vscode/shared/webviewProtocol.js'
import type { ModelsSettingsView } from '../src/vscode/shared/settingsProtocol.js'
import {
  dispatchSettingsMessage,
  type SettingsHandlers,
} from '../src/vscode/host/settings/settingsDispatch.js'
import {
  ModelsSettings,
  type CatalogueOutcome,
  type ModelsSettingsDeps,
} from '../src/vscode/host/settings/modelsSettings.js'

function recordingHandlers(): { handlers: SettingsHandlers; calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    handlers: {
      ready: () => calls.push(['ready']),
      selectSection: section => calls.push(['selectSection', section]),
      openExtensionSettings: () => calls.push(['openExtensionSettings']),
      updateSetting: (key, value) => calls.push(['updateSetting', key, value]),
      refreshGeneral: () => calls.push(['refreshGeneral']),
      openModelSetting: (target, agentType) => calls.push(['openModelSetting', target, agentType]),
      chooseModelSetting: (target, value, agentType) => calls.push(['chooseModelSetting', target, value, agentType]),
      closeModelSetting: () => calls.push(['closeModelSetting']),
      refreshModels: () => calls.push(['refreshModels']),
      refreshAccount: () => calls.push(['refreshAccount']),
      accountAction: action => calls.push(['accountAction', action]),
      openAccountLink: link => calls.push(['openAccountLink', link]),
      removeDevice: deviceId => calls.push(['removeDevice', deviceId]),
      refreshIntegrations: () => calls.push(['refreshIntegrations']),
      telegramStartHosted: () => calls.push(['telegramStartHosted']),
      telegramStartByo: token => calls.push(['telegramStartByo', token]),
      telegramUnlink: () => calls.push(['telegramUnlink']),
      webBridgeAction: action => calls.push(['webBridgeAction', action]),
      setUpGitHub: () => calls.push(['setUpGitHub']),
    },
  }
}

describe('settingsModels dispatch', () => {
  test('open, choose, close and refresh reach their handlers', () => {
    const { handlers, calls } = recordingHandlers()
    expect(dispatchSettingsMessage({ type: 'settingsModelsOpen', target: 'subagent', agentType: 'builder' }, handlers)).toBe(true)
    expect(dispatchSettingsMessage({ type: 'settingsModelsChoose', target: 'webfetch', value: null }, handlers)).toBe(true)
    expect(dispatchSettingsMessage({ type: 'settingsModelsChoose', target: 'image', value: 'rayu-wan2.7-image' }, handlers)).toBe(true)
    expect(dispatchSettingsMessage({ type: 'settingsModelsClose' }, handlers)).toBe(true)
    expect(dispatchSettingsMessage({ type: 'settingsModelsRefresh' }, handlers)).toBe(true)
    expect(calls).toEqual([
      ['openModelSetting', 'subagent', 'builder'],
      ['chooseModelSetting', 'webfetch', null, undefined],
      ['chooseModelSetting', 'image', 'rayu-wan2.7-image', undefined],
      ['closeModelSetting'],
      ['refreshModels'],
    ])
  })

  test('an unknown target, an oversized value or an oversized agent type is rejected', () => {
    const { handlers, calls } = recordingHandlers()
    for (const message of [
      null,
      { type: 'settingsModelsOpen' },
      { type: 'settingsModelsOpen', target: 'everything' },
      { type: 'settingsModelsChoose', target: 'subagent' },
      { type: 'settingsModelsChoose', target: 'subagent', value: 7 },
      { type: 'settingsModelsChoose', target: 'subagent', value: 'x'.repeat(513) },
      { type: 'settingsModelsChoose', target: 'subagent', value: 'model', agentType: 'a'.repeat(129) },
      // An agent scope only exists for the subagent setting.
      { type: 'settingsModelsChoose', target: 'image', value: 'm', agentType: 'builder' },
    ]) {
      expect(dispatchSettingsMessage(message, handlers)).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test('an extra field never reaches a handler', () => {
    const { handlers, calls } = recordingHandlers()
    expect(dispatchSettingsMessage({ type: 'settingsModelsChoose', target: 'webfetch', value: 'm', path: '/etc/passwd' }, handlers)).toBe(true)
    expect(calls).toEqual([['chooseModelSetting', 'webfetch', 'm', undefined]])
  })
})

const AGENTS = ['builder', 'review'] as const

function option(value: string, model?: string): ModelOptionView {
  return { value, label: model ?? value, description: `${model ?? value} · test`, ...(model ? { model } : {}) }
}

function catalogue(options: ModelOptionView[] = [option('openai\u0000gpt-4o', 'gpt-4o')]): CatalogueOutcome {
  return { ok: true, options }
}

interface Harness {
  section: ModelsSettings
  views: ModelsSettingsView[]
  saved: string[]
  providerLoads: number
  mediaLoads: string[]
}

function harness(overrides: Partial<ModelsSettingsDeps> = {}): Harness {
  const views: ModelsSettingsView[] = []
  const saved: string[] = []
  const mediaLoads: string[] = []
  let providerLoads = 0
  const deps: ModelsSettingsDeps = {
    loadProviderCatalogue: async () => {
      providerLoads++
      return catalogue()
    },
    loadMediaCatalogue: async target => {
      mediaLoads.push(target)
      return catalogue([option('rayu-wan2.7-image')])
    },
    knownAgentTypes: () => [...AGENTS],
    onSaved: target => saved.push(target),
    ...overrides,
  }
  const section = new ModelsSettings(deps, view => views.push(view))
  return {
    section,
    views,
    saved,
    get providerLoads() {
      return providerLoads
    },
    mediaLoads,
  }
}

/** Lets a queued catalogue load settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('ModelsSettings', () => {
  let dir: string
  let previousConfigDir: string | undefined
  let previousAuthConfigDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayucode-models-settings-'))
    previousConfigDir = process.env.RAYU_CONFIG_DIR
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
    if (previousConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = previousConfigDir
    if (previousAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = previousAuthConfigDir
    _resetRayuConfigCache()
    rmSync(dir, { recursive: true, force: true })
  })

  test('loads the subagent default, one row per agent type, then image, video and WebFetch', () => {
    const h = harness()
    h.section.refresh()
    expect(h.section.current.status).toBe('ready')
    expect(h.section.current.rows.map(row => [row.target, row.agentType])).toEqual([
      ['subagent', undefined],
      ['subagent', 'general-purpose'],
      ['subagent', 'Explore'],
      ['subagent', 'planner'],
      ['subagent', 'builder'],
      ['subagent', 'review'],
      ['image', undefined],
      ['video', undefined],
      ['webfetch', undefined],
    ])
    // Every row words what is saved now, as the CLI's `show` does.
    expect(h.section.current.rows[0]?.summary).toContain('default')
    expect(h.section.current.rows.at(-1)?.summary).toContain('WebFetch model')
    expect(h.section.current.rows.every(row => row.current === null)).toBe(true)
  })

  test('image and video load the media catalogue; subagent and WebFetch load the provider one', async () => {
    const h = harness()
    h.section.refresh()

    await h.section.open('image')
    await h.section.open('video')
    expect(h.mediaLoads).toEqual(['image', 'video'])
    expect(h.providerLoads).toBe(0)

    await h.section.open('subagent')
    await h.section.open('webfetch')
    expect(h.providerLoads).toBe(2)
    expect(h.section.current.editor?.target).toBe('webfetch')
    expect(h.section.current.editor?.catalogue.loading).toBe(false)
    expect(h.section.current.editor?.catalogue.options).toHaveLength(1)
  })

  test('a catalogue failure is shown in the editor, not as a crash', async () => {
    const h = harness({ loadMediaCatalogue: async () => ({ ok: false, error: 'No image models.' }) })
    await h.section.open('image')
    expect(h.section.current.editor?.catalogue).toEqual({ options: [], loading: false, error: 'No image models.' })
  })

  test('choosing saves through applySelection, notifies and refreshes the rows', () => {
    const h = harness()
    h.section.refresh()
    h.section.choose('subagent', 'openai\u0000gpt-4o')
    expect(h.saved).toEqual(['subagent'])
    expect(h.section.current.editor).toBeNull()
    expect(h.section.current.notice).toContain('gpt-4o')
    const defaultRow = h.section.current.rows.find(row => row.target === 'subagent' && row.agentType === undefined)
    expect(defaultRow?.current).toBe('gpt-4o')
    expect(defaultRow?.summary).toBe('all agents model: gpt-4o (openai)')
  })

  test('a reset sends null and clears the value', () => {
    const h = harness()
    h.section.choose('subagent', 'openai\u0000gpt-4o')
    h.section.choose('subagent', null)
    expect(h.saved).toEqual(['subagent', 'subagent'])
    expect(h.section.current.notice).toContain('reset to default')
    expect(h.section.current.rows.find(row => row.target === 'subagent')?.current).toBeNull()
  })

  test('a per-agent override is independent of the subagent default', () => {
    const h = harness()
    const row = (agentType?: string): string | null | undefined =>
      h.section.current.rows.find(r => r.target === 'subagent' && r.agentType === agentType)?.current

    h.section.choose('subagent', 'openai\u0000builder-model', 'builder')
    expect(h.saved).toEqual(['subagent'])
    expect(row()).toBeNull()
    expect(row('builder')).toBe('builder-model')

    h.section.choose('subagent', 'openai\u0000global-model')
    expect(row()).toBe('global-model')
    expect(row('builder')).toBe('builder-model')

    // Clearing the override falls back to the global default, as the CLI does.
    h.section.choose('subagent', null, 'builder')
    expect(row('builder')).toBe('global-model')
    expect(row()).toBe('global-model')
  })

  test('a null applySelection result is reported as an error on the row, not saved', async () => {
    const h = harness()
    h.section.refresh()
    await h.section.open('subagent')
    // A subagent value without a provider prefix is half a routing decision.
    h.section.choose('subagent', 'no-provider-prefix')
    expect(h.saved).toEqual([])
    expect(h.section.current.editor?.error).toContain('cannot be used')
    expect(h.section.current.rows.find(row => row.target === 'subagent')?.current).toBeNull()
  })

  test('an agent type the engine did not report is refused before it is stored', async () => {
    const h = harness()
    await h.section.open('subagent', 'mystery')
    expect(h.section.current.error).toContain('not one Rayu can configure')

    h.section.refresh()
    h.section.choose('subagent', 'openai\u0000gpt-4o', 'mystery')
    expect(h.saved).toEqual([])
    expect(h.section.current.error).toContain('not one Rayu can configure')
  })

  test('closing drops the editor but keeps the loaded rows', async () => {
    const h = harness()
    h.section.refresh()
    await h.section.open('webfetch')
    expect(h.section.current.editor).not.toBeNull()
    h.section.close()
    expect(h.section.current.editor).toBeNull()
    expect(h.section.current.rows).toHaveLength(9)
  })

  test('a load that finishes after the editor closed is dropped', async () => {
    let release: (outcome: CatalogueOutcome) => void = () => {}
    const h = harness({
      loadProviderCatalogue: () => new Promise<CatalogueOutcome>(resolve => { release = resolve }),
    })
    const opening = h.section.open('webfetch')
    h.section.close()
    release(catalogue())
    await opening
    await settle()
    expect(h.section.current.editor).toBeNull()
  })
})
