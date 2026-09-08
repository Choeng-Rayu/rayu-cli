import { afterEach, expect, test } from 'bun:test'
import { structuredPatch } from 'diff'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { reversePatch } from '../src/vscode/host/review/reversePatch.js'
import { loadSessionTranscript, listWorkspaceSessions } from '../src/vscode/host/sessionHistory.js'
import { getProjectDir } from '../src/utils/sessionStoragePortable.js'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

const dirs: string[] = []
const original = process.env.RAYU_CONFIG_DIR
afterEach(() => {
  if (original === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = original
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test.each([
  ['a\nb\nc\n', 'a\nx\nc\n'],
  ['a\nb\nc\nd\ne\nf\ng\nh\ni\n', 'a\nnew\nb\nc\nd\ne\nf\ng\nx\ni\n'],
  ['', 'new\n'], ['removed\n', ''],
  ['a\nb\n', 'a\nb'], ['a\nb', 'a\nb\n'],
  ['first\nlast', 'new\nlast'], ['a\r\nb\r\n', 'a\r\nc\r\n'],
])('recorded hunks reconstruct exact pre-edit bytes %#', (before, after) => {
  const patch = structuredPatch('file', 'file', before, after, '', '', { context: 1 })
  expect(reversePatch(after, patch.hunks)).toBe(before)
})

test('history restores the bounded tail, tolerates a truncated record, and never writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-history-')); dirs.push(dir)
  process.env.RAYU_CONFIG_DIR = join(dir, 'config')
  const id = randomUUID(), project = getProjectDir(dir)
  mkdirSync(project, { recursive: true })
  const file = join(project, `${id}.jsonl`)
  const records = Array.from({ length: 410 }, (_, i) => JSON.stringify({
    type: i % 2 ? 'assistant' : 'user', uuid: randomUUID(), sessionId: id,
    cwd: dir, timestamp: new Date(1700000000000 + i).toISOString(),
    message: { role: i % 2 ? 'assistant' : 'user', content: `message ${i}` },
  }))
  const raw = records.join('\n') + '\n{"type":"assistant"'
  writeFileSync(file, raw)
  const blocks = await loadSessionTranscript(id, dir)
  expect(blocks).toHaveLength(400)
  expect(blocks[0]).toMatchObject({ kind: 'prompt', text: 'message 10' })
  expect(blocks.at(-1)).toMatchObject({ kind: 'assistant', text: 'message 409' })
  expect(readFileSync(file, 'utf8')).toBe(raw)
  expect((await listWorkspaceSessions(dir))[0]?.id).toBe(id)
})

test('only restored unfinished tools are settled', () => {
  const session = new ChatSession({ enginePath: '/unused', cwd: tmpdir() }, sessionCallbacks())
  session.restoreTranscript([{ kind: 'tool_use', toolUseId: 'old', name: 'Bash', label: 'check', parameters: '{}' }])
  expect(session.transcript.find(e => e.kind === 'tool')).toMatchObject({ status: 'error' })
  session.dispose()
})

test('listWorkspaceSessions respects label precedence and newest-first ordering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-history-order-')); dirs.push(dir)
  process.env.RAYU_CONFIG_DIR = join(dir, 'config')
  const project = getProjectDir(dir)
  mkdirSync(project, { recursive: true })

  // Session 1: customTitle present (should win over summary and prompt)
  const id1 = randomUUID()
  const file1 = join(project, `${id1}.jsonl`)
  writeFileSync(file1, [
    JSON.stringify({ type: 'user', sessionId: id1, message: { role: 'user', content: 'prompt one' }, timestamp: '2025-01-01T10:00:00.000Z' }),
    JSON.stringify({ type: 'title', sessionId: id1, customTitle: 'Explicit User Title' }),
    JSON.stringify({ type: 'summary', sessionId: id1, summary: 'Auto Generated Summary' }),
  ].join('\n'))

  // Session 2: summary present (should win over firstPrompt)
  const id2 = randomUUID()
  const file2 = join(project, `${id2}.jsonl`)
  writeFileSync(file2, [
    JSON.stringify({ type: 'user', sessionId: id2, message: { role: 'user', content: 'prompt two' }, timestamp: '2025-01-01T11:00:00.000Z' }),
    JSON.stringify({ type: 'summary', sessionId: id2, summary: 'Second Auto Summary' }),
  ].join('\n'))

  // Session 3: only firstPrompt
  const id3 = randomUUID()
  const file3 = join(project, `${id3}.jsonl`)
  writeFileSync(file3, [
    JSON.stringify({ type: 'user', sessionId: id3, message: { role: 'user', content: 'only prompt three' }, timestamp: '2025-01-01T12:00:00.000Z' }),
  ].join('\n'))

  // Set file mtimes so id3 > id2 > id1 (newest first)
  const t = 1700000000
  utimesSync(file1, t, t)
  utimesSync(file2, t + 100, t + 100)
  utimesSync(file3, t + 200, t + 200)

  const sessions = await listWorkspaceSessions(dir)
  expect(sessions.length).toBeGreaterThanOrEqual(3)

  // Verify newest-first ordering
  const found = sessions.filter(s => [id1, id2, id3].includes(s.id as any))
  expect(found.map(s => s.id)).toEqual([id3, id2, id1])

  // Verify label precedence
  const s1 = found.find(s => s.id === id1)
  expect(s1?.label).toBe('Explicit User Title')

  const s2 = found.find(s => s.id === id2)
  expect(s2?.label).toBe('Second Auto Summary')

  const s3 = found.find(s => s.id === id3)
  expect(s3?.label).toBe('only prompt three')
})

