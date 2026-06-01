import { describe, expect, test, afterEach } from 'bun:test'
import { PRODUCT_NAME, PRODUCT_COMMAND } from '../src/constants/product.ts'

describe('Rayu rebrand', () => {
  test('product identity constants', () => {
    expect(PRODUCT_NAME).toBe('Rayu-CLI')
    expect(PRODUCT_COMMAND).toBe('rayu')
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
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    expect(getClaudeConfigHomeDir().endsWith('/.rayu')).toBe(true)

    process.env.RAYU_CONFIG_DIR = '/tmp/rayu-test-cfg'
    expect(getClaudeConfigHomeDir()).toBe('/tmp/rayu-test-cfg')
  })
})
