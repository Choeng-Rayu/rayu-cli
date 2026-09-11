import { hostedEntitlements } from './helpers/hostedProvider.js'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncRayuHostedProvider } from '../src/services/rayuAuth/rayuHostedProvider.js'
import { loadRayuConfig, _resetRayuConfigCache, upsertProvider } from '../src/utils/rayuConfig.js'
import { modelSupportsThinking } from '../src/utils/thinking.js'
import { resolveImageSupport } from '../src/utils/model/imageCapability.js'
import type { RayuEntitlements } from '../src/services/rayuAuth/rayuEntitlements.js'
const original = process.env.RAYU_CONFIG_DIR
const dirs: string[] = []
afterEach(() => {
  if (original === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = original
  _resetRayuConfigCache()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
test('Rayu-hosted sync retains server-declared capabilities and shared resolvers use them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-hosted-')); dirs.push(dir)
  process.env.RAYU_CONFIG_DIR = dir; _resetRayuConfigCache()
  upsertProvider({ id: 'user-provider', kind: 'openai-compatible', defaultModel: 'user-model' })
  syncRayuHostedProvider(hostedEntitlements(), { activate: true })
  const config = loadRayuConfig(), provider = config.providers.find(p => p.id === 'rayu-hosted')!
  expect(config.activeProvider).toBe('rayu-hosted')
  expect(provider.modelLabels?.['admin-new-model']).toBe('New Admin Model')
  expect(provider.modelContextWindows?.['admin-new-model']).toBe(123456)
  expect(provider.modelSupportsImage).toEqual({ 'admin-new-model': true, 'admin-text-only': false })
  expect(modelSupportsThinking('admin-new-model')).toBe(true)
  expect(modelSupportsThinking('admin-text-only')).toBe(false)
  expect(resolveImageSupport('admin-new-model')).toBe('yes')
  expect(resolveImageSupport('admin-text-only')).toBe('no')
  expect(config.providers.find(p => p.id === 'user-provider')?.defaultModel).toBe('user-model')
})

test('packaged login fetches Rayu-hosted models; catalogue refresh follows admin edits without leaking credentials', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const { LOGIN_FLAG } = await import('../src/vscode/shared/loginProtocol.js')
  const { CONNECT_FLAG } = await import('../src/vscode/shared/connectProtocol.js')
  const { until } = await import('./helpers/vscodeSession.js')
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-login-')); dirs.push(dir)
  let entitlements = hostedEntitlements()
  let entitlementRequests = 0
  const secret = 'fixture-access-token-never-render'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => {
    const path = new URL(req.url).pathname
    if (path === '/cli/token') return Response.json({ accessToken: secret, refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 3600000, user: { id: 42, email: 'fixture@example.test', displayName: 'Fixture', avatarUrl: null, role: 'user' } })
    if (path === '/me/entitlements') {
      entitlementRequests++
      expect(req.headers.get('authorization')).toBe(`Bearer ${secret}`)
      return Response.json(entitlements)
    }
    return new Response('', { status: 404 })
  } })
  const env = { ...process.env, RAYU_CONFIG_DIR: dir, USE_RAYU_OAUTH: 'true', RAYU_API_URL: server.url.origin, RAYU_WEB_URL: server.url.origin, RAYU_GATEWAY_URL: server.url.origin }
  const engine = resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs')
  const child = Bun.spawn(['node', engine, LOGIN_FLAG], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' })
  const frames: any[] = []
  const collect = (async () => {
    let buffered = ''
    const reader = child.stdout.getReader()
    while (true) {
      const { value: bytes, done } = await reader.read()
      if (done) break
      buffered += new TextDecoder().decode(bytes)
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
        if (line.trim()) frames.push(JSON.parse(line))
      }
    }
  })()
  const stderr = new Response(child.stderr).text()
  try {
    await until(() => frames.some(f => f.type === 'rayucode_login_url'), 15000)
    const url = new URL(frames.find(f => f.type === 'rayucode_login_url').url)
    await fetch(`http://127.0.0.1:${url.searchParams.get('port')}/callback?code=fixture&state=${url.searchParams.get('state')}`)
    await until(() => frames.some(f => f.type === 'rayucode_login_result'), 15000)
    expect(frames.find(f => f.type === 'rayucode_login_result')).toMatchObject({ ok: true, displayName: 'Fixture' })
    const config = JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8'))
    expect(config.activeProvider).toBe('rayu-hosted')
    expect(config.providers[0].modelSupportsTools).toEqual({ 'admin-new-model': true, 'admin-text-only': false })
    // A server rename, context and capability change must not need a CLI/VSIX release.
    entitlements.hostedModels[0] = { ...entitlements.hostedModels[0]!, label: 'Renamed Remotely', contextWindow: 234567, supportsImage: false }
    const listing = Bun.spawn(['node', engine, CONNECT_FLAG, JSON.stringify({ action: 'models' })], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(listing.stdout).text()
    expect(await listing.exited).toBe(0)
    const result = stdout.trim().split('\n').map(line => JSON.parse(line)).find(f => f.type === 'rayucode_connect_result')
    expect(result.catalogue[0]).toMatchObject({ value: 'rayu-hosted\u0000admin-new-model', label: 'Renamed Remotely', contextWindow: 234567, supportsImage: false, supportsThinking: true, supportsTools: true })
    expect(result.catalogue[1]).toMatchObject({ supportsThinking: false, supportsImage: false, supportsTools: false })
    expect(entitlementRequests).toBeGreaterThanOrEqual(2)
    expect(stdout + JSON.stringify(frames)).not.toContain(secret)
  } finally {
    child.kill(); await collect
    expect(await stderr).not.toContain(secret)
    server.stop(true)
  }
}, 40000)
