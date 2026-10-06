/**
 * The effort pill must keep the level the engine acknowledged.
 *
 * Regression: choosing High (or any level) and then opening the model dropdown,
 * picking a model, or signing in reverted the pill to Auto. Each of those runs a
 * catalogue refresh in a SEPARATE helper process (`--rayucode-connect models`),
 * and that helper derived `effort` from the terminal CLI's `settings.json` —
 * which Rayucode never writes, because its effort lives in
 * `rayucode-preferences.json`. Applying the helper's whole inference object
 * therefore replaced the session's acknowledged effort with Auto.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import type { InferenceSettingsView } from '../src/vscode/shared/inferenceSettings.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

/** What the refresh helper reports: capabilities are right, the choices are the CLI's. */
const REFRESHED: InferenceSettingsView = {
  supportsEffort: true,
  supportedLevels: ['low', 'medium', 'high', 'max'],
  effort: null,
  effortEnvOverride: null,
  supportsThinking: true,
  thinkingEnabled: false,
}

const ACKNOWLEDGED_HIGH: InferenceSettingsView = {
  supportsEffort: true,
  supportedLevels: ['low', 'medium', 'high'],
  effort: 'high',
  effortEnvOverride: null,
  supportsThinking: true,
  thinkingEnabled: true,
}

const savedEnv = {
  auth: process.env.RAYU_AUTH_CONFIG_DIR,
  config: process.env.RAYU_CONFIG_DIR,
}
let dir = ''

beforeEach(() => {
  // Sandbox both profiles so nothing here can read or write the developer's real config.
  dir = mkdtempSync(join(tmpdir(), 'rayucode-effort-'))
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  process.env.RAYU_CONFIG_DIR = dir
})

afterEach(() => {
  if (savedEnv.auth === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = savedEnv.auth
  if (savedEnv.config === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedEnv.config
  rmSync(dir, { recursive: true, force: true })
})

function liveSession(
  onUpdate: (settings: InferenceSettingsView) => void,
  respond: (method: string) => Record<string, unknown> = () => ({}),
): ChatSession {
  const session = new ChatSession(
    { enginePath: '/unused', cwd: dir },
    sessionCallbacks({ onInferenceSettings: onUpdate }),
  )
  ;(session as any).starting = Promise.resolve()
  ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
  ;(session as any).control = {
    request: async (method: string) => respond(method),
    dispose: () => {},
  }
  return session
}

test('a catalogue refresh does not revert an acknowledged effort to Auto', async () => {
  const updates: InferenceSettingsView[] = []
  const session = liveSession(
    settings => updates.push(settings),
    method => (method === 'get_settings' ? { inference: ACKNOWLEDGED_HIGH } : {}),
  )
  try {
    await session.setEffort('high')
    expect(session.currentInference.effort).toBe('high')

    // The profile now says something else — another conversation, say. The running
    // engine's acknowledged choices still win: that is what it is actually using.
    writeFileSync(
      join(dir, 'rayucode-preferences.json'),
      JSON.stringify({ effort: 'low', thinkingEnabled: false }),
    )
    session.applyInitialInference(REFRESHED)

    expect(session.currentInference.effort).toBe('high')
    expect(updates.at(-1)?.effort).toBe('high')
    // Capabilities still come from the refresh: that is what it exists to deliver.
    expect(session.currentInference.supportedLevels).toEqual(['low', 'medium', 'high', 'max'])
    // Thinking follows this session's preference, not the CLI's `alwaysThinkingEnabled`.
    expect(session.currentInference.thinkingEnabled).toBe(true)
  } finally {
    session.dispose()
  }
})

test('a refresh before the engine acknowledges shows the persisted Rayucode effort', () => {
  writeFileSync(join(dir, 'rayucode-preferences.json'), JSON.stringify({ effort: 'medium' }))
  const session = new ChatSession({ enginePath: '/unused', cwd: dir }, sessionCallbacks())
  try {
    session.applyInitialInference(REFRESHED)
    // The level the engine will start with (`initialEffortForProduct`), not the CLI's.
    expect(session.currentInference.effort).toBe('medium')
  } finally {
    session.dispose()
  }
})

test('before an engine exists, the choices shown are the ones persisted NOW', () => {
  const preferences = join(dir, 'rayucode-preferences.json')
  writeFileSync(preferences, JSON.stringify({ effort: 'medium', thinkingEnabled: true }))
  const session = new ChatSession({ enginePath: '/unused', cwd: dir }, sessionCallbacks())
  try {
    // Another conversation changes both after this one was created. This one's engine
    // will start from the profile, so its pills must show the profile.
    writeFileSync(preferences, JSON.stringify({ effort: 'high', thinkingEnabled: false }))
    session.applyInitialInference(REFRESHED)
    expect(session.currentInference.effort).toBe('high')
    expect(session.currentInference.thinkingEnabled).toBe(false)

    // Cleared back to Auto elsewhere: Auto here too.
    writeFileSync(preferences, JSON.stringify({ thinkingEnabled: false }))
    session.applyInitialInference(REFRESHED)
    expect(session.currentInference.effort).toBeNull()
  } finally {
    session.dispose()
  }
})

test('an environment override reported by the refresh still wins', () => {
  writeFileSync(join(dir, 'rayucode-preferences.json'), JSON.stringify({ effort: 'medium' }))
  const session = new ChatSession({ enginePath: '/unused', cwd: dir }, sessionCallbacks())
  try {
    session.applyInitialInference({ ...REFRESHED, effort: 'low', effortEnvOverride: 'low' })
    expect(session.currentInference.effort).toBe('low')
    expect(session.currentInference.effortEnvOverride).toBe('low')
  } finally {
    session.dispose()
  }
})

test('selecting a model never guesses effort support from thinking support', async () => {
  const updates: InferenceSettingsView[] = []
  // `set_model` never answers, so only the optimistic update is observable.
  let release: () => void = () => {}
  const pending = new Promise<Record<string, unknown>>(resolve => {
    release = () => resolve({ inference: ACKNOWLEDGED_HIGH })
  })
  const session = liveSession(
    settings => updates.push(settings),
    method => (method === 'set_model' ? (pending as never) : {}),
  )
  try {
    session.applyInitialInference(ACKNOWLEDGED_HIGH)
    // An OpenAI-compatible model: effort is mapped onto the target protocol, but the
    // catalogue does not advertise extended thinking for it.
    session.availableModels = {
      options: [{ value: 'gpt-x', label: 'gpt-x', description: '', supportsThinking: false }],
      loading: false,
      error: null,
    }
    const change = session.setModel('gpt-x')
    await new Promise(resolve => setTimeout(resolve, 0))

    const optimistic = updates.at(-1)!
    expect(optimistic.supportsThinking).toBe(false)
    // Before the fix this hid the effort pill (or showed an Auto-only list) until the
    // engine answered — and for a re-selected model it never answered at all.
    expect(optimistic.supportsEffort).toBe(true)
    expect(optimistic.supportedLevels).toEqual(['low', 'medium', 'high'])

    release()
    await change
  } finally {
    session.dispose()
  }
})


test('the Thinking pill toggles through set_thinking and the choice survives a refresh', async () => {
  // Regression: the webview sent `setThinking` but the host had no handler, so the pill
  // did nothing at all.
  const updates: InferenceSettingsView[] = []
  const requests: Array<[string, unknown]> = []
  const session = liveSession(
    settings => updates.push(settings),
    method => {
      if (method === 'set_thinking') {
        return { inference: { ...ACKNOWLEDGED_HIGH, thinkingEnabled: false } }
      }
      return {}
    },
  )
  const control = (session as any).control
  const original = control.request
  control.request = async (method: string, payload: unknown) => {
    requests.push([method, payload])
    return original(method, payload)
  }
  try {
    session.applyInitialInference(ACKNOWLEDGED_HIGH)
    expect(session.currentInference.thinkingEnabled).toBe(true)

    await session.setThinking(false)

    expect(requests).toContainEqual(['set_thinking', { enabled: false }])
    expect(session.currentInference.thinkingEnabled).toBe(false)
    expect(updates.at(-1)?.thinkingEnabled).toBe(false)
    // A later catalogue refresh must not switch it back on, and a respawn must not either.
    session.applyInitialInference(REFRESHED)
    expect(session.currentInference.thinkingEnabled).toBe(false)
    expect((session as any).thinkingPreference).toBe(false)
  } finally {
    session.dispose()
  }
})

test('a refused thinking toggle leaves the pill as it was and reports why', async () => {
  const errors: string[] = []
  const session = new ChatSession(
    { enginePath: '/unused', cwd: dir },
    sessionCallbacks({ onError: message => errors.push(message) }),
  )
  ;(session as any).starting = Promise.resolve()
  ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
  ;(session as any).control = {
    request: async () => {
      throw new Error('preferences are read-only')
    },
    dispose: () => {},
  }
  try {
    session.applyInitialInference(ACKNOWLEDGED_HIGH)
    await session.setThinking(false)
    expect(session.currentInference.thinkingEnabled).toBe(true)
    expect(errors.at(-1)).toContain('preferences are read-only')
  } finally {
    session.dispose()
  }
})
