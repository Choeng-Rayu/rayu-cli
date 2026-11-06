/**
 * The Telegram permission relay: a chat answer resolves the same pending
 * `can_use_tool` request the editor is showing, and answering on either surface retires
 * the other's card.
 */
import { describe, expect, test } from 'bun:test'

import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from '../src/bridge/bridgePermissionCallbacks.js'
import {
  TelegramPermissionRelay,
  decisionFor,
} from '../src/telegram/telegramPermissionRelay.js'
import type { SDKControlRequest } from '../src/entrypoints/sdk/controlTypes.js'

function permissionRequest(
  requestId = 'req-1',
  overrides: Record<string, unknown> = {},
): SDKControlRequest {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'ls' },
      tool_use_id: 'tool-1',
      description: 'List files',
      ...overrides,
    },
  } as unknown as SDKControlRequest
}

interface Harness {
  relay: TelegramPermissionRelay
  injected: Array<{ requestId: string; decision: unknown }>
  requests: Array<{ requestId: string; toolName: string; description: string }>
  cancelled: string[]
  respond(requestId: string, response: BridgePermissionResponse): void
  setCallbacks(callbacks: BridgePermissionCallbacks | undefined): void
}

function harness(): Harness {
  const injected: Harness['injected'] = []
  const requests: Harness['requests'] = []
  const cancelled: string[] = []
  const handlers = new Map<string, (r: BridgePermissionResponse) => void>()
  let callbacks: BridgePermissionCallbacks | undefined

  const surface: BridgePermissionCallbacks = {
    sendRequest(requestId, toolName, _input, _toolUseId, description) {
      requests.push({ requestId, toolName, description })
    },
    sendResponse() {},
    cancelRequest(requestId) {
      cancelled.push(requestId)
    },
    onResponse(requestId, handler) {
      handlers.set(requestId, handler)
      return () => handlers.delete(requestId)
    },
  }
  callbacks = surface

  const relay = new TelegramPermissionRelay({
    injectDecision: (requestId, decision) => {
      injected.push({ requestId, decision })
    },
    callbacks: () => callbacks,
  })

  return {
    relay,
    injected,
    requests,
    cancelled,
    respond(requestId, response) {
      const handler = handlers.get(requestId)
      if (!handler) throw new Error(`no handler for ${requestId}`)
      handler(response)
    },
    setCallbacks(next) {
      callbacks = next
    },
  }
}

describe('TelegramPermissionRelay', () => {
  test('raises a card for a permission request', () => {
    const h = harness()
    h.relay.onControlRequestSent(permissionRequest())
    expect(h.requests).toEqual([
      { requestId: 'req-1', toolName: 'Bash', description: 'List files' },
    ])
  })

  test('ignores a request that is not a permission ask', () => {
    const h = harness()
    h.relay.onControlRequestSent({
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'set_model', model: 'x' },
    } as unknown as SDKControlRequest)
    expect(h.requests).toEqual([])
  })

  test('does nothing when no surface is connected', () => {
    const h = harness()
    h.setCallbacks(undefined)
    h.relay.onControlRequestSent(permissionRequest())
    expect(h.requests).toEqual([])
  })

  test('a chat allow resolves the pending request with an empty updatedInput', () => {
    // The schema REQUIRES updatedInput; `{}` means "use the original input".
    const h = harness()
    h.relay.onControlRequestSent(permissionRequest())
    h.respond('req-1', { behavior: 'allow' })
    expect(h.injected).toEqual([
      {
        requestId: 'req-1',
        decision: { behavior: 'allow', updatedInput: {} },
      },
    ])
  })

  test('a chat allow carries updated input and permissions through', () => {
    const h = harness()
    const updatedPermissions = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' },
    ]
    h.relay.onControlRequestSent(permissionRequest())
    h.respond('req-1', {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
      updatedPermissions: updatedPermissions as never,
    })
    expect(h.injected[0]?.decision).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
      updatedPermissions,
    })
  })

  test('a chat deny resolves as a deny bound to the tool use', () => {
    const h = harness()
    h.relay.onControlRequestSent(permissionRequest())
    h.respond('req-1', { behavior: 'deny', message: 'not now' })
    expect(h.injected[0]?.decision).toEqual({
      behavior: 'deny',
      message: 'not now',
      toolUseID: 'tool-1',
    })
  })

  test('a deny without a message still says why', () => {
    expect(decisionFor({ behavior: 'deny' })).toEqual({
      behavior: 'deny',
      message: 'Denied from Telegram',
    })
  })

  test('the host answering first retires the chat card', () => {
    const h = harness()
    h.relay.onControlRequestSent(permissionRequest())
    h.relay.onControlRequestResolved('req-1')
    expect(h.cancelled).toEqual(['req-1'])
    expect(h.injected).toEqual([])
  })

  test('a resolved request cannot later be answered from the chat', () => {
    const h = harness()
    h.relay.onControlRequestSent(permissionRequest())
    h.relay.onControlRequestResolved('req-1')
    // The detach ran, so the relay would not route this — simulate a late tap by
    // asserting the request is no longer tracked.
    expect(() => h.relay.cancelAll()).not.toThrow()
    expect(h.cancelled).toEqual(['req-1'])
  })

  test('answering from the chat does not also cancel the card', () => {
    // The chat edited its own card into the verdict; only the editor's dialog is
    // cancelled (by injectControlResponse), not the chat's.
    const h = harness()
    h.relay.onControlRequestSent(permissionRequest())
    h.respond('req-1', { behavior: 'allow' })
    expect(h.cancelled).toEqual([])
  })

  test('cancelAll retires every pending card exactly once', () => {
    const h = harness()
    h.relay.onControlRequestSent(permissionRequest('req-1'))
    h.relay.onControlRequestSent(permissionRequest('req-2'))
    h.relay.cancelAll()
    expect(h.cancelled).toEqual(['req-1', 'req-2'])
    h.relay.cancelAll()
    expect(h.cancelled).toEqual(['req-1', 'req-2'])
  })
})
