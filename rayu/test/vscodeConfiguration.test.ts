import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _resetRayuConfigCache } from '../src/utils/rayuConfig.js'
import { readModelOptions, readActiveModel } from '../src/vscode/host/models/modelConfig.js'
import { ChatSession, engineArgsFor } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'
import { CONNECT_FLAG } from '../src/vscode/shared/connectProtocol.js'
import { PERMISSION_MODES as editorModes } from '../src/vscode/shared/permissionModes.js'
import { PERMISSION_MODES as cliModes } from '../src/utils/permissions/PermissionMode.js'

const original = process.env.RAYU_CONFIG_DIR
const directories: string[] = []
afterEach(() => {
  if (original === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = original
  _resetRayuConfigCache()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function configDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-config-')); directories.push(dir)
  process.env.RAYU_CONFIG_DIR = dir; _resetRayuConfigCache()
  return dir
}

test('model choices read the same providers.json as the CLI before engine startup', () => {
  const dir = configDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ activeProvider: 'wrong', defaultModel: 'wrong' }))
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({ activeProvider: 'fixture', providers: [{ id: 'fixture', kind: 'openai-compatible', defaultModel: 'fixture-model', fetchedModels: ['fixture-model', 'second-model'] }] }))
  expect(readActiveModel()).toEqual({ provider: 'fixture', model: 'fixture-model' })
  expect(readModelOptions().map(m => m.value)).toContain('fixture\u0000fixture-model')
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({ activeProvider: 'anthropic', providers: [{ id: 'anthropic', kind: 'anthropic' }] }))
  _resetRayuConfigCache()
  expect(readModelOptions()).toEqual([])
})

test('editor permission modes are accepted by the CLI', () => {
  for (const mode of editorModes) expect(cliModes as readonly string[]).toContain(mode.id)
})

test('thinking is forced on by the spawn flag, never by a control request', async () => {
  // The flag is the whole mechanism: it is the only thing that outranks a shared
  // `alwaysThinkingEnabled: false`. Asserted on the pure argv builder so the contract is
  // checked without spawning, and re-checked end-to-end in vscodeRealEngine.test.ts.
  expect(engineArgsFor({})).toEqual(['--thinking', 'enabled'])
  expect(engineArgsFor({ resumeSessionId: 'abc-123' })).toEqual([
    '--thinking', 'enabled', '--resume', 'abc-123',
  ])

  // And nothing may quietly re-disable it: `set_max_thinking_tokens` with null would
  // restore the settings default, and with 0 would turn thinking off outright.
  const session = new ChatSession({ enginePath: '/unused', cwd: tmpdir() }, sessionCallbacks())
  const requests: unknown[][] = []
  ;(session as any).control = { request: async (...args: unknown[]) => { requests.push(args); return {} }, dispose() {} }
  await session.setEffort('high')
  expect(requests.map(([method]) => method)).not.toContain('set_max_thinking_tokens')
  expect(session).not.toHaveProperty('setThinking')
  session.dispose()
})

test.each([401, 403, 404])('real connect dispatch classifies HTTP %i without returning credentials', async status => {
  const dir = configDir(), key = 'test-secret-do-not-echo'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('', { status }) })
  try {
    const child = Bun.spawn(['node', resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs'), CONNECT_FLAG, JSON.stringify({ action: 'validate', providerId: 'deepseek', apiKey: key, baseURL: `http://127.0.0.1:${server.port}/v1` })], {
      cwd: dir, env: { ...process.env, RAYU_CONFIG_DIR: dir, USE_RAYU_OAUTH: 'false' }, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const result = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(f => f.type === 'rayucode_connect_result')
    expect(result.ok).toBe(status === 404)
    if (status !== 404) expect(result.error).toContain('rejected')
    expect(stdout + stderr).not.toContain(key)
  } finally { server.stop(true) }
}, 20_000)

test('real connect dispatch classifies unreachable endpoints', async () => {
  const dir = configDir(), key = 'test-secret-unreachable'
  // Port with no server running
  const child = Bun.spawn(['node', resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs'), CONNECT_FLAG, JSON.stringify({ action: 'validate', providerId: 'deepseek', apiKey: key, baseURL: 'http://127.0.0.1:19' })], {
    cwd: dir, env: { ...process.env, RAYU_CONFIG_DIR: dir, USE_RAYU_OAUTH: 'false' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const result = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(f => f.type === 'rayucode_connect_result')
  expect(result.ok).toBe(false)
  expect(result.error).toContain('reach the provider')
  expect(stdout + stderr).not.toContain(key)
}, 20_000)

test('real connect dispatch classifies no-catalogue endpoints', async () => {
  const dir = configDir(), key = 'test-secret-empty'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) })
  try {
    const child = Bun.spawn(['node', resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs'), CONNECT_FLAG, JSON.stringify({ action: 'validate', providerId: 'deepseek', apiKey: key, baseURL: `http://127.0.0.1:${server.port}/v1` })], {
      cwd: dir, env: { ...process.env, RAYU_CONFIG_DIR: dir, USE_RAYU_OAUTH: 'false' }, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const result = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(f => f.type === 'rayucode_connect_result')
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([])
    expect(stdout + stderr).not.toContain(key)
  } finally { server.stop(true) }
}, 20_000)

test('capability gating re-derives on model change', async () => {
  const inferenceUpdates: any[] = []
  const session = new ChatSession({ enginePath: '/unused', cwd: tmpdir() }, sessionCallbacks({
    onInferenceSettings: settings => inferenceUpdates.push(settings),
  }))
  ;(session as any).control = {
    request: async (method: string) => {
      if (method === 'set_model') return {}
      if (method === 'get_settings') {
        return {
          inference: {
            supportsEffort: true,
            supportedLevels: ['low', 'medium', 'high'],
            effort: 'high',
            effortEnvOverride: null,
            supportsThinking: true,
            thinkingEnabled: true,
          },
        }
      }
      return {}
    },
    dispose() {},
  }
  await session.setModel('claude-3-7-sonnet')
  expect(session.currentInference.supportsEffort).toBe(true)
  expect(session.currentInference.supportsThinking).toBe(true)
  expect(inferenceUpdates.length).toBeGreaterThan(0)
  session.dispose()
})

test('credential containment: ConnectFrame and ProviderSetupView cannot hold an API key', () => {
  const connectProto = readFileSync(resolve(import.meta.dir, '../src/vscode/shared/connectProtocol.ts'), 'utf8')
  // Locate ConnectFrame definition
  const frameSection = connectProto.slice(connectProto.indexOf('export type ConnectFrame ='))
  expect(frameSection).not.toContain('apiKey')
  expect(frameSection).not.toContain('api_key')

  const webviewProto = readFileSync(resolve(import.meta.dir, '../src/vscode/shared/webviewProtocol.ts'), 'utf8')
  const setupSection = webviewProto.slice(webviewProto.indexOf('export interface ProviderSetupView'))
  const setupDef = setupSection.slice(0, setupSection.indexOf('}'))
  expect(setupDef).not.toContain('apiKey')
  expect(setupDef).not.toContain('api_key')
  expect(setupDef).not.toContain('secret')
  expect(setupDef).not.toContain('password')
})
