/**
 * Which ripgrep the engine should run, decided by the host.
 *
 * Grep and Glob run `rg`. Left to itself the engine looks for a vendored copy beside
 * its own bundle and then for an `rg` on PATH; no VSIX has ever carried a vendored copy,
 * so in VS Code search used to work only where ripgrep happened to be installed. The host
 * knows better places to look, in this order:
 *
 *   1. `bin/rg[.exe]` inside the extension — every platform VSIX ships one.
 *   2. The ripgrep VS Code itself ships for its own search, under `vscode.env.appRoot`.
 *      Its location moved between VS Code releases (`@vscode/ripgrep/bin/rg`, later
 *      `@vscode/ripgrep-universal/bin/<platform>-<arch>/rg`, either inside
 *      `node_modules` or `node_modules.asar.unpacked`), so every known layout is tried.
 *      This is what gives the universal VSIX working search too.
 *   3. Nothing: the engine keeps its own fallback to an `rg` on PATH.
 *
 * The answer reaches the engine as `RAYU_RIPGREP_PATH` (see `src/utils/ripgrep.ts`).
 * Free of `vscode` imports so the order is unit-testable.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

export type RipgrepSource = 'bundled' | 'vscode' | 'system'

export interface RipgrepLocation {
  /** Absolute path, or null when the engine should use its own PATH fallback. */
  path: string | null
  source: RipgrepSource
}

export interface RipgrepInput {
  extensionRoot: string
  /** `vscode.env.appRoot`; absent outside an editor. */
  appRoot?: string
  platform: NodeJS.Platform
  arch: string
  isFile?: (path: string) => boolean
}

export function resolveRipgrep(input: RipgrepInput): RipgrepLocation {
  const isFile = input.isFile ?? isRegularFile
  const rg = input.platform === 'win32' ? 'rg.exe' : 'rg'

  const bundled = join(input.extensionRoot, 'bin', rg)
  if (isFile(bundled)) return { path: bundled, source: 'bundled' }

  if (input.appRoot) {
    const platformDir = `${input.platform}-${input.arch}`
    for (const modules of ['node_modules', 'node_modules.asar.unpacked']) {
      for (const relative of [
        join('@vscode', 'ripgrep', 'bin', rg),
        join('@vscode', 'ripgrep-universal', 'bin', platformDir, rg),
      ]) {
        const candidate = join(input.appRoot, modules, relative)
        if (isFile(candidate)) return { path: candidate, source: 'vscode' }
      }
    }
  }
  return { path: null, source: 'system' }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
