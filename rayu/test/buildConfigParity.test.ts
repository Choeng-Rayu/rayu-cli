/**
 * Parity between scripts/macroValues.ts and @rayu-dev/rayu-core, plus the
 * packaging invariants the migration must not break.
 *
 * RAYU_CORE_MIGRATION_PLAN.md Tasks 2 and 3, and invariants 1, 2, 4 and 6 from
 * §5. These are cheap assertions guarding expensive mistakes: the CLI's zero
 * runtime dependencies is what keeps `npm install -g` working, and a second zod
 * instance makes `instanceof` and `safeParse` disagree across package
 * boundaries without any error message.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUILD_CONFIG_KEYS, resolveBuildConfig } from '@rayu-dev/rayu-core'
import { ENABLED_FEATURES, MACRO_VALUES } from '../scripts/macroValues.ts'
import pkg from '../package.json' with { type: 'json' }

const RAYU_DIR = resolve(import.meta.dir, '..')
const REPO_ROOT = resolve(RAYU_DIR, '..')

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'))
}

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

  test('core is consumed as a file: devDependency, like agent-protocol', () => {
    const dev = pkg.devDependencies as Record<string, string>
    expect(dev['@rayu-dev/rayu-core']).toBe('file:../packages/rayu-core')
    expect(dev['@rayu-dev/agent-protocol']).toBe('file:../packages/agent-protocol')
  })
})

describe('invariant 2 — rayu stays outside the npm workspace', () => {
  test('the workspace globs cover packages/* but never rayu/', () => {
    const root = readJson('package.json')
    const globs = root.workspaces as string[]
    expect(globs).toContain('packages/*')
    expect(globs).not.toContain('rayu')
    expect(globs).not.toContain('rayu/')
  })

  test('packages/rayu-core is therefore a workspace member', () => {
    const core = readJson('packages/rayu-core/package.json')
    expect(core.name).toBe('@rayu-dev/rayu-core')
  })
})

describe('invariant 4 — one zod instance', () => {
  test('core pins the same exact zod version as agent-protocol and the root override', () => {
    const root = readJson('package.json')
    const core = readJson('packages/rayu-core/package.json')
    const protocol = readJson('packages/agent-protocol/package.json')

    const pinned = (root.overrides as Record<string, string>).zod
    expect(pinned).toBe('4.4.3')
    expect((core.dependencies as Record<string, string>).zod).toBe(pinned)
    expect((protocol.dependencies as Record<string, string>).zod).toBe(pinned)
  })

  test("rayu's zod range accepts that exact pin", () => {
    const dev = pkg.devDependencies as Record<string, string>
    expect(dev.zod).toBe('^4.4.3')
  })
})

describe('invariant 6 — the published surface is unchanged', () => {
  test('files ships the CLI plus the shared library surface, nothing else', () => {
    // The installer (rayu-web/public/install.sh) extracts dist/rayu.js only, and
    // `npm run check:installer` gates that — so adding entries is safe as long as
    // dist/rayu.js remains the path it reaches for.
    //
    // dist/rayu-lib.js + dist/types are the library surface the Rayucode
    // extension consumes so both consumers run the same code from rayu/src
    // (RAYU_LIBRARY_SURFACE_DESIGN.md). Neither introduces a runtime dependency:
    // the library bundle is Bun-bundled exactly like the CLI bundle.
    // dist/rayu-vscode-host.js is the engine the Rayucode extension spawns —
    // built from the same rayu/src by scripts/build-vscode-host.ts, so the
    // extension runs the CLI's tools/commands/skills rather than a copy.
    expect(pkg.files).toEqual([
      'dist/rayu.js',
      'dist/types',
      'dist/rayu-lib.js',
      'dist/rayu-vscode-host.js',
      'README.md',
      'scripts/preinstall.cjs',
      'scripts/postinstall.cjs',
    ])
    expect(pkg.files[0], 'the installer extracts this exact path').toBe('dist/rayu.js')
  })

  test('the library surface is exported without giving the CLI runtime deps', () => {
    const exports = pkg.exports as Record<string, unknown>
    expect(exports['.']).toBe('./dist/rayu.js')
    expect(exports['./lib']).toEqual({
      types: './dist/types/entrypoints/library.d.ts',
      import: './dist/rayu-lib.js',
    })
    expect(Object.prototype.hasOwnProperty.call(pkg, 'dependencies')).toBe(false)
  })

  test('the bin entry still points at the single bundled file', () => {
    expect((pkg.bin as Record<string, string>).rayu).toBe('dist/rayu.js')
  })
})

describe('core is importable in the shapes both consumers need', () => {
  test('emits both JavaScript and declarations', () => {
    // rayu bundles the JS with Bun; the extension needs the .d.ts because it
    // consumes core as a normal npm package with no bundler.
    const core = readJson('packages/rayu-core/package.json')
    expect(core.main).toBe('./dist/index.js')
    expect(core.types).toBe('./dist/index.d.ts')
    expect(core.type).toBe('module')
    for (const f of ['dist/index.js', 'dist/index.d.ts']) {
      expect(() =>
        readFileSync(resolve(REPO_ROOT, 'packages/rayu-core', f), 'utf8'),
      ).not.toThrow()
    }
  })

  test('the built core bundle contains no react, ink or bun: specifier', () => {
    // The boundary rule, checked against the emitted artifact rather than the
    // source, so a dependency that only appears after compilation is still
    // caught.
    const js = readFileSync(
      resolve(REPO_ROOT, 'packages/rayu-core/dist/index.js'),
      'utf8',
    )
    const buildConfig = readFileSync(
      resolve(REPO_ROOT, 'packages/rayu-core/dist/buildConfig.js'),
      'utf8',
    )
    for (const emitted of [js, buildConfig]) {
      expect(emitted).not.toMatch(/from\s+["']react["']/)
      expect(emitted).not.toMatch(/from\s+["']ink["']/)
      expect(emitted).not.toMatch(/from\s+["']bun:/)
    }
  })
})
