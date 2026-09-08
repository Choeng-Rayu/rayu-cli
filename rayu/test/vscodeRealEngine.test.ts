import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks, until } from './helpers/vscodeSession.js'
import { startLocalProvider } from './helpers/localProvider.js'
import pkg from '../package.json'

const vsix = resolve(import.meta.dir, `../dist/rayucode-${pkg.version}.vsix`)
test.if(existsSync(vsix))('real packaged engine streams, runs tools, completes empty results and preserves its recap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-real-engine-'))
  const provider = await startLocalProvider()
  let session: ChatSession | undefined
  try {
    expect(spawnSync('unzip', ['-q', vsix, '-d', dir]).status).toBe(0)
    const config = join(dir, 'config'); mkdirSync(config)
    writeFileSync(join(config, 'providers.json'), JSON.stringify({ activeProvider: 'test', providers: [{ id: 'test', kind: 'openai-compatible', baseURL: provider.url, apiKey: 'fixture-key', defaultModel: 'test-model', fetchedModels: ['test-model'], modelContextWindows: { 'test-model': 32000 } }] }))
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read', 'Edit', 'Bash(true)'] } }))
    writeFileSync(join(dir, 'fixture.txt'), 'before\n')
    const errors: string[] = [], deltas: string[] = []
    let finished = false
    session = new ChatSession({
      enginePath: join(dir, 'extension/engine.mjs'), cwd: dir, nodePath: 'node',
      env: { RAYU_CONFIG_DIR: config, USE_RAYU_OAUTH: 'false', RAYU_EXTERNAL_AGENTS: '0' },
    }, sessionCallbacks({
      onError: error => errors.push(error),
      onPartial: (_id, kind, delta) => { if (kind === 'text') deltas.push(delta) },
      onTurnState: running => { if (!running) finished = true },
      onPermissionRequest: request => session!.controlClient!.respond(request.requestId, { behavior: 'allow', updatedInput: request.request.input }),
    }))
    await session.submitPrompt('Read fixture.txt, change before to after, run true, then summarize.')
    await until(() => finished || errors.length > 0, 60_000)
    expect(errors).toEqual([])
    expect(provider.requests.length).toBeGreaterThanOrEqual(4)
    expect(deltas.join('')).toContain('The check passed.')
    expect(readFileSync(join(dir, 'fixture.txt'), 'utf8')).toBe('after\n')
    const text = session.transcript.filter(e => e.kind === 'assistant').map(e => e.text).join('\n')
    expect(text.match(/The check passed\./g)).toHaveLength(1)
    const tools = session.transcript.filter(e => e.kind === 'tool')
    expect(tools.find(e => e.name === 'Bash')).toMatchObject({ status: 'done' })
    expect(tools.every(e => e.status !== 'running')).toBe(true)
    expect(session.transcript.some(e => e.kind === 'review')).toBe(true)
    const count = session.transcript.length
    await session.setEffort('high')
    let settings = await session.controlClient!.request('get_settings', {})
    expect((settings.inference as any).effort).toBe('high')
    await session.setEffort(null)
    settings = await session.controlClient!.request('get_settings', {})
    expect((settings.inference as any).effort).toBeNull()
    expect((settings.effective as any).effortLevel).toBeUndefined()
    expect(JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8')).effortLevel).toBeUndefined()
    expect(session.transcript.length).toBe(count)
    await session.setThinking(false)
    expect(session.currentInference.thinkingEnabled).toBe(false)
    await session.setThinking(true)
    expect(session.currentInference.thinkingEnabled).toBe(true)

  } finally {
    session?.dispose()
    await provider.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)
