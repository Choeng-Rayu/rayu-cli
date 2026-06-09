import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectStack, summarizeStack } from '../src/utils/stackDetector.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-stack-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content: string) {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

test('greenfield: empty dir has no stack', () => {
  const s = detectStack(dir)
  expect(s.hasExistingStack).toBe(false)
  expect(s.manifests).toEqual([])
  expect(summarizeStack(s)).toMatch(/greenfield/)
})

test('Next.js + React + TS + pnpm + postgres (prisma)', () => {
  write(
    'package.json',
    JSON.stringify({
      dependencies: { next: '14', react: '18', '@prisma/client': '5' },
      devDependencies: { typescript: '5' },
    }),
  )
  write('pnpm-lock.yaml', '')
  const s = detectStack(dir)
  expect(s.hasExistingStack).toBe(true)
  expect(s.languages).toContain('typescript')
  expect(s.frameworks).toContain('nextjs')
  expect(s.frameworks).toContain('react')
  expect(s.packageManager).toBe('pnpm')
  expect(s.database).toBe('postgres')
})

test('Go + gin + go modules', () => {
  write('go.mod', 'module x\n\nrequire github.com/gin-gonic/gin v1.9.1\n')
  write('go.sum', '')
  const s = detectStack(dir)
  expect(s.languages).toContain('go')
  expect(s.frameworks).toContain('gin')
  expect(s.packageManager).toBe('go')
})

test('Python + FastAPI from requirements.txt', () => {
  write('requirements.txt', 'fastapi==0.110\nuvicorn\n')
  const s = detectStack(dir)
  expect(s.languages).toContain('python')
  expect(s.frameworks).toContain('fastapi')
})

test('database inferred from docker-compose when no ORM dep', () => {
  write('package.json', JSON.stringify({ dependencies: { express: '4' } }))
  write('docker-compose.yml', 'services:\n  db:\n    image: mongo:7\n')
  const s = detectStack(dir)
  expect(s.frameworks).toContain('express')
  expect(s.database).toBe('mongodb')
})

test('detects this repo (rayu) as typescript + bun', () => {
  const repo = join(import.meta.dir, '..')
  const s = detectStack(repo)
  expect(s.hasExistingStack).toBe(true)
  expect(s.languages).toContain('typescript')
  expect(s.packageManager).toBe('bun')
})
