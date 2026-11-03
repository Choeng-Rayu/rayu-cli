/**
 * scripts/smoke-vscode-engine.ts — the release smoke test reads file modes straight from
 * the zip central directory (no `unzip` on Windows runners). Checked against archives
 * built here with known modes.
 */
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { zipEntryModes } from '../scripts/smoke-vscode-engine.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32' || !Bun.which('zip'))('reads each entry\'s POSIX mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-modes-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'extension/bin'), { recursive: true })
  writeFileSync(join(dir, 'extension/bin/rayucode-engine'), 'x')
  writeFileSync(join(dir, 'extension/package.json'), '{}')
  chmodSync(join(dir, 'extension/bin/rayucode-engine'), 0o755)
  chmodSync(join(dir, 'extension/package.json'), 0o644)
  const archive = join(dir, 'test.vsix')
  expect(Bun.spawnSync(['zip', '-q', '-r', archive, 'extension'], { cwd: dir }).exitCode).toBe(0)

  const modes = zipEntryModes(new Uint8Array(readFileSync(archive)))
  expect(modes.get('extension/bin/rayucode-engine')).toBe(0o755)
  expect(modes.get('extension/package.json')).toBe(0o644)
})

test('rejects something that is not a zip', () => {
  expect(() => zipEntryModes(new Uint8Array(100))).toThrow('not a zip archive')
})

test.if(!!Bun.which('unzip'))('agrees with the platform VSIX this machine built, when there is one', async () => {
  const { existsSync } = await import('node:fs')
  const pkg = (await import('../package.json')).default
  const vsix = join(import.meta.dir, `../dist/rayucode-${pkg.version}-${process.platform}-${process.arch}.vsix`)
  if (!existsSync(vsix)) return
  const modes = zipEntryModes(new Uint8Array(readFileSync(vsix)))
  expect(modes.get('extension/bin/rayucode-engine')! & 0o111).not.toBe(0)
  expect(modes.get('extension/bin/rg')! & 0o111).not.toBe(0)
})
