import { describe, expect, test } from 'bun:test'
import { resolveRayuConfigHomeDir } from '../src/utils/envUtils.ts'

const HOME = '/home/u'
const rayu = '/home/u/.rayu'
const claude = '/home/u/.claude'

describe('Rayu config home dir resolution', () => {
  test('RAYU_CONFIG_DIR wins', () => {
    expect(resolveRayuConfigHomeDir(HOME, '/custom/dir', () => true)).toBe('/custom/dir')
  })
  test('defaults to ~/.rayu even when it exists', () => {
    expect(resolveRayuConfigHomeDir(HOME, undefined, p => p === rayu)).toBe(rayu)
  })
  test('ignores existing ~/.claude when ~/.rayu is absent', () => {
    expect(resolveRayuConfigHomeDir(HOME, undefined, p => p === claude)).toBe(rayu)
  })
  test('defaults to ~/.rayu for fresh installs (neither exists)', () => {
    expect(resolveRayuConfigHomeDir(HOME, undefined, () => false)).toBe(rayu)
  })
})
