/**
 * Model-catalogue refreshes answer the conversation that asked.
 *
 * With several open conversations, the refresh behind the model dropdown used to resolve
 * "the current conversation" after its awaits. A user who switched conversations while a
 * refresh (or the `set_model` round trip before it) was in flight got one conversation's
 * capabilities shown in another, and the one they left stuck on a loading model list.
 * These drive `CatalogueRefresher` with controllable helper calls.
 */
import { describe, expect, test } from 'bun:test'

import type { ConnectOutcome } from '../src/vscode/host/auth/providerSetup.js'
import {
  CatalogueRefresher,
  catalogueRefreshMatches,
  catalogueRefreshModel,
  type RefreshableSession,
} from '../src/vscode/host/models/catalogueRefresh.js'
import type { InferenceSettingsView } from '../src/vscode/shared/inferenceSettings.js'
import type { ModelCatalogueView } from '../src/vscode/shared/webviewProtocol.js'

const pinned = 'openai\u0000gpt-x'
const saved = { model: 'claude-opus-4-6', provider: 'anthropic' }

describe('which model a refresh asks about', () => {
  test('an explicit choice wins, then the conversation’s own model', () => {
    expect(catalogueRefreshModel('anthropic\u0000claude-opus-4-6', pinned)).toBe(
      'anthropic\u0000claude-opus-4-6',
    )
    expect(catalogueRefreshModel(undefined, pinned)).toBe(pinned)
    expect(catalogueRefreshModel(undefined, null)).toBeUndefined()
  })

  test('an answer about a different model is never applied', () => {
    expect(
      catalogueRefreshMatches(pinned, { activeModel: pinned, activeProviderId: 'openai' }, saved),
    ).toBe(true)
    // Defensive: the helper echoes the requested model today. If it ever answered for
    // another one (say, falling back to the default), that answer must be dropped.
    expect(
      catalogueRefreshMatches(
        pinned,
        { activeModel: 'claude-opus-4-6', activeProviderId: 'anthropic' },
        saved,
      ),
    ).toBe(false)
  })

  test('with nothing asked for, the default answer applies only while it is still saved', () => {
    const answer = { activeModel: 'claude-opus-4-6', activeProviderId: 'anthropic' }
    expect(catalogueRefreshMatches(undefined, answer, saved)).toBe(true)
    expect(
      catalogueRefreshMatches(undefined, answer, { model: 'claude-opus-4-6', provider: 'other' }),
    ).toBe(false)
  })
})

const INFERENCE: InferenceSettingsView = {
  supportsEffort: true,
  supportedLevels: ['low', 'medium', 'high'],
  effort: null,
  effortEnvOverride: null,
  supportsThinking: true,
  thinkingEnabled: true,
}

class FakeSession implements RefreshableSession {
  availableModels: ModelCatalogueView | null = null
  readonly applied: InferenceSettingsView[] = []
  constructor(
    readonly name: string,
    readonly runtimeModel: string | null,
  ) {}
  applyInitialInference(value: InferenceSettingsView): void {
    this.applied.push(value)
  }
}

/** A helper call the test resolves by hand. */
interface PendingFetch {
  model: string | undefined
  resolve: (outcome: ConnectOutcome) => void
  reject: (cause: Error) => void
}

function harness(initiallyActive: FakeSession) {
  let active = initiallyActive
  const fetches: PendingFetch[] = []
  const posted: Array<{ to: string; catalogue: ModelCatalogueView }> = []
  let settled = 0
  const refresher = new CatalogueRefresher<FakeSession>({
    catalogueFor: session =>
      session.availableModels ?? { options: [], loading: false, error: null },
    fetch: model =>
      new Promise<ConnectOutcome>((resolve, reject) => fetches.push({ model, resolve, reject })),
    readPersistedModel: () => saved,
    isActive: session => session === active,
    post: catalogue => posted.push({ to: active.name, catalogue }),
    invalidate: () => {},
    isDisposed: () => false,
    onSettled: () => {
      settled += 1
    },
  })
  return {
    refresher,
    fetches,
    posted,
    settled: () => settled,
    activate: (session: FakeSession) => {
      active = session
    },
  }
}

/** Let queued promise callbacks run. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function answer(model: string): ConnectOutcome {
  return {
    ok: true,
    inference: INFERENCE,
    activeModel: model,
    activeProviderId: 'openai',
    catalogue: [{ value: model, label: model, description: '' }],
  }
}

describe('CatalogueRefresher', () => {
  test('switching away mid-refresh leaves no conversation stuck loading', async () => {
    const a = new FakeSession('A', pinned)
    const b = new FakeSession('B', 'anthropic\u0000claude-opus-4-6')
    const h = harness(a)

    const done = h.refresher.refresh(a)
    await tick()
    expect(a.availableModels?.loading).toBe(true)
    expect(h.posted).toHaveLength(1)

    h.activate(b)
    h.fetches[0]!.resolve(answer(pinned))
    await done

    expect(a.availableModels).toEqual({
      options: [{ value: pinned, label: pinned, description: '' }],
      loading: false,
      error: null,
    })
    expect(a.applied).toEqual([INFERENCE])
    // B was never touched, and nothing was shown in the panel while B was on screen.
    expect(b.availableModels).toBeNull()
    expect(b.applied).toEqual([])
    expect(h.posted.map(p => p.to)).toEqual(['A'])
    expect(h.settled()).toBe(1)
  })

  test('an explicit pick lands on the conversation it was made in, even off screen', async () => {
    const a = new FakeSession('A', pinned)
    const b = new FakeSession('B', null)
    const h = harness(b)

    const done = h.refresher.refresh(a, 'openai\u0000gpt-y')
    await tick()
    expect(h.fetches[0]!.model).toBe('openai\u0000gpt-y')
    h.fetches[0]!.resolve(answer('openai\u0000gpt-y'))
    await done

    expect(a.applied).toEqual([INFERENCE])
    expect(b.applied).toEqual([])
    expect(h.posted).toEqual([])
  })

  test('an explicit pick waits for a refresh already running for something else', async () => {
    const a = new FakeSession('A', pinned)
    const h = harness(a)

    const first = h.refresher.refresh(a)
    const second = h.refresher.refresh(a, 'openai\u0000gpt-y')
    await tick()
    // Not shared, and not concurrent: the explicit request has not started yet.
    expect(second).not.toBe(first)
    expect(h.fetches.map(f => f.model)).toEqual([pinned])

    h.fetches[0]!.resolve(answer(pinned))
    await first
    await tick()
    expect(h.fetches.map(f => f.model)).toEqual([pinned, 'openai\u0000gpt-y'])
    h.fetches[1]!.resolve(answer('openai\u0000gpt-y'))
    await second
    expect(a.applied).toHaveLength(2)
  })

  test('an identical implicit request shares the one in flight', async () => {
    const a = new FakeSession('A', pinned)
    const b = new FakeSession('B', null)
    const h = harness(a)

    const first = h.refresher.refresh(a)
    expect(h.refresher.refresh(a)).toBe(first)
    // A different conversation is not "identical", even with no explicit model.
    const forB = h.refresher.refresh(b)
    expect(forB).not.toBe(first)

    await tick()
    expect(h.fetches).toHaveLength(1)
    h.fetches[0]!.resolve(answer(pinned))
    await first
    await tick()
    h.fetches[1]!.resolve({ ok: true, activeModel: 'claude-opus-4-6', activeProviderId: 'anthropic' })
    await forB
    expect(h.fetches).toHaveLength(2)
    expect(h.refresher.pending).toBeNull()
  })

  test('a helper that throws still settles the list, with the reason', async () => {
    const a = new FakeSession('A', pinned)
    const h = harness(a)

    const done = h.refresher.refresh(a)
    await tick()
    expect(h.refresher.pending).not.toBeNull()
    h.fetches[0]!.reject(new Error('spawn EACCES'))
    await done

    expect(a.availableModels).toEqual({ options: [], loading: false, error: 'spawn EACCES' })
    expect(a.applied).toEqual([])
    expect(h.settled()).toBe(1)
    expect(h.refresher.pending).toBeNull()
  })
})
