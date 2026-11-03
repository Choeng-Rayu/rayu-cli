/**
 * The Settings tab's Rayucode-only rows, against a real profile file: they are the same
 * values the chat reads (`readRayucodePreferences`), and saving one keeps the rest.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRayucodePreferences } from '../src/runtime/productPreferences.js'
import { readRayucodeSettings, writeRayucodeSetting } from '../src/vscode/host/settings/rayucodeSettings.js'

const saved = process.env.RAYU_AUTH_CONFIG_DIR
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayucode-profile-'))
  process.env.RAYU_AUTH_CONFIG_DIR = dir
})

afterEach(() => {
  if (saved === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = saved
  rmSync(dir, { recursive: true, force: true })
})

const profilePath = (): string => join(dir, 'rayucode-preferences.json')
const profile = (): Record<string, unknown> => JSON.parse(readFileSync(profilePath(), 'utf8')) as Record<string, unknown>

test('with no profile, a conversation asks first and suggestions are on', () => {
  expect(readRayucodeSettings()).toEqual({ permissionMode: 'default', promptSuggestionEnabled: true })
})

test.each([
  ['acceptEdits', 'acceptEdits'],
  // The old full-access value is shown as the mode the editor offers in its place.
  ['bypassPermissions', 'fullManage'],
  // A mode the engine knows but the editor does not offer starts the cycle over.
  ['dontAsk', 'default'],
  ['not-a-mode', 'default'],
])('a stored mode %p reads as %p', (stored, shown) => {
  writeFileSync(profilePath(), JSON.stringify({ permissionMode: stored }))
  expect(readRayucodeSettings().permissionMode).toBe(shown)
})

test('saving the mode changes the value the chat remembers, and keeps the rest of the profile', () => {
  writeFileSync(profilePath(), JSON.stringify({ effort: 'high', permissionMode: 'default' }))
  expect(writeRayucodeSetting('permissionMode', 'plan')).toEqual({ ok: true, value: true })
  expect(profile()).toEqual({ effort: 'high', permissionMode: 'plan' })
  expect(readRayucodePreferences().permissionMode).toBe('plan')
  // The profile holds preferences only, but it stays private to the user all the same.
  if (process.platform !== 'win32') expect(statSync(profilePath()).mode & 0o777).toBe(0o600)
})

test('only turning suggestions off is stored; on removes the key', () => {
  expect(writeRayucodeSetting('promptSuggestionEnabled', false)).toEqual({ ok: true, value: true })
  expect(profile()).toEqual({ promptSuggestionEnabled: false })
  expect(readRayucodeSettings().promptSuggestionEnabled).toBe(false)
  expect(writeRayucodeSetting('promptSuggestionEnabled', true)).toEqual({ ok: true, value: true })
  expect(profile()).toEqual({})
  expect(readRayucodeSettings().promptSuggestionEnabled).toBe(true)
})

test.each([
  ['language', 'Thai'],
  ['thinkingEnabled', true],
  ['permissionMode', true],
  ['promptSuggestionEnabled', 'no'],
])('refuses %p = %p', (key, value) => {
  expect(writeRayucodeSetting(key, value)).toEqual({ ok: false, error: 'That setting cannot be changed here.' })
})
