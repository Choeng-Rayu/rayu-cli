/**
 * Web Bridge approvals — which Studio card a request becomes, and how the answer is
 * applied.
 *
 * Locks down the properties that are invisible until a remote user hits them: an
 * interview answered from Studio must reach the tool WITH its answers, a plan must get
 * the plan card, a remote answer is applied against the host's own input rather than
 * the browser's copy, and no remote decision can persist a rule for a form-like tool.
 */

import { describe, expect, test } from 'bun:test'
import type { BridgePermissionResponse } from '../src/bridge/bridgePermissionCallbacks.js'
import {
  WebBridgePermissionRelay,
  toCallId,
  type BridgeDecision,
  type WebBridgeClient,
} from '../src/webBridge/client/index.js'
import {
  approvalKind,
  resolveApprovalDecision,
  sendApproval,
  type WebBridgeApprovalRequest,
} from '../src/webBridge/webBridgeApprovals.js'
import { createWebBridgePermissionCallbacks } from '../src/webBridge/webBridgePermissions.js'

const QUESTIONS = [
  {
    question: 'Which database?',
    header: 'Storage',
    options: [
      { label: 'Postgres', description: 'Relational', preview: 'pg preview' },
      { label: 'SQLite' },
    ],
  },
]

function request(overrides: Partial<WebBridgeApprovalRequest> = {}): WebBridgeApprovalRequest {
  return { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' }, ...overrides }
}

const askRequest = (input: Record<string, unknown> = { questions: QUESTIONS }) =>
  request({ toolName: 'AskUserQuestion', input })

const planRequest = (plan: unknown = '1. Add the route\n2. Test it') =>
  request({ toolName: 'ExitPlanMode', input: { plan, planFilePath: '/tmp/plan.md' } })

const allow = (extra: Partial<BridgeDecision> = {}): BridgeDecision => ({
  callId: 'req-1',
  behavior: 'allow',
  ...extra,
})

/** A client double that records the frames the relay asks it to send. */
function recordingClient(connected = true) {
  const frames: Array<{ event: string; payload: Record<string, unknown> }> = []
  const send = (event: string) => (payload: Record<string, unknown>) => {
    if (connected) frames.push({ event, payload })
    return connected
  }
  const client = {
    toolCall: send('tool_call'),
    planRequest: send('plan_request'),
    questionRequest: send('question_request'),
    cancelRequest: (callId: string) => {
      frames.push({ event: 'cancel_request', payload: { callId } })
    },
  }
  return { frames, client: client as unknown as WebBridgeClient }
}

describe('approvalKind', () => {
  test('an interview with questions gets the question card', () => {
    expect(approvalKind(askRequest())).toBe('question')
  })

  test('a plan with text gets the plan card', () => {
    expect(approvalKind(planRequest())).toBe('plan')
  })

  test('a form with nothing to show falls back to the generic card', () => {
    // Still answerable rather than hanging — the Telegram bridge's fallback too.
    expect(approvalKind(askRequest({ questions: [] }))).toBe('tool')
    expect(approvalKind(planRequest('   '))).toBe('tool')
    // No plan file yet: normalizeToolInput injects nothing.
    expect(approvalKind(request({ toolName: 'ExitPlanMode', input: {} }))).toBe('tool')
  })

  test('every other tool gets the generic card', () => {
    expect(approvalKind(request())).toBe('tool')
  })
})

describe('sendApproval', () => {
  test('sends an interview as question_request with the host input', () => {
    const { frames, client } = recordingClient()
    const relay = new WebBridgePermissionRelay(client)

    expect(sendApproval(relay, 'question', askRequest())).toBe(true)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.event).toBe('question_request')
    expect(frames[0]!.payload).toMatchObject({
      callId: toCallId('req-1'),
      questions: [{ question: 'Which database?', header: 'Storage' }],
      toolInput: { questions: QUESTIONS },
    })
  })

  test('sends a plan as plan_request carrying the plan text', () => {
    const { frames, client } = recordingClient()
    sendApproval(new WebBridgePermissionRelay(client), 'plan', planRequest())
    expect(frames[0]).toEqual({
      event: 'plan_request',
      payload: { callId: toCallId('req-1'), plan: '1. Add the route\n2. Test it' },
    })
  })

  test('never proposes a rule to remember for a form-like tool', () => {
    const { frames, client } = recordingClient()
    const relay = new WebBridgePermissionRelay(client)
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'x' }] }]

    sendApproval(relay, 'tool', request({ requestId: 'a', permissionSuggestions: suggestions }))
    sendApproval(
      relay,
      'tool',
      request({ requestId: 'b', toolName: 'ReviewArtifact', permissionSuggestions: suggestions }),
    )

    expect(frames[0]!.payload.permissionSuggestions).toEqual(suggestions)
    expect(frames[1]!.payload).not.toHaveProperty('permissionSuggestions')
  })

  test('reports false when the frame could not be sent', () => {
    const { client } = recordingClient(false)
    expect(sendApproval(new WebBridgePermissionRelay(client), 'tool', request())).toBe(false)
  })
})

describe('resolveApprovalDecision', () => {
  test('a denial keeps its reason, for every card', () => {
    for (const kind of ['tool', 'plan', 'question'] as const) {
      expect(
        resolveApprovalDecision(kind, request(), {
          callId: 'req-1',
          behavior: 'deny',
          message: 'wrong directory',
        }),
      ).toEqual({ behavior: 'deny', message: 'wrong directory' })
    }
  })

  test('interview answers are merged onto the HOST input, not the browser copy', () => {
    const response = resolveApprovalDecision('question', askRequest(), allow({
      updatedInput: {
        // What the backend merged onto its clamped copy — including a tampered list.
        questions: [{ question: 'Injected?', options: [] }],
        answers: { 'Which database?': 'Postgres' },
      },
    }))

    expect(response).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: QUESTIONS,
        answers: { 'Which database?': 'Postgres' },
        // Derived from the host's own option, never trusted from the frame.
        annotations: { 'Which database?': { preview: 'pg preview' } },
      },
    })
  })

  test('free-text notes from Studio become annotations', () => {
    const response = resolveApprovalDecision('question', askRequest(), allow({
      updatedInput: {
        answers: { 'Which database?': 'SQLite' },
        annotations: { 'Which database?': 'only for tests' },
      },
    }))
    expect(response?.updatedInput?.annotations).toEqual({
      'Which database?': { notes: 'only for tests' },
    })
  })

  test('answers that do not fit the questions are not applied', () => {
    // Null, not an empty allow: the local prompt stays the authoritative gate.
    expect(resolveApprovalDecision('question', askRequest(), allow())).toBeNull()
    expect(
      resolveApprovalDecision('question', askRequest(), allow({
        updatedInput: { answers: { 'Some other question': 'x' } },
      })),
    ).toBeNull()
  })

  test('a plain plan approval is the terminal\u2019s unedited approval and changes no mode', () => {
    // `{}` makes the tool read the plan from disk, exactly as the terminal dialog does.
    expect(resolveApprovalDecision('plan', planRequest(), allow())).toEqual({
      behavior: 'allow',
      updatedInput: {},
    })
  })

  test('approve + auto-accept edits becomes exactly the session acceptEdits mode', () => {
    const response = resolveApprovalDecision('plan', planRequest(), allow({
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    }))
    expect(response?.updatedPermissions).toEqual([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ])
  })

  test('a plan decision cannot smuggle in any other permission change, or a rewritten plan', () => {
    const response = resolveApprovalDecision('plan', planRequest(), allow({
      updatedInput: { plan: 'a plan nobody was shown' },
      updatedPermissions: [
        { type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' },
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' },
      ],
    }))
    expect(response).toEqual({ behavior: 'allow', updatedInput: {} })
  })

  test('"Don\u2019t ask again" applies the single-tool rule the backend derives when the CLI offered none', () => {
    // Keys in a different order than offeredRules builds them: comparison is by content.
    const derived = { destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Bash' }], type: 'addRules' }
    expect(
      resolveApprovalDecision('tool', request(), allow({ updatedPermissions: [derived] })),
    ).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [derived] })
  })

  test('"Don\u2019t ask again" applies the CLI\u2019s own suggestion, echoed back', () => {
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }], behavior: 'allow', destination: 'localSettings' }
    const response = resolveApprovalDecision(
      'tool',
      request({ permissionSuggestions: [suggestion] }),
      allow({ updatedPermissions: [suggestion] }),
    )
    expect(response?.updatedPermissions).toEqual([suggestion])
  })

  test('rules nobody was shown are dropped', () => {
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }], behavior: 'allow', destination: 'localSettings' }
    const unoffered = [
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
      { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
    ]
    expect(resolveApprovalDecision('tool', request(), allow({ updatedPermissions: unoffered })))
      .toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })

    // When the CLI offered a narrow rule, the blanket single-tool rule is not offered.
    const blanket = { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }
    expect(
      resolveApprovalDecision(
        'tool',
        request({ permissionSuggestions: [suggestion] }),
        allow({ updatedPermissions: [blanket, suggestion] }),
      )?.updatedPermissions,
    ).toEqual([suggestion])
  })

  test('a remembered grant is dropped for a form-like tool on the generic card', () => {
    const rules = [{ type: 'addRules', rules: [{ toolName: 'AskUserQuestion' }], behavior: 'allow', destination: 'localSettings' }]
    const response = resolveApprovalDecision(
      'tool',
      askRequest({ questions: [] }),
      allow({ updatedPermissions: rules }),
    )
    expect(response).not.toHaveProperty('updatedPermissions')
  })
})

describe('CLI permission callbacks over the relay', () => {
  function harness() {
    const { frames, client } = recordingClient()
    const relay = new WebBridgePermissionRelay(client)
    const callbacks = createWebBridgePermissionCallbacks(relay)
    const responses: BridgePermissionResponse[] = []
    return { frames, relay, callbacks, responses }
  }

  test('an AskUserQuestion answered in Studio reaches the tool with its answers', () => {
    const { frames, relay, callbacks, responses } = harness()
    callbacks.sendRequest('req-ask', 'AskUserQuestion', { questions: QUESTIONS }, 'tu-1', '')
    callbacks.onResponse('req-ask', r => responses.push(r))

    // The bug this replaces: the request used to leave as a generic tool_call.
    expect(frames[0]!.event).toBe('question_request')

    relay.handleDecision({
      callId: toCallId('req-ask'),
      behavior: 'allow',
      updatedInput: { answers: { 'Which database?': 'SQLite' } },
    })

    expect(responses).toEqual([
      {
        behavior: 'allow',
        updatedInput: { questions: QUESTIONS, answers: { 'Which database?': 'SQLite' } },
      },
    ])
  })

  test('an ExitPlanMode request reaches Studio as a plan card', () => {
    const { frames, relay, callbacks, responses } = harness()
    const input = { plan: '1. Ship it' }
    callbacks.sendRequest('req-plan', 'ExitPlanMode', input, 'tu-2', 'Exit plan mode?')
    callbacks.onResponse('req-plan', r => responses.push(r))

    expect(frames[0]).toEqual({
      event: 'plan_request',
      payload: { callId: toCallId('req-plan'), plan: '1. Ship it' },
    })

    relay.handleDecision({
      callId: toCallId('req-plan'),
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(responses).toEqual([
      {
        behavior: 'allow',
        updatedInput: {},
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    ])
  })

  test('an ordinary tool keeps the generic card and the remembered rule', () => {
    const { frames, relay, callbacks, responses } = harness()
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }], behavior: 'allow', destination: 'localSettings' }
    callbacks.sendRequest('req-bash', 'Bash', { command: 'git status' }, 'tu-3', 'Check the tree', [suggestion] as never)
    callbacks.onResponse('req-bash', r => responses.push(r))

    expect(frames[0]!.event).toBe('tool_call')
    expect(frames[0]!.payload).toMatchObject({ toolName: 'Bash', description: 'Check the tree' })

    relay.handleDecision({ callId: toCallId('req-bash'), behavior: 'allow', updatedPermissions: [suggestion] })
    expect(responses).toEqual([
      { behavior: 'allow', updatedInput: { command: 'git status' }, updatedPermissions: [suggestion] as never },
    ])
  })

  test('a local win dismisses the Studio card and a late answer is ignored', () => {
    const { frames, relay, callbacks, responses } = harness()
    callbacks.sendRequest('req-local', 'Bash', { command: 'ls' }, 'tu-4', '')
    callbacks.onResponse('req-local', r => responses.push(r))

    callbacks.cancelRequest('req-local')
    expect(frames.at(-1)).toEqual({
      event: 'cancel_request',
      payload: { callId: toCallId('req-local') },
    })

    relay.handleDecision({ callId: toCallId('req-local'), behavior: 'allow' })
    expect(responses).toEqual([])
  })

  test('an unusable interview answer resolves nothing', () => {
    const { relay, callbacks, responses } = harness()
    callbacks.sendRequest('req-bad', 'AskUserQuestion', { questions: QUESTIONS }, 'tu-5', '')
    callbacks.onResponse('req-bad', r => responses.push(r))

    relay.handleDecision({ callId: toCallId('req-bad'), behavior: 'allow', updatedInput: {} })
    expect(responses).toEqual([])
  })

  test('an aborted request withdraws its Studio card', () => {
    // Only the head of the terminal's queue is cancelled explicitly on Esc; the rest are
    // just unsubscribed, which must still take their cards down.
    const { frames, relay, callbacks, responses } = harness()
    callbacks.sendRequest('req-queued', 'Bash', { command: 'ls' }, 'tu-6', '')
    const unsubscribe = callbacks.onResponse('req-queued', r => responses.push(r))

    unsubscribe()
    expect(frames.at(-1)).toEqual({
      event: 'cancel_request',
      payload: { callId: toCallId('req-queued') },
    })

    relay.handleDecision({ callId: toCallId('req-queued'), behavior: 'allow' })
    expect(responses).toEqual([])
  })

  test('unsubscribing after the answer withdraws nothing', () => {
    const { frames, relay, callbacks, responses } = harness()
    callbacks.sendRequest('req-done', 'Bash', { command: 'ls' }, 'tu-7', '')
    const unsubscribe = callbacks.onResponse('req-done', r => {
      unsubscribe()
      responses.push(r)
    })

    relay.handleDecision({ callId: toCallId('req-done'), behavior: 'allow' })
    expect(responses).toHaveLength(1)
    expect(frames.some(f => f.event === 'cancel_request')).toBe(false)
  })
})
