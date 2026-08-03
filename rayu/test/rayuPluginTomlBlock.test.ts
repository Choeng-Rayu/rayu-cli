import { describe, expect, test } from 'bun:test'
import {
  hasTomlTable,
  readTomlTableBody,
  removeTomlTable,
  tomlString,
  tomlStringArray,
  tomlTableHeader,
  upsertTomlTable,
} from '../src/plugins/installers/tomlBlock.ts'

const PATH = ['mcp_servers', 'rayu']

// A config.toml shaped like a real one: top-level keys, a plugin table with a
// quoted key, and project trust entries. Everything except the rayu block must
// survive byte-for-byte.
const EXISTING = `model = "gpt-5.5"
model_reasoning_effort = "xhigh"

[plugins."github@openai-curated"]
enabled = true

# keep this comment
[projects."/home/rayu/rayu-cli"]
trust_level = "trusted"
`

describe('TOML value rendering', () => {
  test('escapes basic strings', () => {
    expect(tomlString('/usr/bin/rayu')).toBe('"/usr/bin/rayu"')
    expect(tomlString('C:\\Program Files\\rayu.exe')).toBe(
      '"C:\\\\Program Files\\\\rayu.exe"',
    )
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""')
    expect(tomlString('a\nb\tc')).toBe('"a\\nb\\tc"')
  })

  test('renders string arrays', () => {
    expect(tomlStringArray(['mcp', 'serve'])).toBe('["mcp", "serve"]')
    expect(tomlStringArray([])).toBe('[]')
  })

  test('quotes header segments that are not bare keys', () => {
    expect(tomlTableHeader(['mcp_servers', 'rayu'])).toBe('[mcp_servers.rayu]')
    expect(tomlTableHeader(['projects', '/home/x'])).toBe(
      '[projects."/home/x"]',
    )
  })
})

describe('upsertTomlTable', () => {
  test('appends a new block and preserves every existing byte', () => {
    const next = upsertTomlTable(EXISTING, PATH, [
      'command = "rayu"',
      'args = ["mcp", "serve"]',
    ])

    expect(next).toContain('[mcp_servers.rayu]')
    expect(next).toContain('command = "rayu"')
    // Untouched content survives, comments included.
    expect(next).toContain('model = "gpt-5.5"')
    expect(next).toContain('# keep this comment')
    expect(next).toContain('[plugins."github@openai-curated"]')
    expect(next).toContain('[projects."/home/rayu/rayu-cli"]')
    expect(next.startsWith(EXISTING.replace(/\n+$/, ''))).toBe(true)
  })

  test('creates the file content when there is no source', () => {
    expect(upsertTomlTable(undefined, PATH, ['command = "rayu"'])).toBe(
      '[mcp_servers.rayu]\ncommand = "rayu"\n',
    )
    expect(upsertTomlTable('   \n', PATH, ['command = "rayu"'])).toBe(
      '[mcp_servers.rayu]\ncommand = "rayu"\n',
    )
  })

  test('replaces an existing block without touching neighbours', () => {
    const withBlock = upsertTomlTable(EXISTING, PATH, ['command = "old"'])
    const updated = upsertTomlTable(withBlock, PATH, ['command = "new"'])

    expect(updated).toContain('command = "new"')
    expect(updated).not.toContain('command = "old"')
    expect(updated.match(/\[mcp_servers\.rayu\]/g)).toHaveLength(1)
    expect(updated).toContain('[projects."/home/rayu/rayu-cli"]')
  })

  test('is idempotent for identical bodies', () => {
    const body = ['command = "rayu"', 'args = ["mcp", "serve"]']
    const once = upsertTomlTable(EXISTING, PATH, body)
    expect(upsertTomlTable(once, PATH, body)).toBe(once)
  })

  test('replacing a middle block stops at the next table header', () => {
    const source = `[mcp_servers.rayu]
command = "old"
args = ["mcp", "serve"]

[mcp_servers.other]
command = "other"
`
    const updated = upsertTomlTable(source, PATH, ['command = "new"'])
    expect(updated).toContain('command = "new"')
    expect(updated).toContain('[mcp_servers.other]')
    expect(updated).toContain('command = "other"')
    expect(updated).not.toContain('args = ["mcp", "serve"]')
  })

  test('matches a quoted header form', () => {
    const source = '[mcp_servers."rayu"]\ncommand = "old"\n'
    const updated = upsertTomlTable(source, PATH, ['command = "new"'])
    expect(updated).toContain('command = "new"')
    expect(updated).not.toContain('command = "old"')
  })

  test('does not confuse an array-of-tables header for a table', () => {
    const source = '[[mcp_servers.rayu]]\ncommand = "old"\n'
    expect(hasTomlTable(source, PATH)).toBe(false)
  })
})

describe('readTomlTableBody', () => {
  test('returns the body lines only', () => {
    const source = upsertTomlTable(EXISTING, PATH, [
      'command = "rayu"',
      'args = ["mcp", "serve"]',
    ])
    const body = readTomlTableBody(source, PATH)
    expect(body?.map(l => l.trim()).filter(Boolean)).toEqual([
      'command = "rayu"',
      'args = ["mcp", "serve"]',
    ])
  })

  test('returns undefined when absent', () => {
    expect(readTomlTableBody(EXISTING, PATH)).toBeUndefined()
    expect(readTomlTableBody(undefined, PATH)).toBeUndefined()
  })
})

describe('removeTomlTable', () => {
  test('removes only the rayu block', () => {
    const withBlock = upsertTomlTable(EXISTING, PATH, ['command = "rayu"'])
    const removed = removeTomlTable(withBlock, PATH)

    expect(removed).not.toContain('[mcp_servers.rayu]')
    expect(removed).toContain('model = "gpt-5.5"')
    expect(removed).toContain('# keep this comment')
    expect(removed).toContain('[projects."/home/rayu/rayu-cli"]')
  })

  test('round trip restores the original document', () => {
    const withBlock = upsertTomlTable(EXISTING, PATH, [
      'command = "rayu"',
      'args = ["mcp", "serve"]',
      'startup_timeout_sec = 30',
    ])
    const removed = removeTomlTable(withBlock, PATH)
    expect(`${removed?.replace(/\n+$/, '')}\n`).toBe(EXISTING)
  })

  test('leaves the source untouched when the block is absent', () => {
    expect(removeTomlTable(EXISTING, PATH)).toBe(EXISTING)
  })

  test('empties a file that held only the rayu block', () => {
    const only = upsertTomlTable(undefined, PATH, ['command = "rayu"'])
    expect(removeTomlTable(only, PATH)).toBe('')
  })
})
