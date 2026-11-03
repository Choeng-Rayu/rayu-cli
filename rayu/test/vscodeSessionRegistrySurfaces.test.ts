/**
 * The SessionRegistry's per-surface contracts.
 *
 * `sessionRegistry.ts` is the model behind per-session tabs: several conversations open at
 * once, each with its own engine, one of them on screen. This pins the pieces the multi-tab
 * feature depends on and that are easy to get subtly wrong:
 *
 *   - `byKey`/`has` resolve an open conversation by its panel key.
 *   - `onRetire` fires for BOTH ways an entry leaves — `retireForCapacity` and `close` — and
 *     always carrying the entry itself.
 *   - `onShowPermission`/`onDismissPermission` carry the OWNING entry and fire
 *     UNCONDITIONALLY: a background conversation's card belongs in ITS tab, so it is no
 *     longer gated on the session being active.
 *   - `MAX_LIVE_SESSIONS` is respected for idle sessions, and a session mid-turn is never
 *     retired to honour it.
 *
 * `sessionRegistry` → `sessionHandle` does not import `vscode`, so this runs under `bun test`
 * with no module mock. Creating a `ChatSession` does not spawn an engine; only `warmup` /
 * `submitPrompt` do, and only the running-session test needs that.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  MAX_LIVE_SESSIONS,
  SessionRegistry,
  type SessionEntry,
} from '../src/vscode/host/panel/sessionRegistry.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

const registries: SessionRegistry[] = []

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

interface ShownCard {
  entry: SessionEntry
  requestId: string
}

/** A registry whose pushes are recorded instead of posted to a webview. */
function makeRegistry(): {
  registry: SessionRegistry
  retired: SessionEntry[]
  shown: ShownCard[]
  dismissed: ShownCard[]
  activated: SessionEntry[]
} {
  const retired: SessionEntry[] = []
  const shown: ShownCard[] = []
  const dismissed: ShownCard[] = []
  const activated: SessionEntry[] = []
  const registry = new SessionRegistry(
    // Never warmed up in most tests; a bogus path guarantees a spawn cannot succeed in the
    // one test that does submit a prompt.
    { enginePath: '/nonexistent/rayucode-engine.mjs', cwd: '/tmp' },
    {
      sessionCallbacks: () => sessionCallbacks(),
      onShowPermission: (entry, request) => shown.push({ entry, requestId: request.requestId }),
      onDismissPermission: (entry, requestId) => dismissed.push({ entry, requestId }),
      onChanged: () => {},
      onActivate: entry => activated.push(entry),
      onRetire: entry => retired.push(entry),
    },
  )
  registries.push(registry)
  return { registry, retired, shown, dismissed, activated }
}

/** A pending `can_use_tool` request, in the shape the engine sends. */
function permissionRequest(requestId: string): never {
  return {
    requestId,
    request: { tool_name: 'Bash', input: { command: 'echo hi' } },
  } as never
}

describe('byKey / has', () => {
  test('resolve an open conversation by its panel key', () => {
    const { registry } = makeRegistry()
    const first = registry.create()
    const second = registry.create()

    expect(registry.byKey(first.key)).toBe(first)
    expect(registry.byKey(second.key)).toBe(second)
    expect(registry.has(first.key)).toBe(true)
  })

  test('report not-found for an unknown key', () => {
    const { registry } = makeRegistry()
    registry.create()

    expect(registry.byKey('panel-nope')).toBeNull()
    expect(registry.has('panel-nope')).toBe(false)
  })
})

describe('onRetire', () => {
  test('fires for the entry evicted by retireForCapacity', async () => {
    const { registry, retired } = makeRegistry()
    expect(MAX_LIVE_SESSIONS).toBe(4)

    const entries: SessionEntry[] = []
    for (let index = 0; index < MAX_LIVE_SESSIONS; index += 1) {
      entries.push(registry.create())
      // Distinct activity instants so "idlest" is unambiguous: the first is oldest.
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    expect(registry.all).toHaveLength(MAX_LIVE_SESSIONS)

    const oldest = entries[0]!
    registry.create() // the 5th, with every session idle → evict the idlest

    expect(registry.all).toHaveLength(MAX_LIVE_SESSIONS)
    expect(retired.map(entry => entry.key)).toEqual([oldest.key])
    expect(registry.has(oldest.key)).toBe(false)
  })

  test('fires for the entry closed explicitly', () => {
    const { registry, retired } = makeRegistry()
    const first = registry.create()
    const second = registry.create()

    registry.close(second.key)
    expect(retired.map(entry => entry.key)).toEqual([second.key])
    expect(registry.has(second.key)).toBe(false)

    // An unknown key is a no-op: nothing retired, nothing fired.
    registry.close('panel-nope')
    expect(retired.map(entry => entry.key)).toEqual([second.key])
    expect(registry.has(first.key)).toBe(true)
  })
})

describe('permission callbacks carry the owning entry', () => {
  test('a background session\'s card is routed with ITS entry, not the active one', () => {
    const { registry, shown, dismissed } = makeRegistry()
    const background = registry.create()
    const foreground = registry.create()
    expect(registry.activeSessionKey).toBe(foreground.key)

    // The card is raised by the BACKGROUND conversation. The active key no longer gates the
    // push: a background tab must render its own approval card.
    background.permissions.present(permissionRequest('req-bg'))

    expect(shown).toHaveLength(1)
    expect(shown[0]!.entry).toBe(background)
    expect(shown[0]!.entry).not.toBe(foreground)
    expect(shown[0]!.requestId).toBe('req-bg')

    background.permissions.dismiss('req-bg')
    expect(dismissed).toHaveLength(1)
    expect(dismissed[0]!.entry).toBe(background)
    expect(dismissed[0]!.requestId).toBe('req-bg')
  })

  test('and it fires even while a different session is on screen', () => {
    const { registry, shown } = makeRegistry()
    const first = registry.create()
    registry.create()
    registry.create()
    const last = registry.create()
    expect(registry.activeSessionKey).toBe(last.key)

    first.permissions.present(permissionRequest('req-1'))

    expect(shown.map(card => card.entry.key)).toEqual([first.key])
  })
})

describe('capacity', () => {
  test('never retires a session whose turn is running', () => {
    const { registry, retired } = makeRegistry()
    const busy = registry.create()

    // `submitPrompt` flips the running flag synchronously, before it awaits the engine, so
    // this is a genuine mid-turn session without a live child.
    void busy.session.submitPrompt('slow')
    expect(busy.session.isTurnRunning).toBe(true)

    for (let index = 0; index < MAX_LIVE_SESSIONS + 2; index += 1) registry.create()

    // The cap is a resource guard; honouring it by killing a running turn is the bug the
    // registry exists to remove, so it is exceeded instead.
    expect(registry.has(busy.key)).toBe(true)
    expect(busy.session.isTurnRunning).toBe(true)
    expect(retired.some(entry => entry.key === busy.key)).toBe(false)
  })

  test('a session blocked on an approval is not idle and is not retired', () => {
    const { registry, retired } = makeRegistry()
    const blocked = registry.create()
    blocked.permissions.present(permissionRequest('req-block'))

    for (let index = 0; index < MAX_LIVE_SESSIONS + 2; index += 1) registry.create()

    expect(registry.has(blocked.key)).toBe(true)
    expect(retired.some(entry => entry.key === blocked.key)).toBe(false)
  })
})
