// Migration coverage: settings keys renamed claude* → rayu*. The dual-read is
// NON-DESTRUCTIVE — legacy keys are normalized in memory on every parse, and the
// user's settings.json on disk is never rewritten.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'

describe('normalizeLegacySettingsIdentifierKeys (pure)', () => {
  test('moves all three legacy keys in place', async () => {
    const { normalizeLegacySettingsIdentifierKeys } = await import(
      '../src/utils/settings/identifierKeys.ts'
    )
    const data: Record<string, unknown> = {
      claudeMdExcludes: ['*.md'],
      claudeMcpEnabled: false,
      claudeSkillsEnabled: false,
      unrelated: 1,
    }
    normalizeLegacySettingsIdentifierKeys(data)
    expect(data.rayuMdExcludes).toEqual(['*.md'])
    expect(data.rayuMcpEnabled).toBe(false)
    expect(data.rayuSkillsEnabled).toBe(false)
    expect(data.unrelated).toBe(1)
    expect(data.claudeMdExcludes).toBeUndefined()
    expect(data.claudeMcpEnabled).toBeUndefined()
    expect(data.claudeSkillsEnabled).toBeUndefined()
  })
  test('new key wins; non-objects are ignored', async () => {
    const { normalizeLegacySettingsIdentifierKeys } = await import(
      '../src/utils/settings/identifierKeys.ts'
    )
    const data: Record<string, unknown> = {
      claudeMdExcludes: ['old'],
      rayuMdExcludes: ['new'],
    }
    normalizeLegacySettingsIdentifierKeys(data)
    expect(data.rayuMdExcludes).toEqual(['new'])
    expect(() => normalizeLegacySettingsIdentifierKeys(null)).not.toThrow()
    expect(() => normalizeLegacySettingsIdentifierKeys([1, 2])).not.toThrow()
  })
})

describe('MDM / enterprise policy parse path', () => {
  test('parseCommandOutputAsSettings normalizes legacy keys (plist/registry delivery)', async () => {
    const { parseCommandOutputAsSettings } = await import(
      '../src/utils/settings/mdm/settings.ts'
    )
    const legacy = JSON.stringify({
      claudeMdExcludes: ['policy-exclude.md'],
      claudeMcpEnabled: false,
      claudeSkillsEnabled: false,
    })
    const { settings, errors } = parseCommandOutputAsSettings(legacy, 'mdm-test')
    expect(errors).toEqual([])
    const s = settings as Record<string, unknown>
    expect(s.rayuMdExcludes).toEqual(['policy-exclude.md'])
    expect(s.rayuMcpEnabled).toBe(false)
    expect(s.rayuSkillsEnabled).toBe(false)
    expect(s.claudeMdExcludes).toBeUndefined()
  })
})

describe('settings dual-read (filesystem, non-destructive)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-settings-key-migration-'))
    process.env.RAYU_CONFIG_DIR = dir
    process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  })
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    const { resetSettingsCache } = await import(
      '../src/utils/settings/settingsCache.ts'
    )
    resetSettingsCache()
  })

  test('legacy keys are exposed under their new names; file is untouched', async () => {
    const { getSettingsFilePathForSource } = await import(
      '../src/utils/settings/settings.ts'
    )
    const { resetSettingsCache } = await import(
      '../src/utils/settings/settingsCache.ts'
    )
    const file = getSettingsFilePathForSource('userSettings')!
    mkdirSync(dirname(file), { recursive: true })
    const legacy = {
      claudeMdExcludes: ['exclude-me.md'],
      claudeMcpEnabled: false,
      claudeSkillsEnabled: false,
    }
    const original = JSON.stringify(legacy, null, 2)
    writeFileSync(file, original)
    resetSettingsCache()

    const { getInitialSettings } = await import('../src/utils/settings/settings.ts')
    const settings = getInitialSettings() as Record<string, unknown>
    expect(settings.rayuMdExcludes).toEqual(['exclude-me.md'])
    expect(settings.rayuMcpEnabled).toBe(false)
    expect(settings.rayuSkillsEnabled).toBe(false)

    // Non-destructive: the on-disk file still has the legacy keys, byte-identical.
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  test('new keys work directly', async () => {
    const { getSettingsFilePathForSource } = await import(
      '../src/utils/settings/settings.ts'
    )
    const { resetSettingsCache } = await import(
      '../src/utils/settings/settingsCache.ts'
    )
    const file = getSettingsFilePathForSource('userSettings')!
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ rayuSkillsEnabled: false }))
    resetSettingsCache()
    const { getInitialSettings } = await import('../src/utils/settings/settings.ts')
    const settings = getInitialSettings() as Record<string, unknown>
    expect(settings.rayuSkillsEnabled).toBe(false)
  })
})