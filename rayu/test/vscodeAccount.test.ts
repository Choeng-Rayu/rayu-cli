/**
 * Settings → Account: the token-free view the host builds from the profile, credits and
 * feature usage, when it reads them, what the tab renders, and the shared clients it
 * reads through (against a local server, never the real backend).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  DEVICES_UNAVAILABLE,
  FEATURES_UNAVAILABLE,
  USAGE_UNAVAILABLE,
  devicesView,
  loadAccountView,
  usageView,
  type AccountSources,
} from '../src/vscode/host/account/accountService.js'
import { removalPrompt, removeDevice } from '../src/vscode/host/account/deviceRemoval.js'
import { signOutRayucode } from '../src/vscode/host/account/accountChild.js'
import { AccountSettings } from '../src/vscode/host/settings/accountSettings.js'
import type { AuthSnapshot } from '../src/vscode/host/auth/rayuAuthBridge.js'
import type { RemoteDevice } from '../src/services/rayuAuth/rayuDevices.js'
import { fetchDevices } from '../src/services/rayuAuth/rayuDevices.js'
import {
  PACING_SWITCH_HINT,
  TEAM_PACING_HINT,
  fetchRayuCredits,
  type RayuCreditStatus,
} from '../src/services/rayuAuth/rayuCredits.js'
import { rayuPacingAction } from '../src/services/rayuAuth/rayuRateLimit.js'
import { fetchRayuProfile, parseRayuProfile } from '../src/services/rayuAuth/rayuProfile.js'
import {
  _resetFeatureUsageForTesting,
  _setFeatureUsageForTesting,
  listFeatureUsage,
  refreshFeatureUsage,
} from '../src/services/rayuAuth/rayuFeatureUsage.js'
import { getRayuAccountPageUrl, getRayuDashboardUrl, getRayuPlansUrl } from '../src/services/rayuAuth/rayuSession.js'
import type { AccountSectionView, AccountView, DeviceView } from '../src/vscode/shared/settingsProtocol.js'
import { AccountSection, describeDevice, formatPlanPrice } from '../src/vscode/webview/settings/AccountSection.js'

const NOW = Date.UTC(2026, 4, 10, 12, 0, 0)

const SIGNED_IN: AuthSnapshot = {
  signedIn: true,
  gateMessage: null,
  identity: { email: 'ada@example.com', displayName: 'Ada' },
  oauthEnabled: true,
}

const CREDITS: RayuCreditStatus = {
  plan: 'pro',
  planName: 'Pro',
  priceCents: 2000,
  creditsPerPeriod: 50_000,
  usedCredits: 1_250,
  remainingCredits: 48_750,
  tokensPerCredit: 100,
  allowanceTokens: null,
  usedTokens: null,
  remainingTokens: null,
  resetSeconds: 86_400,
  periodEnd: '2026-06-01T00:00:00.000Z',
  topupBalance: 300,
  topUpEnabled: true,
  creditsPer5h: 625,
  windowUsedCredits: 625,
  windowResetSeconds: 3_600,
  creditsPerWeek: 10_000,
  weekUsedCredits: 1_250,
  weekResetSeconds: 172_800,
  limitMode: 'gated',
}

const DEVICES: RemoteDevice[] = [
  { deviceId: 'older-device-0001', deviceName: 'old-desktop', platform: 'win32', arch: 'x64', version: '2.2.0', status: 'offline', online: false, lastSeenAt: '2026-04-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
  { deviceId: 'newer-device-0002', deviceName: 'laptop', platform: 'darwin', arch: 'arm64', version: '2.3.1', status: 'online', online: true, lastSeenAt: '2026-05-10T11:59:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' },
  { deviceId: 'this-device-00003', deviceName: 'dev-box', platform: 'linux', arch: 'x64', version: '2.3.1', status: 'offline', online: false, lastSeenAt: '2026-05-09T00:00:00.000Z', createdAt: '2026-03-01T00:00:00.000Z' },
]

function sources(overrides: Partial<AccountSources> = {}): AccountSources {
  return {
    auth: () => SIGNED_IN,
    hasAccountSession: () => true,
    profile: async () => ({
      user: { id: 7, email: 'ada@lovelace.dev', displayName: 'Ada Lovelace', avatarUrl: null, role: 'user' },
      status: 'active',
    }),
    credits: async () => CREDITS,
    features: async () => [{ key: 'image_generation', label: 'Image generation', used: 3, limit: 10 }],
    devices: async () => DEVICES,
    thisDeviceId: () => 'this-device-00003',
    now: () => NOW,
    ...overrides,
  }
}

describe('loadAccountView', () => {
  test('with sign-in switched off there is nothing to show', async () => {
    expect(await loadAccountView(sources({ auth: () => ({ ...SIGNED_IN, oauthEnabled: false }) }))).toEqual({ kind: 'disabled' })
  })

  test('signed out, or only an API key, reads nothing from the network', async () => {
    let requests = 0
    const counting = { profile: async () => { requests++; return null }, credits: async () => { requests++; return null } }
    expect(await loadAccountView(sources({ ...counting, hasAccountSession: () => false, auth: () => ({ ...SIGNED_IN, signedIn: false, identity: null }) })))
      .toEqual({ kind: 'signedOut' })
    expect(await loadAccountView(sources({ ...counting, hasAccountSession: () => false }))).toEqual({ kind: 'apiKey' })
    expect(requests).toBe(0)
  })

  test('signed in: the live profile, the plan and credits, and the feature usage', async () => {
    const view = await loadAccountView(sources())
    expect(view).toMatchObject({
      kind: 'signedIn',
      identity: { displayName: 'Ada Lovelace', email: 'ada@lovelace.dev', active: true },
      usage: { ok: true, value: { planName: 'Pro', priceCents: 2000 } },
      features: { ok: true, value: [{ key: 'image_generation', label: 'Image generation', used: 3, limit: 10 }] },
    })
  })

  test('each part fails on its own, and the stored identity stands in for the profile', async () => {
    const view = await loadAccountView(sources({
      profile: async () => null,
      credits: async () => null,
      features: async () => null,
      devices: async () => null,
    }))
    expect(view).toEqual({
      kind: 'signedIn',
      identity: { displayName: 'Ada', email: 'ada@example.com', active: true },
      usage: { ok: false, error: USAGE_UNAVAILABLE },
      features: { ok: false, error: FEATURES_UNAVAILABLE },
      devices: { ok: false, error: DEVICES_UNAVAILABLE },
    })
  })

  test('devices list this machine first, then the most recently seen', async () => {
    const view = await loadAccountView(sources())
    const devices = view.kind === 'signedIn' && view.devices.ok ? view.devices.value : []
    expect(devices.map(device => [device.name, device.thisMachine, device.status])).toEqual([
      ['dev-box', true, 'offline'],
      ['laptop', false, 'online'],
      ['old-desktop', false, 'offline'],
    ])
    // Field by field: the registry's createdAt and online flag do not ride along.
    expect(Object.keys(devices[0]!).sort()).toEqual(['arch', 'deviceId', 'lastSeenAt', 'name', 'platform', 'status', 'thisMachine', 'version'])
  })

  test('with no identity yet, no device is this machine', () => {
    expect(devicesView(DEVICES, null).some(device => device.thisMachine)).toBe(false)
  })

  test('an account Rayu does not report as active says so', async () => {
    const view = await loadAccountView(sources({
      profile: async () => ({ user: { id: 7, email: null, displayName: null, avatarUrl: null, role: 'user' }, status: 'suspended' }),
    }))
    expect(view.kind === 'signedIn' && view.identity.active).toBe(false)
  })

  test('nothing secret reaches the view', async () => {
    const json = JSON.stringify(await loadAccountView(sources()))
    for (const field of ['token', 'Token', 'refresh', 'avatarUrl', 'apiKey']) expect(json).not.toContain(field)
  })
})

describe('usageView', () => {
  test('the period allowance, top-ups and renewal', () => {
    const view = usageView(CREDITS, NOW)
    expect(view).toMatchObject({
      planName: 'Pro',
      renewsAt: '2026-06-01T00:00:00.000Z',
      credits: { perPeriod: 50_000, used: 1_250, remaining: 48_750 },
      topUpBalance: 300,
      team: false,
      dailyTurns: null,
    })
  })

  test('pacing windows carry absolute reset times, and a full one says what to do', () => {
    const { pacing } = usageView(CREDITS, NOW)
    expect(pacing.windows).toEqual([
      { id: 'session', cap: 625, used: 625, resetsAt: NOW + 3_600_000 },
      { id: 'weekly', cap: 10_000, used: 1_250, resetsAt: NOW + 172_800_000 },
    ])
    expect(pacing).toMatchObject({ enforced: true, advice: PACING_SWITCH_HINT })
    // The same advice the terminal and the chat's limit notice give.
    expect(pacing.advice).toBe(rayuPacingAction({ window: 'session', resetsAt: null, paced: true, scope: 'personal' }))
  })

  test('a team member is pointed at their admin', () => {
    const view = usageView({ ...CREDITS, scope: 'team' }, NOW)
    expect(view.team).toBe(true)
    expect(view.pacing.advice).toBe(TEAM_PACING_HINT)
    expect(view.pacing.advice).toBe(rayuPacingAction({ window: 'session', resetsAt: null, paced: true, scope: 'team' }))
  })

  test('with pacing turned off, a full window is no reason to warn', () => {
    expect(usageView({ ...CREDITS, limitMode: 'full_credits' }, NOW).pacing).toMatchObject({ enforced: false, advice: null })
  })

  test('windows the plan does not set are left out; no allowance and no top-ups read as such', () => {
    const view = usageView({
      ...CREDITS,
      creditsPerPeriod: null,
      remainingCredits: null,
      creditsPer5h: null,
      creditsPerWeek: 0,
      topUpEnabled: false,
    }, NOW)
    expect(view.credits).toBeNull()
    expect(view.pacing.windows).toEqual([])
    expect(view.topUpBalance).toBeNull()
  })

  test('a missing remaining count is derived from the allowance', () => {
    expect(usageView({ ...CREDITS, remainingCredits: null }, NOW).credits?.remaining).toBe(48_750)
  })

  test('daily turns, when the plan caps them', () => {
    expect(usageView({ ...CREDITS, maxDailyTurns: 50, turnsUsedToday: 12, turnsResetSeconds: 600 }, NOW).dailyTurns)
      .toEqual({ max: 50, used: 12, remaining: 38, resetsAt: NOW + 600_000 })
  })
})

describe('AccountSettings', () => {
  function harness(load: () => Promise<AccountView>, now = { value: NOW }) {
    const published: AccountSectionView[] = []
    return { account: new AccountSettings(load, view => published.push(view), () => now.value), published, now }
  }

  test('a refresh shows loading, then the account with when it was read', async () => {
    const { account, published } = harness(async () => ({ kind: 'signedOut' }))
    await account.refresh()
    expect(published.map(view => view.status)).toEqual(['loading', 'ready'])
    expect(account.current).toEqual({ status: 'ready', account: { kind: 'signedOut' }, error: null, updatedAt: NOW })
  })

  test('a refresh asked for while one runs runs once more, not twice', async () => {
    let loads = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { account } = harness(async () => {
      loads++
      if (loads === 1) await gate
      return { kind: 'signedOut' }
    })
    const first = account.refresh()
    void account.refresh()
    void account.refresh()
    release()
    await first
    expect(loads).toBe(2)
  })

  test('opening the section re-reads only an account older than a minute', async () => {
    let loads = 0
    const { account, now } = harness(async () => { loads++; return { kind: 'signedOut' } })
    await account.refreshIfStale()
    now.value += 30_000
    await account.refreshIfStale()
    expect(loads).toBe(1)
    now.value += 31_000
    await account.refreshIfStale()
    expect(loads).toBe(2)
  })

  test('a sign-in change does nothing until the section has been shown', async () => {
    let loads = 0
    const { account } = harness(async () => { loads++; return { kind: 'signedOut' } })
    await account.sessionChanged()
    expect(loads).toBe(0)
    await account.refresh()
    await account.sessionChanged()
    expect(loads).toBe(2)
  })

  test('an unexpected failure keeps what was shown and says so', async () => {
    const warn = console.warn
    console.warn = () => {}
    try {
      let fail = false
      const { account } = harness(async () => {
        if (fail) throw new Error('boom')
        return { kind: 'signedOut' }
      })
      await account.refresh()
      fail = true
      await account.refresh()
      expect(account.current).toMatchObject({ status: 'ready', account: { kind: 'signedOut' }, error: 'Could not load your Rayu account.' })
    } finally {
      console.warn = warn
    }
  })
})

describe('AccountSection', () => {
  const render = (account: AccountView | null, patch: Partial<AccountSectionView> = {}): string =>
    renderToStaticMarkup(createElement(AccountSection, {
      account: { status: 'ready', account, error: null, updatedAt: NOW, ...patch },
      onRefresh: () => {},
      onAction: () => {},
      onOpenLink: () => {},
      onRemoveDevice: () => {},
    }))

  test('signed out offers sign-in and an API key; an API key user is asked to sign in for usage', () => {
    const signedOut = render({ kind: 'signedOut' })
    expect(signedOut).toContain('>Sign in<')
    expect(signedOut).toContain('>Use an API key<')
    const apiKey = render({ kind: 'apiKey' })
    expect(apiKey).toContain('Rayu API key')
    expect(apiKey).toContain('>Manage API keys<')
  })

  test('sign-in switched off is explained', () => {
    expect(render({ kind: 'disabled' })).toContain('turned off in this build')
  })

  test('signed in: identity, plan, meters with their counts, advice and links', async () => {
    const html = render(await loadAccountView(sources()))
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain('ada@lovelace.dev')
    expect(html).toContain('Pro · $20 / month')
    expect(html).toContain('Renews Jun 1, 2026')
    expect(html).toContain('1,250 / 50,000')
    expect(html).toContain('48,750 left')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemax="625"')
    expect(html).toContain('rs-meter-full')
    expect(html).toContain('Top-up balance: 300 credits')
    expect(html).toContain('Turn on &quot;use all credits&quot; in your dashboard')
    expect(html).toContain('Image generation')
    for (const link of ['Manage plan', 'Compare plans', 'Billing', 'Usage details', 'Buy credits', 'Pacing settings']) {
      expect(html).toContain(`>${link}<`)
    }
    expect(html).toContain('>Sign out<')
  })

  test('a team member gets no pacing switch link', () => {
    const html = render({
      kind: 'signedIn',
      identity: { displayName: 'Ada', email: null, active: true },
      usage: { ok: true, value: usageView({ ...CREDITS, scope: 'team' }, NOW) },
      features: { ok: true, value: [] },
      devices: { ok: true, value: [] },
    })
    expect(html).toContain('Ask your team admin')
    expect(html).not.toContain('>Pacing settings<')
    expect(html).toContain('No devices yet.')
  })

  test('a part that failed offers a retry, and the rest still shows', () => {
    const html = render({
      kind: 'signedIn',
      identity: { displayName: 'Ada', email: null, active: false },
      usage: { ok: false, error: USAGE_UNAVAILABLE },
      features: { ok: true, value: [{ key: 'video_generation', label: 'Video generation', used: 2, limit: null }] },
      devices: { ok: false, error: DEVICES_UNAVAILABLE },
    })
    expect(html).toContain(USAGE_UNAVAILABLE)
    expect(html).toContain(DEVICES_UNAVAILABLE)
    expect(html).toContain('>Retry<')
    expect(html).toContain('Video generation: 2 used · unlimited')
    expect(html).toContain('not active')
  })

  test('loading, and a whole-section failure', () => {
    expect(render(null, { status: 'loading' })).toContain('Loading your account')
    expect(render(null, { error: 'Could not load your Rayu account.' })).toContain('>Retry<')
  })

  test('prices', () => {
    expect(formatPlanPrice(0)).toBe('Free')
    expect(formatPlanPrice(2000)).toBe('$20 / month')
    expect(formatPlanPrice(1999)).toBe('$19.99 / month')
  })

  test('devices show this machine, the platform and when each was last seen, each with Remove', async () => {
    const html = render(await loadAccountView(sources()))
    expect(html).toContain('<span class="rs-badge">This machine</span>')
    expect(html.match(/>Remove</g)).toHaveLength(3)
    expect(html).toContain('macOS · arm64 · Rayu 2.3.1 · Online now')
    expect(html).toContain('Windows · x64 · Rayu 2.2.0 · Last seen Apr 1, 2026')
  })
})

// ── devices and sign-out ─────────────────────────────────────────────────────

const DEVICE: DeviceView = {
  deviceId: 'Ab3_-dEf9GhIjKlMnOpQrS', name: 'laptop', platform: 'darwin', arch: 'arm64',
  version: '2.3.1', status: 'offline', lastSeenAt: '2026-05-01T00:00:00.000Z', thisMachine: false,
}

describe('removeDevice', () => {
  test('only a device the tab was shown, only after the user agrees', async () => {
    const removed: string[] = []
    const deps = (agree: boolean, accepted = true) => ({
      confirm: async () => agree,
      unregister: async (id: string) => { removed.push(id); return accepted },
    })
    expect(await removeDevice('Zz9_-unknown-device00', [DEVICE], deps(true))).toBe('unknown')
    expect(await removeDevice(DEVICE.deviceId, [DEVICE], deps(false))).toBe('cancelled')
    expect(removed).toEqual([])
    expect(await removeDevice(DEVICE.deviceId, [DEVICE], deps(true, false))).toBe('failed')
    expect(await removeDevice(DEVICE.deviceId, [DEVICE], deps(true))).toBe('removed')
    expect(removed).toEqual([DEVICE.deviceId, DEVICE.deviceId])
  })

  test('the confirmation names the machine, and says when it is this one', () => {
    expect(removalPrompt(DEVICE).message).toBe('Remove laptop from your Rayu devices?')
    expect(removalPrompt({ ...DEVICE, thisMachine: true }).detail).toContain('the machine you are using')
  })

  test('a description falls back to the raw platform name', () => {
    expect(describeDevice({ ...DEVICE, platform: 'freebsd', status: 'uninstalling', lastSeenAt: '' })).toBe('freebsd · arm64 · Rayu 2.3.1 · uninstalling')
  })
})

describe('signOutRayucode', () => {
  function deps(outcome: { ok: true; value: true } | { ok: false; error: string }) {
    const calls: string[] = []
    return {
      calls,
      deps: {
        signOutThroughEngine: async () => { calls.push('engine'); return outcome },
        clearSession: () => calls.push('session'),
        clearHostCaches: () => calls.push('caches'),
        warn: () => calls.push('warn'),
      },
    }
  }

  test('the engine child signs out fully, then the host forgets its own caches', async () => {
    const { calls, deps: d } = deps({ ok: true, value: true })
    await signOutRayucode(d)
    expect(calls).toEqual(['engine', 'caches'])
  })

  test('when the child cannot run, the session is still cleared', async () => {
    const { calls, deps: d } = deps({ ok: false, error: 'spawn ENOENT' })
    await signOutRayucode(d)
    expect(calls).toEqual(['engine', 'warn', 'session', 'caches'])
  })
})

// ── the shared clients, against a local server ───────────────────────────────

describe('account clients', () => {
  const saved = {
    auth: process.env.RAYU_AUTH_CONFIG_DIR,
    api: process.env.RAYU_API_URL,
    gateway: process.env.RAYU_GATEWAY_URL,
    web: process.env.RAYU_WEB_URL,
    oauth: process.env.USE_RAYU_OAUTH,
  }
  let dir: string
  let server: ReturnType<typeof Bun.serve> | null = null
  const seen: Array<{ path: string; authorization: string | null }> = []

  function serve(routes: Record<string, (request: Request) => Response | Promise<Response>>): void {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const url = new URL(request.url)
        seen.push({ path: url.pathname, authorization: request.headers.get('authorization') })
        return routes[url.pathname]?.(request) ?? new Response('not found', { status: 404 })
      },
    })
    process.env.RAYU_API_URL = `http://127.0.0.1:${server.port}/api`
    process.env.RAYU_GATEWAY_URL = `http://127.0.0.1:${server.port}`
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayucode-account-'))
    process.env.RAYU_AUTH_CONFIG_DIR = dir
    process.env.USE_RAYU_OAUTH = 'true'
    writeFileSync(join(dir, 'rayu-auth.json'), JSON.stringify({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 7, email: 'ada@example.com', displayName: 'Ada', avatarUrl: null, role: 'user' },
    }))
    seen.length = 0
    _resetFeatureUsageForTesting()
  })

  afterEach(() => {
    server?.stop(true)
    server = null
    for (const [key, name] of [['auth', 'RAYU_AUTH_CONFIG_DIR'], ['api', 'RAYU_API_URL'], ['gateway', 'RAYU_GATEWAY_URL'], ['web', 'RAYU_WEB_URL'], ['oauth', 'USE_RAYU_OAUTH']] as const) {
      if (saved[key] === undefined) delete process.env[name]
      else process.env[name] = saved[key]
    }
    _resetFeatureUsageForTesting()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the profile is read with the account token', async () => {
    serve({ '/api/me': () => Response.json({ user: { id: 7, email: 'ada@lovelace.dev', displayName: 'Ada L', avatarUrl: null, role: 'user' }, status: 'active' }) })
    expect(await fetchRayuProfile()).toEqual({
      user: { id: 7, email: 'ada@lovelace.dev', displayName: 'Ada L', avatarUrl: null, role: 'user' },
      status: 'active',
    })
    expect(seen).toEqual([{ path: '/api/me', authorization: 'Bearer test-access-token' }])
  })

  test('the token never follows a redirect', async () => {
    let followed = false
    serve({
      '/api/me': () => new Response(null, { status: 302, headers: { location: '/elsewhere' } }),
      '/elsewhere': () => { followed = true; return Response.json({}) },
    })
    expect(await fetchRayuProfile()).toBeNull()
    expect(followed).toBe(false)
  })

  test('a refused or slow profile is null', async () => {
    serve({ '/api/me': () => new Response('', { status: 401 }) })
    expect(await fetchRayuProfile()).toBeNull()
    server?.stop(true)
    serve({ '/api/me': () => new Promise<Response>(() => {}) })
    const started = Date.now()
    expect(await fetchRayuProfile({ timeoutMs: 200 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('only a profile-shaped answer is accepted', () => {
    expect(parseRayuProfile(null)).toBeNull()
    expect(parseRayuProfile({ user: { id: '7' }, status: 'active' })).toBeNull()
    expect(parseRayuProfile({ user: { id: 7 }, status: 1 })).toBeNull()
    expect(parseRayuProfile({ user: { id: 7, email: 3 }, status: 'active' }))
      .toEqual({ user: { id: 7, email: null, displayName: null, avatarUrl: null, role: 'user' }, status: 'active' })
  })

  test('credits give up at their timeout', async () => {
    serve({ '/v1/credits': () => new Promise<Response>(() => {}) })
    const started = Date.now()
    expect(await fetchRayuCredits({ timeoutMs: 200 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('feature usage reports whether it is fresh, and lists the tools\' features first', async () => {
    serve({
      '/api/usage/features': () => Response.json({
        web_search: { used: 4, limit: null },
        video_generation: { used: 1, limit: 5 },
        image_generation: { used: 3, limit: 10 },
        bad: 'x',
      }),
    })
    expect(await refreshFeatureUsage()).toBe(true)
    expect(listFeatureUsage()).toEqual([
      { key: 'image_generation', label: 'Image generation', used: 3, limit: 10 },
      { key: 'video_generation', label: 'Video generation', used: 1, limit: 5 },
      { key: 'web_search', label: 'Web search', used: 4, limit: null },
    ])
    server?.stop(true)
    serve({ '/api/usage/features': () => new Response('', { status: 500 }) })
    expect(await refreshFeatureUsage()).toBe(false)
  })

  test('feature usage is unknown until it has been read', () => {
    expect(listFeatureUsage()).toBeNull()
    _setFeatureUsageForTesting({})
    expect(listFeatureUsage()).toEqual([])
  })

  test('the device list tells "none" from "could not read"', async () => {
    serve({ '/api/devices': () => Response.json([]) })
    expect(await fetchDevices()).toEqual([])
    expect(seen.at(-1)).toEqual({ path: '/api/devices', authorization: 'Bearer test-access-token' })
    server?.stop(true)
    serve({ '/api/devices': () => new Response('', { status: 500 }) })
    expect(await fetchDevices()).toBeNull()
  })

  test('every account link comes from one table on the web origin', () => {
    process.env.RAYU_WEB_URL = 'https://rayucode.example/'
    expect(getRayuAccountPageUrl('plan')).toBe('https://rayucode.example/dashboard/plan')
    expect(getRayuAccountPageUrl('usage')).toBe('https://rayucode.example/dashboard/usage')
    expect(getRayuAccountPageUrl('credits')).toBe('https://rayucode.example/dashboard/credits')
    expect(getRayuAccountPageUrl('apiKeys')).toBe('https://rayucode.example/dashboard/api-keys')
    expect(getRayuAccountPageUrl('billing')).toBe('https://rayucode.example/billing')
    expect(getRayuDashboardUrl()).toBe('https://rayucode.example/dashboard')
    expect(getRayuPlansUrl()).toBe('https://rayucode.example/plans')
  })
})
