import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const powerShell = process.env.RAYU_TEST_POWERSHELL
  || Bun.which(process.platform === 'win32' ? 'powershell.exe' : 'pwsh')

test.skipIf(!powerShell)('PowerShell installer writes usable bundles and validates startup', () => {
  const result = spawnSync(powerShell!, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve(import.meta.dir, 'windowsInstaller.ps1'),
  ], { encoding: 'utf8', timeout: 30_000 })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toContain('PASS: version checks')
  expect(result.status).toBe(0)
}, 35_000)
