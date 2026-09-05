/**
 * composeBridgePermissionCallbacks — fan-out, first-wins, losers cancelled.
 *
 * This exists because the bug it fixes was INVISIBLE. The permission call site used a
 * `??` chain, so with both the Telegram bridge and the Web Bridge connected only the
 * first was ever asked; the second showed no prompt at all and the user watching it saw
 * a session that had stopped for no reason. Nothing threw and nothing was logged, so
 * only a test that asserts "every member is asked" can keep it fixed.
 */

import { describe, expect, test } from 'bun:test'
import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from '../src/bridge/bridgePermissionCallbacks.js'
import { composeBridgePermissionCallbacks } from '../src/bridge/composeBridgePermissionCallbacks.js'

/** A recording stand-in for one remote surface. */
function fakeMember(name: string) {
  const handlers = new Map<string, (r: BridgePermissionResponse) => void>()
  const log: string[] = []

  const member: BridgePermissionCallbacks = {
    sendRequest(requestId) {
      log.push(`send:${requestId}`)
    },
    sendResponse(requestId) {
      log.push(`response:${requestId}`)
    },
    cancelRequest(requestId) {
      log.push(`cancel:${requestId}`)
    },
    onResponse(requestId, handler) {
      handlers.set(requestId, handler)
      return () => handlers.delete(requestId)
    },
  }

  return {
    name,
    member,
    log,
    /** Simulate this remote answering. */
    answer(requestId: string, response: BridgePermissionResponse) {
      handlers.get(requestId)?.(response)
    },
    /** True while the composite is still subscribed to this member. */
    isSubscribed(requestId: string) {
      return handlers.has(requestId)
    },
  }
}

const REQ = 'req-1'
const ALLOW: BridgePermissionResponse = { behavior: 'allow' }

function send(callbacks: BridgePermissionCallbacks): void {
  callbacks.sendRequest(REQ, 'Bash', { command: 'ls' }, 'tool-use-1', 'List files')
}

describe('composeBridgePermissionCallbacks', () => {
  test('returns undefined when no remote is connected', () => {
    // `handleInteractivePermission` treats undefined as "no remote racer", so this has
    // to be undefined rather than an object that silently does nothing.
    expect(composeBridgePermissionCallbacks(undefined, undefined)).toBeUndefined()
  })

  test('returns the single member unwrapped', () => {
    const a = fakeMember('a')
    // The overwhelmingly common case; wrapping it would add indirection for nothing.
    expect(composeBridgePermissionCallbacks(undefined, a.member)).toBe(a.member)
  })

  test('asks EVERY connected remote — the bug this function exists to fix', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const composite = composeBridgePermissionCallbacks(a.member, b.member)!

    send(composite)

    expect(a.log).toEqual([`send:${REQ}`])
    expect(b.log).toEqual([`send:${REQ}`])
  })

  test('forwards the first answer exactly once', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const composite = composeBridgePermissionCallbacks(a.member, b.member)!

    const seen: BridgePermissionResponse[] = []
    composite.onResponse(REQ, r => seen.push(r))
    send(composite)

    a.answer(REQ, ALLOW)
    b.answer(REQ, { behavior: 'deny', message: 'too late' })

    // The late answer must not reach the gate. Applying it would mean a decision the
    // user made in one place being overridden by a click in another.
    expect(seen).toEqual([ALLOW])
  })

  test('cancels the LOSERS and not the winner', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const c = fakeMember('c')
    const composite = composeBridgePermissionCallbacks(a.member, b.member, c.member)!

    composite.onResponse(REQ, () => {})
    send(composite)
    b.answer(REQ, ALLOW)

    // The winner already resolved; telling it to cancel would be contradictory.
    expect(b.log).toEqual([`send:${REQ}`])
    // The others still have a live-looking card that must be withdrawn.
    expect(a.log).toEqual([`send:${REQ}`, `cancel:${REQ}`])
    expect(c.log).toEqual([`send:${REQ}`, `cancel:${REQ}`])
  })

  test('detaches from every member once answered', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const composite = composeBridgePermissionCallbacks(a.member, b.member)!

    composite.onResponse(REQ, () => {})
    send(composite)
    a.answer(REQ, ALLOW)

    // Detaching before notifying is what makes re-entrancy impossible.
    expect(a.isSubscribed(REQ)).toBe(false)
    expect(b.isSubscribed(REQ)).toBe(false)
  })

  test('a local win cancels on every remote', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const composite = composeBridgePermissionCallbacks(a.member, b.member)!

    send(composite)
    composite.cancelRequest(REQ)

    expect(a.log).toEqual([`send:${REQ}`, `cancel:${REQ}`])
    expect(b.log).toEqual([`send:${REQ}`, `cancel:${REQ}`])
  })

  test('a cancelled request can no longer be answered remotely', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const composite = composeBridgePermissionCallbacks(a.member, b.member)!

    const seen: BridgePermissionResponse[] = []
    composite.onResponse(REQ, r => seen.push(r))
    send(composite)
    composite.cancelRequest(REQ)

    a.answer(REQ, ALLOW)

    // The local dialog already resolved this. A remote answer arriving afterwards must
    // not reopen it.
    expect(seen).toEqual([])
  })

  test('sendResponse reaches every remote', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const composite = composeBridgePermissionCallbacks(a.member, b.member)!

    composite.sendResponse(REQ, ALLOW)

    expect(a.log).toEqual([`response:${REQ}`])
    expect(b.log).toEqual([`response:${REQ}`])
  })

  test('one throwing remote does not stop the others being asked', () => {
    const broken: BridgePermissionCallbacks = {
      sendRequest() {
        throw new Error('socket is gone')
      },
      sendResponse() {},
      cancelRequest() {},
      onResponse: () => () => {},
    }
    const good = fakeMember('good')
    const composite = composeBridgePermissionCallbacks(broken, good.member)!

    // A dead remote must degrade to "not a racer", never to "nobody gets asked".
    expect(() => send(composite)).not.toThrow()
    expect(good.log).toEqual([`send:${REQ}`])
  })

  test('unsubscribing detaches from all members', () => {
    const a = fakeMember('a')
    const b = fakeMember('b')
    const composite = composeBridgePermissionCallbacks(a.member, b.member)!

    const off = composite.onResponse(REQ, () => {})
    send(composite)
    off()

    expect(a.isSubscribed(REQ)).toBe(false)
    expect(b.isSubscribed(REQ)).toBe(false)
  })
})
