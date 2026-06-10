import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getCwdState, setCwdState } from '../src/bootstrap/state.ts'
import {
  detectSwarmConflicts,
  findSwarmConflicts,
  formatConflicts,
} from '../src/tools/AgentTool/conflictPass.ts'

let dir: string
let prevCwd: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-conflict-'))
  prevCwd = getCwdState()
  setCwdState(dir)
})
afterEach(() => {
  setCwdState(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

test('flags SEC bcrypt vs BE md5 (password hashing)', () => {
  const conflicts = detectSwarmConflicts({
    SEC: 'Passwords MUST be hashed with bcrypt (cost 12).',
    BE: 'Hash the password with md5 before storing.',
  })
  expect(conflicts).toHaveLength(1)
  expect(conflicts[0].topic).toBe('password hashing')
  expect(conflicts[0].between).toEqual(['SEC', 'BE'])
})

test('flags SEC httpOnly cookie vs BE localStorage (token storage)', () => {
  const conflicts = detectSwarmConflicts({
    SEC: 'Store the JWT in an httpOnly cookie.',
    BE: 'Save the token to localStorage on login.',
  })
  expect(conflicts.map(c => c.topic)).toContain('auth token storage')
})

test('no conflict when both agree', () => {
  expect(
    detectSwarmConflicts({
      SEC: 'Use argon2 for password hashing; tokens in httpOnly cookies.',
      BE: 'Hash with argon2; set an httpOnly cookie for the session.',
    }),
  ).toHaveLength(0)
})

test('no conflict when SEC said nothing on the topic', () => {
  expect(detectSwarmConflicts({ BE: 'uses md5 somewhere' })).toHaveLength(0)
})

test('findSwarmConflicts reads the swarm section files', () => {
  const sw = join(dir, '.rayu', 'swarm')
  mkdirSync(sw, { recursive: true })
  writeFileSync(join(sw, 'SEC.md'), 'Passwords hashed with bcrypt only.')
  writeFileSync(join(sw, 'BE.md'), 'Stores password as md5 hash.')
  const conflicts = findSwarmConflicts()
  expect(conflicts).toHaveLength(1)
  const text = formatConflicts(conflicts)
  expect(text).toMatch(/conflict check/i)
  expect(text).toMatch(/password hashing/)
})

test('formatConflicts is empty string when clean', () => {
  expect(formatConflicts([])).toBe('')
})
