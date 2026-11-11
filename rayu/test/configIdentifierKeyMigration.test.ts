// Migration coverage: ~/.rayu/config.json fields renamed from claude* to rayu*.
// The pure normalizers must move every legacy key (global + per-project), and
// the registered migration must persist the change to disk.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('normalizeGlobalConfigIdentifierKeys (pure)', () => {
  test('moves all five global legacy keys', async () => {
    const { normalizeGlobalConfigIdentifierKeys } = await import(
      '../src/utils/configIdentifierKeys.ts'
    )
    const input = {
      claudeCodeFirstTokenDate: '2026-01-01T00:00:00Z',
      claudeAiMcpEverConnected: ['server-a'],
      claudeCodeHints: { plugin: { disabled: false } },
      claudeInChromeDefaultEnabled: true,
      hasCompletedClaudeInChromeOnboarding: true,
      unrelated: 'keep',
    }
    const out = normalizeGlobalConfigIdentifierKeys(input) as Record<string, unknown>
    expect(out.rayuCodeFirstTokenDate).toBe('2026-01-01T00:00:00Z')
    expect(out.rayuAiMcpEverConnected).toEqual(['server-a'])
    expect(out.rayuCodeHints).toEqual({ plugin: { disabled: false } })
    expect(out.rayuInChromeDefaultEnabled).toBe(true)
    expect(out.hasCompletedRayuInChromeOnboarding).toBe(true)
    expect(out.unrelated).toBe('keep')
    for (const key of Object.keys(input)) {
      if (key.startsWith('claude') || key.startsWith('hasCompletedClaude')) {
        expect(out[key]).toBeUndefined()
      }
    }
  })
  test('moves project legacy keys under projects[*]', async () => {
    const { normalizeGlobalConfigIdentifierKeys } = await import(
      '../src/utils/configIdentifierKeys.ts'
    )
    const out = normalizeGlobalConfigIdentifierKeys({
      projects: {
        '/proj': {
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true,
          other: 1,
        },
      },
    }) as { projects: Record<string, Record<string, unknown>> }
    const proj = out.projects['/proj']
    expect(proj.hasRayuMdExternalIncludesApproved).toBe(true)
    expect(proj.hasRayuMdExternalIncludesWarningShown).toBe(true)
    expect(proj.other).toBe(1)
    expect(proj.hasClaudeMdExternalIncludesApproved).toBeUndefined()
  })
  test('returns the same reference when nothing changed', async () => {
    const { normalizeGlobalConfigIdentifierKeys } = await import(
      '../src/utils/configIdentifierKeys.ts'
    )
    const input = { rayuCodeHints: {}, projects: { '/p': { other: 1 } } }
    expect(normalizeGlobalConfigIdentifierKeys(input)).toBe(input)
  })
  test('new key wins over legacy when both present', async () => {
    const { normalizeGlobalConfigIdentifierKeys } = await import(
      '../src/utils/configIdentifierKeys.ts'
    )
    const out = normalizeGlobalConfigIdentifierKeys({
      claudeCodeFirstTokenDate: 'old',
      rayuCodeFirstTokenDate: 'new',
    }) as Record<string, unknown>
    expect(out.rayuCodeFirstTokenDate).toBe('new')
    expect(out.claudeCodeFirstTokenDate).toBeUndefined()
  })
})

describe('migrateIdentifierKeysToRayu (filesystem persistence)', () => {
  let dir: string
  let savedNodeEnv: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-config-key-migration-'))
    process.env.RAYU_CONFIG_DIR = dir
    process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
    // getGlobalConfig/saveGlobalConfig short-circuit to an in-memory stub under
    // NODE_ENV=test; drop it so the migration exercises the real disk path.
    savedNodeEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
  })
  afterEach(async () => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    const { getGlobalRayuFile } = await import('../src/utils/env.ts')
    ;(getGlobalRayuFile as unknown as { cache?: Map<unknown, unknown> }).cache?.clear()
  })

  test('rewrites legacy keys on disk and preserves unrelated config', async () => {
    const { getGlobalRayuFile } = await import('../src/utils/env.ts')
    ;(getGlobalRayuFile as unknown as { cache?: Map<unknown, unknown> }).cache?.clear()
    const file = getGlobalRayuFile()
    writeFileSync(
      file,
      JSON.stringify({
        claudeCodeHints: { plugin: { disabled: true } },
        claudeCodeFirstTokenDate: '2026-01-01T00:00:00Z',
        projects: {
          '/proj': { hasClaudeMdExternalIncludesApproved: true },
        },
        theme: 'light',
      }),
    )
    const { migrateIdentifierKeysToRayu } = await import(
      '../src/migrations/migrateIdentifierKeysToRayu.ts'
    )
    const { enableConfigs } = await import('../src/utils/config.ts')
    enableConfigs()
    migrateIdentifierKeysToRayu()
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.rayuCodeHints).toEqual({ plugin: { disabled: true } })
    expect(onDisk.rayuCodeFirstTokenDate).toBe('2026-01-01T00:00:00Z')
    expect(onDisk.projects['/proj'].hasRayuMdExternalIncludesApproved).toBe(true)
    expect(onDisk.theme).toBe('light')
    expect(onDisk.claudeCodeHints).toBeUndefined()
    expect(onDisk.claudeCodeFirstTokenDate).toBeUndefined()
    expect(onDisk.projects['/proj'].hasClaudeMdExternalIncludesApproved).toBeUndefined()
  })
})