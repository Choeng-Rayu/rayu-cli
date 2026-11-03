/**
 * The extension host keeps zod's English messages and drops every other translation.
 *
 * `zodEnglishLocalesOnlyPlugin()` (scripts/bundleConfig.ts) swaps zod's locale table for
 * stubs/zod-locales/index.ts in the host build only. This bundles a small zod program
 * with the same options as `extension.js` — with and without the plugin — and RUNS it,
 * so the check is behavioural: validation still works, messages are still English, and
 * the translations are actually gone. The plugin-less build is the control that proves
 * the detection string is real for the installed zod; without it, a zod upgrade that
 * renamed its German text would let the "is gone" assertion pass vacuously.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  EXTERNAL,
  sharedBuildOptions,
  zodEnglishLocalesOnlyPlugin,
} from '../scripts/bundleConfig.ts'

const PROBE = resolve(import.meta.dir, 'helpers/zodLocaleProbe.ts')
/** A message only zod's German locale contains. */
const GERMAN = 'Ungültige Eingabe'
const outDir = mkdtempSync(join(tmpdir(), 'rayucode-zod-locales-'))

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true })
})

async function bundleProbe(withPlugin: boolean): Promise<{ text: string; output: Record<string, unknown> }> {
  const shared = sharedBuildOptions()
  const naming = withPlugin ? 'probe-host.cjs' : 'probe-control.cjs'
  const result = await Bun.build({
    ...shared,
    entrypoints: [PROBE],
    outdir: outDir,
    format: 'cjs',
    external: [...EXTERNAL, 'vscode'],
    plugins: [...(shared.plugins ?? []), ...(withPlugin ? [zodEnglishLocalesOnlyPlugin()] : [])],
    naming,
  })
  expect(result.success, String(result.logs)).toBe(true)
  const file = join(outDir, naming)
  // Node, not Bun: the extension host runs the bundle under Electron's Node.
  const run = Bun.spawnSync(['node', file], { stdout: 'pipe', stderr: 'pipe' })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  return {
    text: readFileSync(file, 'utf8'),
    output: JSON.parse(run.stdout.toString()) as Record<string, unknown>,
  }
}

describe('zod in the extension host bundle', () => {
  test('keeps English messages and only the English locale', async () => {
    const host = await bundleProbe(true)
    expect(host.output.locales).toEqual(['en'])
    expect(host.output.rootLocales).toEqual(['en'])
    expect(host.output.message).toBe('Invalid input: expected string, received number')
    expect(String(host.output.rootMessage)).toStartWith('Invalid input: expected number')
    expect(host.text).not.toContain(GERMAN)
  }, 60_000)

  test('control: without the plugin every translation is bundled', async () => {
    const control = await bundleProbe(false)
    expect((control.output.locales as string[]).length).toBeGreaterThan(40)
    expect(control.output.message).toBe('Invalid input: expected string, received number')
    expect(control.text).toContain(GERMAN)
  }, 60_000)
})
