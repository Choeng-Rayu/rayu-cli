import { describe, expect, test } from 'bun:test'
import { resolveConfigHomeDir } from '../src/utils/envUtils.ts'

const HOME = '/home/u'
const rayu = '/home/u/.rayu'
const claude = '/home/u/.claude'

describe('config home dir resolution (rayu + claude both supported)', () => {
  test('explicit env wins', () => {
    expect(resolveConfigHomeDir(HOME, '/custom/dir', () => true)).toBe('/custom/dir')
  })
  test('prefers existing ~/.rayu', () => {
    expect(resolveConfigHomeDir(HOME, undefined, p => p === rayu || p === claude)).toBe(rayu)
  })
  test('falls back to existing ~/.claude when ~/.rayu absent', () => {
    expect(resolveConfigHomeDir(HOME, undefined, p => p === claude)).toBe(claude)
  })
  test('defaults to ~/.rayu for fresh installs (neither exists)', () => {
    expect(resolveConfigHomeDir(HOME, undefined, () => false)).toBe(rayu)
  })
})
