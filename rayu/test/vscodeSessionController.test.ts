/**
 * Tests for SessionController, EngineManager, and IpcBridge (Task 16).
 *
 * These tests verify the new session-control abstraction layer without
 * requiring a live VS Code environment.
 */
import { expect, test, mock } from 'bun:test'
import { IpcBridge } from '../src/vscode/host/panel/ipcBridge.js'
import type { SessionController } from '../src/vscode/host/panel/sessionController.js'

// ── IpcBridge tests ────────────────────────────────────────────────────────────

test('IpcBridge.registerInbound routes messages to the handler', () => {
  const bridge = new IpcBridge()
  const received: unknown[] = []

  bridge.registerInbound('test:channel', payload => received.push(payload))
  bridge.routeInbound('test:channel', { value: 42 })

  expect(received).toHaveLength(1)
  expect((received[0] as { value: number }).value).toBe(42)
})

test('IpcBridge.registerInbound supports multiple handlers on one channel', () => {
  const bridge = new IpcBridge()
  const calls: string[] = []

  bridge.registerInbound('chan', () => calls.push('first'))
  bridge.registerInbound('chan', () => calls.push('second'))
  bridge.routeInbound('chan', {})

  expect(calls).toEqual(['first', 'second'])
})

test('IpcBridge.registerInbound returns an unregister function that removes the handler', () => {
  const bridge = new IpcBridge()
  const calls: number[] = []

  const unregister = bridge.registerInbound('chan', () => calls.push(1))
  bridge.routeInbound('chan', {})
  unregister()
  bridge.routeInbound('chan', {})

  expect(calls).toHaveLength(1)
})

test('IpcBridge.routeInbound for unknown channel is a no-op', () => {
  const bridge = new IpcBridge()
  // Must not throw
  expect(() => bridge.routeInbound('unknown:channel', {})).not.toThrow()
})

test('IpcBridge.sendOutbound is a no-op when not attached', () => {
  const bridge = new IpcBridge()
  // No error even without a connection
  expect(() => bridge.sendOutbound('telegram:prompt', { value: 'hi' })).not.toThrow()
})

test('IpcBridge.isAttached reflects connection state', () => {
  const bridge = new IpcBridge()
  expect(bridge.isAttached).toBe(false)

  const fakeConnection = {
    notify: mock(() => {}),
    request: mock(async () => ({})),
    destroy: mock(() => {}),
  } as never
  bridge.attach(fakeConnection)
  expect(bridge.isAttached).toBe(true)

  bridge.detach()
  expect(bridge.isAttached).toBe(false)
})

test('IpcBridge.requestOutbound throws when not attached', async () => {
  const bridge = new IpcBridge()
  await expect(bridge.requestOutbound('some:channel', {})).rejects.toThrow('not attached')
})

test('IpcBridge handler errors are swallowed and do not affect other handlers', () => {
  const bridge = new IpcBridge()
  const results: string[] = []

  bridge.registerInbound('chan', () => { throw new Error('boom') })
  bridge.registerInbound('chan', () => results.push('ok'))

  // Must not throw, and second handler still runs
  expect(() => bridge.routeInbound('chan', {})).not.toThrow()
  expect(results).toEqual(['ok'])
})

test('IpcBridge.dispose clears all handlers', () => {
  const bridge = new IpcBridge()
  const calls: number[] = []
  bridge.registerInbound('a', () => calls.push(1))
  bridge.registerInbound('b', () => calls.push(2))
  bridge.dispose()
  bridge.routeInbound('a', {})
  bridge.routeInbound('b', {})
  expect(calls).toHaveLength(0)
})

// ── SessionController type tests ───────────────────────────────────────────────
// (SessionController requires dynamic imports for IPC; just verify types compile)

test('SessionController type exports are importable', async () => {
  const mod = await import('../src/vscode/host/panel/sessionController.js')
  expect(typeof mod.SessionController).toBe('function')
})

test('EngineManager type exports are importable', async () => {
  const mod = await import('../src/vscode/host/panel/engineManager.js')
  expect(typeof mod.EngineManager).toBe('function')
})
