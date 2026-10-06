/**
 * Rayucode's Web Bridge worker — Studio approvals answered for the extension's engine.
 *
 * Drives the real `VSCodeWebBridge.onPermissionRequest` with `can_use_tool` requests and
 * delivers Studio decisions through its real relay. Only the socket is absent: the
 * client's send methods are stubbed so frames can be inspected, and the engine's
 * ControlClient and the editor's PermissionRouter are recording fakes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toCallId, type BridgeDecision } from '../src/webBridge/client/index.js'
import { VSCodeWebBridge } from '../src/vscode/host/webBridge/vscodeWebBridge.js'

const savedConfigDir = process.env.RAYU_CONFIG_DIR
let configDir: string

beforeAll(() => {
  // The adapter persists a machine id under the config home; keep it out of ~/.rayu.
  configDir = mkdtempSync(join(tmpdir(), 'rayucode-bridge-'))
  process.env.RAYU_CONFIG_DIR = configDir
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

const QUESTIONS = [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]

function harness() {
  const awaiting = new Set<string>()
  const responses = new Map<string, unknown>()
  const dismissed: string[] = []
  const frames: Array<{ event: string; payload: Record<string, unknown> }> = []
  const control = {
    isAwaitingResponse: (id: string) => awaiting.has(id),
    respond: (id: string, response: unknown) => {
      awaiting.delete(id)
      responses.set(id, response)
    },
  }
  const bridge = new VSCodeWebBridge(
    { controlClient: control } as never,
    { dismiss: (id: string) => dismissed.push(id) } as never,
    '/work/app',
    () => {},
  )
  const internals = bridge as unknown as {
    client: Record<string, unknown>
    relay: { handleDecision(decision: BridgeDecision): void }
  }
  for (const event of ['toolCall', 'planRequest', 'questionRequest'] as const) {
    internals.client[event] = (payload: Record<string, unknown>) => {
      frames.push({ event, payload })
      return true
    }
  }

  return {
    frames,
    responses,
    dismissed,
    /** The editor's own card answered first, as `ControlClient.respond` would record it. */
    answerLocally(requestId: string) {
      control.respond(requestId, 'answered in the editor')
    },
    ask(requestId: string, toolName: string, input: Record<string, unknown>, extra = {}) {
      awaiting.add(requestId)
      bridge.onPermissionRequest({
        subtype: 'can_use_tool',
        requestId,
        request: { tool_name: toolName, input, ...extra },
      } as never)
    },
    decide(requestId: string, decision: Omit<BridgeDecision, 'callId'>) {
      internals.relay.handleDecision({ callId: toCallId(requestId), ...decision })
    },
  }
}

describe('VSCodeWebBridge approvals', () => {
  test('ExitPlanMode becomes a plan card; approve + auto-accept edits answers the engine', () => {
    const h = harness()
    h.ask('r-plan', 'ExitPlanMode', { plan: '1. Refactor\n2. Verify', planFilePath: '/p.md' })

    expect(h.frames).toEqual([
      { event: 'planRequest', payload: { callId: toCallId('r-plan'), plan: '1. Refactor\n2. Verify' } },
    ])

    h.decide('r-plan', {
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })

    // `{}` is mapped back to the original input by the engine's stdio permission path.
    expect(h.responses.get('r-plan')).toEqual({
      behavior: 'allow',
      updatedInput: {},
      decisionClassification: 'user_temporary',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(h.dismissed).toEqual(['r-plan'])
  })

  test('AskUserQuestion answers are rebuilt on the engine\u2019s own input', () => {
    const h = harness()
    h.ask('r-ask', 'AskUserQuestion', { questions: QUESTIONS })
    expect(h.frames[0]!.event).toBe('questionRequest')

    h.decide('r-ask', {
      behavior: 'allow',
      updatedInput: { questions: [], answers: { 'Which database?': 'SQLite' } },
    })

    expect(h.responses.get('r-ask')).toEqual({
      behavior: 'allow',
      updatedInput: { questions: QUESTIONS, answers: { 'Which database?': 'SQLite' } },
      decisionClassification: 'user_temporary',
    })
  })

  test('a Studio denial carries its reason to the engine', () => {
    const h = harness()
    h.ask('r-bash', 'Bash', { command: 'rm -rf build' }, { description: 'Clean the build' })
    expect(h.frames[0]).toMatchObject({ event: 'toolCall', payload: { toolName: 'Bash', description: 'Clean the build' } })

    h.decide('r-bash', { behavior: 'deny', message: 'wrong directory' })

    expect(h.responses.get('r-bash')).toEqual({
      behavior: 'deny',
      message: 'wrong directory',
      decisionClassification: 'user_reject',
    })
  })

  test('an answer that does not fit leaves the editor card as the only gate', () => {
    const h = harness()
    h.ask('r-bad', 'AskUserQuestion', { questions: QUESTIONS })

    h.decide('r-bad', { behavior: 'allow', updatedInput: { answers: {} } })

    expect(h.responses.has('r-bad')).toBe(false)
    expect(h.dismissed).toEqual([])
  })

  test('a request already answered in the editor is not answered again', () => {
    const h = harness()
    h.ask('r-late', 'Bash', { command: 'ls' })
    h.answerLocally('r-late')

    h.decide('r-late', { behavior: 'allow' })

    expect(h.responses.get('r-late')).toBe('answered in the editor')
    expect(h.dismissed).toEqual([])
  })
})
