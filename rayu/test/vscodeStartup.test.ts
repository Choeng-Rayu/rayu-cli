import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks, until } from './helpers/vscodeSession.js'

async function fixture(run: (session: ChatSession, dir: string, errors: string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-startup-'))
  const enginePath = join(dir, 'engine.cjs')
  writeFileSync(enginePath, `
    const fs = require('node:fs');
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const reply = m => process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}})+'\\n');
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.type === 'user') fs.appendFileSync('prompts', m.message.content+'\\n');
      if (m.type !== 'control_request') return;
      if (m.request.subtype !== 'initialize') return reply(m);
      fs.writeFileSync('initializing', 'yes');
      const timer = setInterval(() => {
        if (!fs.existsSync('release')) return;
        clearInterval(timer); reply(m);
      }, 10);
    });
  `)
  const errors: string[] = []
  const session = new ChatSession({ enginePath, cwd: dir, nodePath: 'node' }, sessionCallbacks({ onError: e => errors.push(e) }))
  try { await run(session, dir, errors) }
  finally { session.dispose(); await new Promise(r => setTimeout(r, 100)); rmSync(dir, { recursive: true, force: true }) }
}

test('first prompt reports work before initialization and is delivered once ready', () => fixture(async (session, dir, errors) => {
  const pending = session.submitPrompt('first')
  expect(session.isTurnRunning).toBe(true)
  await until(() => existsSync(join(dir, 'initializing')))
  expect(existsSync(join(dir, 'prompts'))).toBe(false)
  writeFileSync(join(dir, 'release'), '')
  await pending
  await until(() => existsSync(join(dir, 'prompts')))
  expect(readFileSync(join(dir, 'prompts'), 'utf8')).toBe('first\n')
  expect(errors).toEqual([])
}))

test('warmup initializes without a prompt and the first prompt reuses that engine', () => fixture(async (session, dir, errors) => {
  const warming = session.warmup()
  await until(() => existsSync(join(dir, 'initializing')))
  expect(session.isTurnRunning).toBe(false)
  expect(existsSync(join(dir, 'prompts'))).toBe(false)

  // A prompt arriving during prewarm joins the same initialization promise.
  const prompt = session.submitPrompt('first after warmup')
  expect(session.isTurnRunning).toBe(true)
  writeFileSync(join(dir, 'release'), '')
  await Promise.all([warming, prompt])
  await until(() => existsSync(join(dir, 'prompts')))
  expect(readFileSync(join(dir, 'prompts'), 'utf8')).toBe('first after warmup\n')
  expect(errors).toEqual([])
}))

test('Stop during initialization cancels the pending prompt and allows a replacement', () => fixture(async (session, dir, errors) => {
  const first = session.submitPrompt('cancelled')
  await until(() => existsSync(join(dir, 'initializing')))
  await session.interrupt()
  expect(session.isTurnRunning).toBe(false)
  const next = session.submitPrompt('replacement')
  // A writable child is not yet initialized; the replacement must wait too.
  await new Promise(r => setTimeout(r, 100))
  expect(existsSync(join(dir, 'prompts'))).toBe(false)
  writeFileSync(join(dir, 'release'), '')
  await Promise.all([first, next])
  await until(() => existsSync(join(dir, 'prompts')))
  expect(readFileSync(join(dir, 'prompts'), 'utf8')).toBe('replacement\n')
  expect(errors).toEqual([])
}))

test('replacing a session during initialization discards the old pending prompt', () => fixture(async (session, dir, errors) => {
  const old = session.submitPrompt('old session')
  await until(() => existsSync(join(dir, 'initializing')))
  session.newSession()
  const next = session.submitPrompt('new session')
  writeFileSync(join(dir, 'release'), '')
  await Promise.all([old, next])
  await until(() => existsSync(join(dir, 'prompts')))
  expect(readFileSync(join(dir, 'prompts'), 'utf8')).toBe('new session\n')
  expect(errors).toEqual([])
}))

test('disposing during initialization clears running state without startup errors', () => fixture(async (session, dir, errors) => {
  const pending = session.submitPrompt('cancelled')
  await until(() => existsSync(join(dir, 'initializing')))
  session.dispose()
  await pending
  expect(session.isTurnRunning).toBe(false)
  expect(existsSync(join(dir, 'prompts'))).toBe(false)
  expect(errors).toEqual([])
}))
