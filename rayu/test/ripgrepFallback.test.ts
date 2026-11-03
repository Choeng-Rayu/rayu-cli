import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// In a source checkout, the vendored ripgrep binary under dist/vendor is
// absent. The resolver must fall back to a system `rg` on PATH (which is
// installed in this environment) instead of returning the missing vendored
// path (which would ENOENT at spawn time — the reported Grep bug).
beforeEach(() => {
  delete process.env.USE_BUILTIN_RIPGREP
  delete process.env.RAYU_RIPGREP_PATH
})
afterEach(() => {
  delete process.env.USE_BUILTIN_RIPGREP
  delete process.env.RAYU_RIPGREP_PATH
})

test('ripgrepCommand falls back to system rg when the vendored binary is missing', async () => {
  const mod = await import('../src/utils/ripgrep.ts')
  mod._resetRipgrepConfigForTesting()
  const { rgPath } = mod.ripgrepCommand()
  // Either embedded (bundled mode) or the system fallback 'rg'. In a plain
  // source/test run it must be the bare system command 'rg', never a
  // non-existent vendored absolute path.
  expect(rgPath === 'rg' || rgPath.endsWith('/rg') === false).toBe(true)
  // Stronger: it must not be a vendored path that does not exist on disk.
  if (rgPath.includes('vendor/ripgrep')) {
    const { existsSync } = await import('fs')
    expect(existsSync(rgPath)).toBe(true)
  }
})

// The Rayucode extension points its engine at the ripgrep it ships (or VS Code's own)
// through RAYU_RIPGREP_PATH, so search does not depend on the user's PATH.
test('a host-provided ripgrep that exists is used directly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-host-'))
  try {
    const rg = join(dir, 'rg')
    writeFileSync(rg, '')
    process.env.RAYU_RIPGREP_PATH = rg
    const mod = await import('../src/utils/ripgrep.ts')
    mod._resetRipgrepConfigForTesting()
    expect(mod.ripgrepCommand()).toEqual({ rgPath: rg, rgArgs: [], argv0: undefined })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a host-provided ripgrep that is missing or relative is ignored', async () => {
  const mod = await import('../src/utils/ripgrep.ts')
  for (const value of [join(tmpdir(), 'no-such-dir', 'rg'), 'bin/rg']) {
    process.env.RAYU_RIPGREP_PATH = value
    mod._resetRipgrepConfigForTesting()
    expect(mod.ripgrepCommand().rgPath).not.toBe(value)
  }
})

test('an explicit request for the system ripgrep still wins over the host copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-host-'))
  try {
    const rg = join(dir, 'rg')
    writeFileSync(rg, '')
    process.env.RAYU_RIPGREP_PATH = rg
    process.env.USE_BUILTIN_RIPGREP = '0'
    const mod = await import('../src/utils/ripgrep.ts')
    mod._resetRipgrepConfigForTesting()
    // A system rg is installed in this environment, so the user's choice applies.
    expect(mod.ripgrepCommand().rgPath).toBe('rg')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
