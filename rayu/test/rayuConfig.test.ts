import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, chmodSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Each test gets an isolated RAYU_CONFIG_DIR so we never touch the real ~/.rayu.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-cfg-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '0'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

async function freshConfig() {
  const m = await import('../src/utils/rayuConfig.ts')
  m._resetRayuConfigCache()
  return m
}

describe('rayuConfig store', () => {
  test('upsert + active provider + key lookup, written 0600', async () => {
    const m = await freshConfig()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k1', baseURL: 'https://integrate.api.nvidia.com/v1' })
    m._resetRayuConfigCache()
    expect(m.getActiveProvider()?.id).toBe('nvidia')
    expect(m.getRayuApiKey('nvidia')).toBe('k1')
    expect(m.hasConfiguredProvider()).toBe(true)
    // file perms must be 0600 (owner-only) since it holds secrets
    const { statSync } = await import('fs')
    const mode = statSync(join(dir, 'providers.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('switching active provider', async () => {
    const m = await freshConfig()
    m.upsertProvider({ id: 'anthropic', kind: 'anthropic', apiKey: 'a' })
    m.upsertProvider({ id: 'openai', kind: 'openai-compatible', apiKey: 'b', baseURL: 'https://api.openai.com/v1' })
    m.setActiveProvider('anthropic')
    expect(m.getActiveProvider()?.id).toBe('anthropic')
  })
})

describe('rayuDiagnostics', () => {
  test('records bug/vulnerability to JSONL and reads them back', async () => {
    const d = await import('../src/utils/rayuDiagnostics.ts')
    d.reportBug('test.bug', 'something went wrong', { where: 'unit' })
    d.reportVulnerability('test.vuln', 'insecure thing', { kind: 'perm' })
    const all = d.readDiagnostics()
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all.some(r => r.code === 'test.bug' && r.kind === 'bug')).toBe(true)
    expect(all.some(r => r.code === 'test.vuln' && r.kind === 'vulnerability')).toBe(true)
  })

  test('corrupt providers.json emits a bug diagnostic and recovers', async () => {
    writeFileSync(join(dir, 'providers.json'), '{ not json')
    const m = await freshConfig()
    const cfg = m.loadRayuConfig()
    expect(cfg.providers).toEqual([])
    const d = await import('../src/utils/rayuDiagnostics.ts')
    expect(d.readDiagnostics().some(r => r.code === 'rayu_config.parse_failed')).toBe(true)
  })

  test('insecure permissions on providers.json flagged as vulnerability', async () => {
    if (process.platform === 'win32') return
    writeFileSync(join(dir, 'providers.json'), JSON.stringify({ providers: [] }))
    chmodSync(join(dir, 'providers.json'), 0o644)
    const m = await freshConfig()
    m.loadRayuConfig()
    const d = await import('../src/utils/rayuDiagnostics.ts')
    expect(d.readDiagnostics().some(r => r.code === 'rayu_config.insecure_permissions')).toBe(true)
  })
})
