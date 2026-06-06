import { afterEach, beforeEach, expect, test } from 'bun:test'

// In a source checkout, the vendored ripgrep binary under dist/vendor is
// absent. The resolver must fall back to a system `rg` on PATH (which is
// installed in this environment) instead of returning the missing vendored
// path (which would ENOENT at spawn time — the reported Grep bug).
beforeEach(() => {
  delete process.env.USE_BUILTIN_RIPGREP
})
afterEach(() => {
  delete process.env.USE_BUILTIN_RIPGREP
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
