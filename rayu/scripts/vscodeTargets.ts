/**
 * The platforms Rayucode ships a compiled engine for, and how `--target` is parsed.
 *
 * One table, read by the VSIX build (scripts/build-vscode.ts), the ripgrep fetcher
 * (scripts/fetchRipgrep.ts) and the release workflow, so a platform is added in exactly
 * one place.
 *
 * WHY THESE BUN TARGETS
 *   - x64 uses the `-baseline` runtime, which needs no AVX2. The default x64 build
 *     crashes with "Illegal instruction" on CPUs without it (older desktops, some VMs
 *     and CI hosts), and an editor extension cannot ask the user to fix their CPU.
 *   - The `alpine-*` VSIXs carry musl builds: VS Code serves them to Alpine and other
 *     musl distributions, where a glibc binary does not start.
 * Every name was verified with Bun 1.3.14 by cross-compiling a probe for it.
 *
 * Platforms Bun cannot target here (win32-arm64, linux-armhf, web) get the universal
 * VSIX, whose engine is `engine.mjs` on the editor's own Node.
 */
import type { CompileTarget } from './bundleConfig.ts'

export interface VscodeTarget {
  /** The `vsce package --target` value, and the VSIX file-name suffix. */
  readonly id: string
  readonly bunTarget: CompileTarget
  /** Target triple of the matching microsoft/ripgrep-prebuilt archive. */
  readonly rgTriple: string
  /** Executable suffix on this platform. */
  readonly exe: '' | '.exe'
}

export const NATIVE_TARGETS: readonly VscodeTarget[] = [
  { id: 'linux-x64', bunTarget: 'bun-linux-x64-baseline', rgTriple: 'x86_64-unknown-linux-musl', exe: '' },
  { id: 'linux-arm64', bunTarget: 'bun-linux-arm64', rgTriple: 'aarch64-unknown-linux-musl', exe: '' },
  { id: 'alpine-x64', bunTarget: 'bun-linux-x64-baseline-musl', rgTriple: 'x86_64-unknown-linux-musl', exe: '' },
  { id: 'alpine-arm64', bunTarget: 'bun-linux-arm64-musl', rgTriple: 'aarch64-unknown-linux-musl', exe: '' },
  { id: 'darwin-x64', bunTarget: 'bun-darwin-x64-baseline', rgTriple: 'x86_64-apple-darwin', exe: '' },
  { id: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', rgTriple: 'aarch64-apple-darwin', exe: '' },
  { id: 'win32-x64', bunTarget: 'bun-windows-x64-baseline', rgTriple: 'x86_64-pc-windows-msvc', exe: '.exe' },
]

/** What one invocation of the VSIX build should produce. */
export interface BuildPlan {
  /** The universal VSIX: `engine.mjs` on the editor's Node. */
  universal: boolean
  targets: VscodeTarget[]
}

/**
 * Parse `--target` arguments.
 *
 * Repeatable (`--target linux-x64 --target darwin-arm64`), also as `--target=a,b`.
 * `universal` names the universal VSIX; `all` is every native target plus universal.
 * No `--target` at all means the universal VSIX alone, which is what `build:vscode`
 * has always produced. An unknown name throws rather than being skipped, so a typo in
 * CI fails the build instead of silently shipping one platform fewer.
 */
export function parseTargetArgs(argv: readonly string[]): BuildPlan {
  const names = targetNames(argv)
  if (names.length === 0) return { universal: true, targets: [] }

  let universal = false
  const targets: VscodeTarget[] = []
  const add = (target: VscodeTarget): void => {
    if (!targets.includes(target)) targets.push(target)
  }
  for (const name of names) {
    if (name === 'all') {
      universal = true
      NATIVE_TARGETS.forEach(add)
    } else if (name === 'universal') {
      universal = true
    } else {
      const target = NATIVE_TARGETS.find(t => t.id === name)
      if (!target) {
        const valid = ['all', 'universal', ...NATIVE_TARGETS.map(t => t.id)].join(', ')
        throw new Error(`Unknown --target "${name}". Valid: ${valid}`)
      }
      add(target)
    }
  }
  return { universal, targets }
}

function targetNames(argv: readonly string[]): string[] {
  const names: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    let value: string | undefined
    if (arg === '--target') {
      value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--target needs a value')
      }
    } else if (arg.startsWith('--target=')) {
      value = arg.slice('--target='.length)
    }
    if (value !== undefined) names.push(...value.split(',').map(s => s.trim()).filter(Boolean))
  }
  return names
}

/** File name of the compiled engine inside a platform VSIX, relative to its root. */
export function engineBinaryName(target: Pick<VscodeTarget, 'exe'>): string {
  return `bin/rayucode-engine${target.exe}`
}
