import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import {
  PRODUCT_NAME,
  PRODUCT_COMMAND,
  PRODUCT_CONFIG_DIRNAME,
  PRODUCT_URL,
} from '../src/constants/product.ts'

describe('Rayu rebrand', () => {
  test('product identity constants', () => {
    expect(PRODUCT_NAME).toBe('Rayu-CLI')
    expect(PRODUCT_COMMAND).toBe('rayu')
    expect(PRODUCT_CONFIG_DIRNAME).toBe('.rayu')
  })

  test('brand constants carry no Claude/Anthropic branding', () => {
    // Guards against regressions that reintroduce upstream branding into the
    // product identity surface. Model IDs and interop paths live elsewhere and
    // are intentionally excluded from this invariant.
    for (const value of [
      PRODUCT_NAME,
      PRODUCT_COMMAND,
      PRODUCT_CONFIG_DIRNAME,
      PRODUCT_URL,
    ]) {
      expect(value.toLowerCase()).not.toContain('claude')
      expect(value.toLowerCase()).not.toContain('anthropic')
    }
  })
})

describe('config dir', () => {
  const prev = { rayu: process.env.RAYU_CONFIG_DIR, claude: process.env.CLAUDE_CONFIG_DIR }
  afterEach(() => {
    process.env.RAYU_CONFIG_DIR = prev.rayu
    process.env.CLAUDE_CONFIG_DIR = prev.claude
  })

  test('defaults to ~/.rayu and honors RAYU_CONFIG_DIR override', async () => {
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    const { getRayuConfigHomeDir } = await import('../src/utils/envUtils.ts')
    expect(getRayuConfigHomeDir().endsWith('/.rayu')).toBe(true)

    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-test-cfg'
    expect(getRayuConfigHomeDir().endsWith('/.rayu')).toBe(true)

    process.env.RAYU_CONFIG_DIR = '/tmp/rayu-test-cfg'
    expect(getRayuConfigHomeDir()).toBe('/tmp/rayu-test-cfg')
  })
})


describe('user-facing CLI output carries no upstream product branding', () => {
  // Ground-truth check against the built binary users actually run. Skips
  // cleanly when dist/ has not been built yet (the CI/build flow builds first).
  const dist = join(import.meta.dir, '..', 'dist', 'rayu.js')
  const maybe = existsSync(dist) ? test : test.skip
  const run = (args: string[]): string =>
    execFileSync('node', [dist, ...args], { encoding: 'utf8', timeout: 30_000 })

  maybe('--version reports Rayu-CLI and no Claude branding', () => {
    const out = run(['--version'])
    expect(out).toContain('Rayu-CLI')
    expect(out.toLowerCase()).not.toContain('claude')
  })

  maybe('--help contains no "Claude Code" product branding', () => {
    // Model-id examples (e.g. "claude-sonnet-4-6") are allowed; the upstream
    // product name is not.
    expect(run(['--help'])).not.toMatch(/claude\s+code/i)
  })
})
