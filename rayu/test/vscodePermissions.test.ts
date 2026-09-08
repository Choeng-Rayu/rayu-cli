/**
 * Test suite for VS Code PermissionRouter semantics under success and failure:
 *  - All three payloads (allow-once, allow-always, deny) validate against the engine's
 *    real outputSchema().
 *  - Unanswered requests are cancelled and dismissed on new turn / reset.
 *  - Webview disposal mid-permission does not fabricate a denial (drops without responding).
 *  - Double-answer is strictly refused.
 *  - A mistimed interrupt still re-enables the composer without hanging.
 */
import { describe, expect, mock, test } from 'bun:test'

mock.module('vscode', () => ({
  window: {
    showQuickPick: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: [],
  },
}))

import { PermissionRouter } from '../src/vscode/host/panel/permissionRouter.js'
import { ControlClient } from '../src/vscode/host/engine/controlClient.js'
import { outputSchema } from '../src/utils/permissions/PermissionPromptToolResultSchema.js'

const { ChatSession } = await import('../src/vscode/host/panel/sessionHandle.js')

describe('PermissionRouter payload validation against engine outputSchema()', () => {
  test('allow-once validates against outputSchema()', () => {
    let sentPayload: Record<string, unknown> | null = null
    const control = new ControlClient(
      frame => {
        const parsed = frame as {
          type: string
          response?: { response?: Record<string, unknown> }
        }
        if (parsed.type === 'control_response') {
          sentPayload = parsed.response?.response ?? null
        }
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    const router = new PermissionRouter({
      onShow: () => {},
      onDismiss: () => {},
    })

    control.handleFrame({
      type: 'control_request',
      request_id: 'perm_once',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'git status' },
        tool_use_id: 'tool_1',
      },
    })

    router.present({
      requestId: 'perm_once',
      subtype: 'can_use_tool',
      request: {
        tool_name: 'Bash',
        input: { command: 'git status' },
        tool_use_id: 'tool_1',
      },
    })

    router.resolve(control, 'perm_once', { kind: 'allow-once' })

    expect(sentPayload).not.toBeNull()
    const validation = outputSchema().safeParse(sentPayload)
    expect(validation.success).toBe(true)
    if (validation.success && validation.data.behavior === 'allow') {
      expect(validation.data.behavior).toBe('allow')
      expect(validation.data.updatedInput).toEqual({ command: 'git status' })
      expect(validation.data.decisionClassification).toBe('user_temporary')
    }
  })

  test('allow-always validates against outputSchema() and retains suggested rules', () => {
    let sentPayload: Record<string, unknown> | null = null
    const control = new ControlClient(
      frame => {
        const parsed = frame as {
          type: string
          response?: { response?: Record<string, unknown> }
        }
        if (parsed.type === 'control_response') {
          sentPayload = parsed.response?.response ?? null
        }
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    const router = new PermissionRouter({
      onShow: () => {},
      onDismiss: () => {},
    })

    const suggestion = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm *' }],
      behavior: 'allow', destination: 'session',
    }

    control.handleFrame({
      type: 'control_request',
      request_id: 'perm_always',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm test' },
        tool_use_id: 'tool_2',
        permission_suggestions: [suggestion],
      },
    })

    router.present({
      requestId: 'perm_always',
      subtype: 'can_use_tool',
      request: {
        tool_name: 'Bash',
        input: { command: 'npm test' },
        tool_use_id: 'tool_2',
        permission_suggestions: [suggestion],
      },
    })

    router.resolve(control, 'perm_always', { kind: 'allow-always' })

    expect(sentPayload).not.toBeNull()
    const validation = outputSchema().safeParse(sentPayload)
    expect(validation.success).toBe(true)
    if (validation.success && validation.data.behavior === 'allow') {
      expect(validation.data.behavior).toBe('allow')
      expect(validation.data.updatedInput).toEqual({ command: 'npm test' })
      expect(validation.data.decisionClassification).toBe('user_permanent')
    }
  })

  test('deny validates against outputSchema() with user_reject classification', () => {
    let sentPayload: Record<string, unknown> | null = null
    const control = new ControlClient(
      frame => {
        const parsed = frame as {
          type: string
          response?: { response?: Record<string, unknown> }
        }
        if (parsed.type === 'control_response') {
          sentPayload = parsed.response?.response ?? null
        }
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    const router = new PermissionRouter({
      onShow: () => {},
      onDismiss: () => {},
    })

    control.handleFrame({
      type: 'control_request',
      request_id: 'perm_deny',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'rm -rf /' },
        tool_use_id: 'tool_3',
      },
    })

    router.present({
      requestId: 'perm_deny',
      subtype: 'can_use_tool',
      request: {
        tool_name: 'Bash',
        input: { command: 'rm -rf /' },
        tool_use_id: 'tool_3',
      },
    })

    router.resolve(control, 'perm_deny', { kind: 'deny' })

    expect(sentPayload).not.toBeNull()
    const validation = outputSchema().safeParse(sentPayload)
    expect(validation.success).toBe(true)
    if (validation.success && validation.data.behavior === 'deny') {
      expect(validation.data.behavior).toBe('deny')
      expect(validation.data.message).toBe('The user declined to run this tool.')
      expect(validation.data.decisionClassification).toBe('user_reject')
    }
  })
})

describe('PermissionRouter lifecycle under failure and edge cases', () => {
  test('unanswered requests are dismissed on cancelAll() without fabricating a denial', () => {
    const dismissed: string[] = []
    const sentFrames: unknown[] = []

    const control = new ControlClient(
      f => {
        sentFrames.push(f)
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    const router = new PermissionRouter({
      onShow: () => {},
      onDismiss: id => dismissed.push(id),
    })

    router.present({
      requestId: 'req_1',
      subtype: 'can_use_tool',
      request: { tool_name: 'Bash', input: {} },
    })
    router.present({
      requestId: 'req_2',
      subtype: 'can_use_tool',
      request: { tool_name: 'Edit', input: {} },
    })

    expect(router.hasPending).toBe(true)
    expect(router.snapshot()).toHaveLength(2)

    // Dispose / new session cancels all
    router.cancelAll()

    expect(router.hasPending).toBe(false)
    expect(router.snapshot()).toHaveLength(0)
    expect(dismissed).toEqual(['req_1', 'req_2'])
    // Rule: zero responses fabricated to control!
    expect(sentFrames).toHaveLength(0)
  })

  test('double-answer is strictly refused', () => {
    const sentFrames: unknown[] = []
    const control = new ControlClient(
      f => {
        sentFrames.push(f)
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    control.handleFrame({
      type: 'control_request',
      request_id: 'double_test',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { cmd: 'ls' },
        tool_use_id: 'tool_double',
      },
    })

    const router = new PermissionRouter({
      onShow: () => {},
      onDismiss: () => {},
    })

    router.present({
      requestId: 'double_test',
      subtype: 'can_use_tool',
      request: { tool_name: 'Bash', input: { cmd: 'ls' } },
    })

    // First decision
    router.resolve(control, 'double_test', { kind: 'allow-once' })
    expect(sentFrames).toHaveLength(1)

    // Second decision attempt is ignored
    router.resolve(control, 'double_test', { kind: 'deny' })
    expect(sentFrames).toHaveLength(1)
  })

  test('a mistimed interrupt still re-enables the composer', async () => {
    let turnStateCalls = 0
    let turnStateReported = false

    const session = new (ChatSession as any)(
      { enginePath: '/mock/engine.js', cwd: '/mock/cwd' },
      {
        onEntry: () => {},
        onPartial: () => {},
        onComplete: () => {},
        onTurnState: (running: boolean) => {
          turnStateCalls++
          turnStateReported = running
        },
        onModelInfo: () => {},
        onError: () => {},
        onPermissionRequest: () => {},
        onPermissionCancelled: () => {},
        onSessionEnded: () => {},
        onReviewCleared: () => {},
        onCommands: () => {},
        onContextUsage: () => {},
        onMcpServers: () => {},
      },
    )

    ;(session as unknown as { setTurnRunning: (r: boolean) => void }).setTurnRunning(true)
    expect(session.isTurnRunning).toBe(true)

    await session.interrupt()

    expect(session.isTurnRunning).toBe(false)
    expect(turnStateCalls).toBeGreaterThan(0)
    expect(turnStateReported).toBe(false)
  })
})
