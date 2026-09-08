/**
 * Parity between scripts/macroValues.ts and src/core, plus the packaging
 * invariants that must not break.
 *
 * These are cheap assertions guarding expensive mistakes: the CLI's zero runtime
 * dependencies is what keeps `npm install -g` working, and a second zod instance
 * makes `instanceof` and `safeParse` disagree with no error message at all.
 *
 * The build configuration and wire schemas used to live in sibling workspace
 * packages (`packages/rayu-core`, `packages/agent-protocol`) consumed over
 * `file:` links. That directory was removed, `bun install` pruned the links, and
 * the CLI build broke on a missing module — a load-bearing dependency on a path
 * OUTSIDE rayu/, felled by moving a folder. Both are now vendored into `src/`, so
 * these assertions check for the ABSENCE of that coupling rather than its shape.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUILD_CONFIG_KEYS, resolveBuildConfig } from '../src/core/index.js'
import { ENABLED_FEATURES, MACRO_VALUES } from '../scripts/macroValues.ts'
import pkg from '../package.json' with { type: 'json' }

const RAYU_DIR = resolve(import.meta.dir, '..')

describe('MACRO_VALUES is now produced by core', () => {
  test('resolves identically to core for the current environment', () => {
    expect(MACRO_VALUES).toEqual(resolveBuildConfig(process.env, pkg.version))
  })

  test('still exposes exactly the 11 documented keys', () => {
    expect(Object.keys(MACRO_VALUES).sort()).toEqual([...BUILD_CONFIG_KEYS].sort())
    expect(Object.keys(MACRO_VALUES)).toHaveLength(11)
  })

  test('the ambient MACRO declaration in globals.d.ts matches core', () => {
    // globals.d.ts is what makes `MACRO.X` typecheck across src/. If core gains
    // a value and the declaration does not, every use site silently fails to
    // compile; if the declaration gains one core lacks, --define bakes nothing.
    const globals = readFileSync(resolve(RAYU_DIR, 'globals.d.ts'), 'utf8')
    const block = globals.slice(
      globals.indexOf('var MACRO: {'),
      globals.indexOf('}', globals.indexOf('var MACRO: {')),
    )
    const declared = [...block.matchAll(/^\s{4}(\w+):\s*string$/gm)].map(m => m[1]).sort()
    expect(declared).toEqual([...BUILD_CONFIG_KEYS].sort())
  })

  test('VERSION tracks package.json', () => {
    expect(MACRO_VALUES.VERSION).toBe(pkg.version)
  })

  test('the four enabled feature flags are unchanged', () => {
    // Bun replaces feature('FLAG') with a boolean literal for exactly these and
    // dead-code-eliminates the rest, so this list is load-bearing.
    expect([...ENABLED_FEATURES]).toEqual([
      'ULTRATHINK',
      'TOKEN_BUDGET',
      'BUILTIN_EXPLORE_PLAN_AGENTS',
      'EXTERNAL_AGENTS',
    ])
  })
})

describe('invariant 1 — the CLI keeps zero runtime dependencies', () => {
  test('rayu/package.json has no `dependencies` key at all', () => {
    // Declaring them made `npm install -g` resolve and compile ~80 packages,
    // including sharp prebuilds, and fail differently on every machine. Core is
    // bundled by Bun from a devDependency, so it must never appear here.
    expect(Object.prototype.hasOwnProperty.call(pkg, 'dependencies')).toBe(false)
  })

  test('there are no `file:` devDependencies left', () => {
    // rayu-core, agent-protocol and web-bridge-client were `file:../packages/*`
    // links. When that directory was removed, `bun install` pruned all three and
    // the CLI build died on `Cannot find module '@rayu-dev/rayu-core'` from
    // scripts/preload.ts — a load-bearing dependency on a path OUTSIDE rayu/,
    // broken by moving a folder. They are now vendored as src/core, src/protocol
    // and src/webBridge/client, so no dependency reaches outside this package.
    const dev = pkg.devDependencies as Record<string, string>
    const fileLinks = Object.entries(dev).filter(([, spec]) =>
      spec.startsWith('file:'),
    )
    expect(fileLinks).toEqual([])
  })
})

describe('invariant 2 — rayu depends on nothing above its own directory', () => {
  test('no source, script or test imports a @rayu-dev/* package', () => {
    // The CLI publishes AS @rayu-dev/rayu-cli; it must never IMPORT a sibling
    // @rayu-dev package, because that is the coupling that broke the build.
    const offenders: string[] = []
    for (const dir of ['src', 'scripts', 'test']) {
      const hits = Bun.spawnSync(
        ['grep', '-rlE', "from ['\"]@rayu-dev/", resolve(RAYU_DIR, dir)],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      for (const line of hits.stdout.toString().split('\n')) {
        if (line.trim()) offenders.push(line.replace(`${RAYU_DIR}/`, ''))
      }
    }
    expect(offenders).toEqual([])
  })

  test('the vendored modules are present where the imports point', () => {
    for (const f of [
      'src/core/index.ts',
      'src/core/buildConfig.ts',
      'src/core/features.ts',
      'src/core/portable/hash.ts',
      'src/protocol/index.ts',
      'src/protocol/controlSchemas.ts',
      'src/protocol/coreSchemas.ts',
      'src/webBridge/client/index.ts',
    ]) {
      expect(() => readFileSync(resolve(RAYU_DIR, f), 'utf8'), f).not.toThrow()
    }
  })
})

describe('invariant 4 — one zod instance', () => {
  test('zod is declared exactly once, and only as a devDependency', () => {
    // Two zod instances make `instanceof` checks and safeParse results silently
    // disagree. With the protocol schemas vendored into src/protocol there is only
    // one package.json in play, so a single declaration is the whole guarantee —
    // the cross-package pin and root `overrides` that used to enforce it are gone
    // along with the workspace.
    const dev = pkg.devDependencies as Record<string, string>
    expect(dev.zod).toBe('^4.4.3')
    expect(Object.prototype.hasOwnProperty.call(pkg, 'dependencies')).toBe(false)
  })
})

describe('invariant 6 — the published surface is unchanged', () => {
  test('files ships the CLI and nothing else', () => {
    // The installer (rayu-web/public/install.sh) extracts dist/rayu.js only, and
    // `npm run check:installer` gates that.
    //
    // The Rayucode VS Code extension is NOT published through npm: `bun run
    // build:vscode` compiles the extension host, the webview and the engine child
    // straight from rayu/src and packages them into a .vsix. So the retired
    // dist/types + dist/rayu-lib.js library surface and the separately-built
    // dist/rayu-vscode-host.js are all absent here — shipping them in the npm
    // tarball would have been weight no npm consumer can use.
    expect(pkg.files).toEqual([
      'dist/rayu.js',
      'README.md',
      'scripts/preinstall.cjs',
      'scripts/postinstall.cjs',
    ])
    expect(pkg.files[0], 'the installer extracts this exact path').toBe('dist/rayu.js')
  })

  test('the CLI bundle is the only export, and there are still no runtime deps', () => {
    const exports = pkg.exports as Record<string, unknown>
    expect(exports['.']).toBe('./dist/rayu.js')
    // The `./lib` export pointed at the deleted dist/rayu-lib.js. An export path
    // that resolves to nothing is worse than no export: it fails at the
    // consumer's import, not here.
    expect(Object.prototype.hasOwnProperty.call(exports, './lib')).toBe(false)
    expect(Object.keys(exports)).toEqual(['.'])
    expect(Object.prototype.hasOwnProperty.call(pkg, 'dependencies')).toBe(false)
  })

  test('the bin entry still points at the single bundled file', () => {
    expect((pkg.bin as Record<string, string>).rayu).toBe('dist/rayu.js')
  })
})

describe('the vendored core and protocol stay pure', () => {
  test('src/core and src/protocol import no react, ink or bun: specifier', () => {
    // The boundary rule that mattered when core was a separate package still
    // matters now that it is not: both modules are reachable from the VS Code
    // extension host, where react/ink/Bun do not exist. This is checked against
    // the SOURCE because there is no separate build artifact any more — Bun
    // bundles these straight into dist/rayu.js and dist/vscode/*.js.
    //
    // Only real `import`/`export ... from` statements are inspected. The previous
    // version of this check read the COMPILED bundle, which has no comments; read
    // against source, a naive regex also matches prose — src/core/features.ts
    // documents why it does NOT use `import { feature } from 'bun:bundle'`, and
    // flagging that sentence as a violation would be a false positive.
    const files = [
      'src/core/index.ts',
      'src/core/buildConfig.ts',
      'src/core/features.ts',
      'src/core/portable/hash.ts',
      'src/protocol/index.ts',
      'src/protocol/controlSchemas.ts',
      'src/protocol/coreSchemas.ts',
      'src/protocol/lazySchema.ts',
    ]
    const forbidden = [/^react$/, /^ink$/, /^bun:/]

    for (const f of files) {
      const src = readFileSync(resolve(RAYU_DIR, f), 'utf8')
      for (const line of src.split('\n')) {
        if (!/^\s*(?:import|export)\b/.test(line)) continue
        const spec = line.match(/from\s+["']([^"']+)["']/)?.[1]
        if (!spec) continue
        for (const pattern of forbidden) {
          expect(pattern.test(spec), `${f} imports "${spec}"`).toBe(false)
        }
      }
    }
  })

  test('every unqualified Bun global access in core is guarded', () => {
    // core has fast paths that use Bun.hash when it is present. Unguarded, they
    // throw under the plain Node the extension host runs.
    const hash = readFileSync(resolve(RAYU_DIR, 'src/core/portable/hash.ts'), 'utf8')
    if (hash.includes('Bun.')) {
      expect(hash).toMatch(/typeof Bun\s*!==\s*['"]undefined['"]/)
    }
  })
})
