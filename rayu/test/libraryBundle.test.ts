/**
 * The shared library surface — budget and purity gate.
 *
 * `src/entrypoints/library.ts` is what `rayucode` imports so both consumers run
 * the same code from `rayu/src` (RAYU_LIBRARY_SURFACE_DESIGN.md). Its import
 * closure is ~2037 files and includes the React UI, because 74% of `rayu/src`
 * sits in one import cycle; the surface is small only because Bun tree-shakes at
 * the symbol level from a narrow entrypoint.
 *
 * That makes the size a LOAD-BEARING property, not a statistic. One export that
 * reaches the UI silently turns a 466 KB surface into 20 MB and puts React in the
 * extension host. Measured costs when this was written:
 *
 *   services/mcp/normalization  ~0 KB      utils/path            20 MB  REACT
 *   services/mcp/envExpansion    ~1 KB      rayuEntitlements      20 MB  REACT
 *   constants/product             3 KB      services/mcp/config   20 MB  REACT
 *   utils/rayuConfig            456 KB      utils/claudemd        20 MB  REACT
 *
 * So `utils/path` — which the migration plan called a "dependency-free util" — is
 * one of the expensive ones. Guessing does not work here; measuring does.
 *
 * This suite reads the BUILT artifact, so it needs `bun run build:lib` first. It
 * asserts the same properties scripts/build-lib.ts checks at build time, which is
 * deliberate redundancy: the build gate stops a bad bundle being produced, and
 * this stops a stale one being shipped.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const BUNDLE = resolve(ROOT, 'dist/rayu-lib.js')
const TYPES = resolve(ROOT, 'dist/types/entrypoints/library.d.ts')

/**
 * 1 MB. Roughly double today's 466 KB — room for a few more cheap modules, far
 * below the 20 MB a single UI-reaching export costs. If a legitimate addition
 * needs more, raise this deliberately in the same commit.
 */
const BUDGET_BYTES = 1024 * 1024

const built = existsSync(BUNDLE)

describe('the library surface is built', () => {
  test('bun run build:lib has produced the bundle and its declarations', () => {
    expect(built, `missing ${BUNDLE} — run: bun run build:lib`).toBe(true)
    expect(existsSync(TYPES), `missing ${TYPES} — run: bun run build:lib`).toBe(true)
  })
})

describe.if(built)('the surface stays within budget', () => {
  test(`the bundle is under ${(BUDGET_BYTES / 1024).toFixed(0)} KB`, () => {
    const bytes = statSync(BUNDLE).size
    expect(
      bytes,
      `${(bytes / 1024).toFixed(0)} KB exceeds the budget. An export probably reached ` +
        `the UI — find the edge with: bun run scripts/analyze-boundary.ts --cut-candidates`,
    ).toBeLessThan(BUDGET_BYTES)
  })

  test('the bundle carries no terminal UI', () => {
    // The single property that makes this surface usable in the extension host.
    const source = readFileSync(BUNDLE, 'utf8')
    expect(source).not.toMatch(/from\s*"react"/)
    expect(source).not.toMatch(/require\("react"\)/)
    expect(source).not.toMatch(/jsx-runtime/)
    expect(source).not.toMatch(/from\s*"ink"/)
  })

  test('the bundle contains no bun: specifier', () => {
    // `bun:bundle` and friends do not exist under the plain Node the extension
    // host runs. The CLI's build resolves them; nothing may survive into here.
    const source = readFileSync(BUNDLE, 'utf8')
    expect(source).not.toMatch(/from\s*"bun:/)
    expect(source).not.toMatch(/require\("bun:/)
  })

  test('the baked build config was inlined, so endpoints are the release ones', () => {
    // The divergence this surface fixes: without the baked values a consumer
    // falls back to localhost while the CLI uses the production host.
    const source = readFileSync(BUNDLE, 'utf8')
    expect(source).toContain('api.rayucode.com')
    // …and no unsubstituted define placeholders are left behind.
    expect(source).not.toMatch(/RAYU_BAKED_BUILD_CONFIG/)
    expect(source).not.toMatch(/RAYU_FEATURES\./)
    expect(source).not.toMatch(/\bMACRO\./)
  })
})

describe.if(built)('the surface exports what both consumers need', () => {
  test('every documented export is present and callable', async () => {
    const lib = (await import(BUNDLE)) as Record<string, unknown>
    for (const name of [
      // auth — retires the extension's duplicated reader
      'readRayuSession',
      'writeRayuSession',
      'hasRayuSession',
      'clearRayuSession',
      'getValidRayuAccessToken',
      'isUseRayuOAuthEnabled',
      // endpoints — one resolution path for both consumers
      'getRayuApiBaseUrl',
      'getRayuWebBaseUrl',
      'getRayuGatewayBaseUrl',
      'resolveEndpoints',
      'getBakedBuildConfig',
      // provider config — parity for model selection
      'loadRayuConfig',
      'saveRayuConfig',
      'getActiveProvider',
      'setActiveProvider',
      'upsertProvider',
      'removeProvider',
      // MCP helpers — parity for server management
      'normalizeNameForMCP',
      'expandEnvVarsInString',
    ]) {
      expect(typeof lib[name], `${name} must be exported as a function`).toBe('function')
    }
  })

  test('no React API leaked into the export surface', async () => {
    const lib = (await import(BUNDLE)) as Record<string, unknown>
    for (const reactApi of ['createElement', 'useState', 'useEffect', 'render']) {
      expect(lib[reactApi], `${reactApi} must not be exported`).toBeUndefined()
    }
  })

  test('the MCP helpers behave identically to the CLI', async () => {
    // Cheap behavioural anchors: if these ever diverge, the extension and the CLI
    // would disagree about server identity, which is a silent config bug.
    const lib = (await import(BUNDLE)) as {
      normalizeNameForMCP: (n: string) => string
      expandEnvVarsInString: (v: string) => { expanded: string; missingVars: string[] }
    }
    expect(lib.normalizeNameForMCP('My Server!')).toBe('My_Server_')
    expect(lib.expandEnvVarsInString('plain')).toEqual({
      expanded: 'plain',
      missingVars: [],
    })
  })
})
