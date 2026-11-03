/**
 * Task 4: what the Orchestrator is told matches the tools it has.
 *
 * Without agent teams the full SendMessage tool is disabled, yet Orchestrator mode is
 * told to continue workers with it. The main thread now gets a worker-only variant
 * (OrchestratorSendMessageTool), workers never do, and the Agent tool only mentions
 * SendMessage where the caller has it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getDefaultAppState, type AppState } from '../src/state/AppStateStore.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { getTools } from '../src/tools.ts'
import { AgentTool } from '../src/tools/AgentTool/AgentTool.tsx'
import { getPrompt } from '../src/tools/AgentTool/prompt.ts'
import {
  orchestratorRecipientProblem,
  OrchestratorSendMessageTool,
} from '../src/tools/SendMessageTool/OrchestratorSendMessageTool.ts'
import type { AgentId } from '../src/types/ids.ts'
import { createAgentId } from '../src/utils/uuid.ts'

const savedTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

beforeAll(() => {
  // Agent teams off: the configuration in which the full SendMessage is disabled.
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
})

afterAll(() => {
  if (savedTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = savedTeams
})

const workerId = createAgentId()
const mainId = createAgentId()
const shellId = createAgentId()

function stateWith(status: string = 'running'): AppState {
  const base = getDefaultAppState()
  return {
    ...base,
    agentNameRegistry: new Map<string, AgentId>([
      ['api', workerId],
      ['main', mainId],
      ['shell', shellId],
    ]),
    tasks: {
      [workerId]: { id: workerId, type: 'local_agent', status, description: 'api packet', pendingMessages: [] },
      [mainId]: { id: mainId, type: 'local_agent', agentType: 'main-session', status: 'running', pendingMessages: [] },
      [shellId]: { id: shellId, type: 'local_bash', status: 'running' },
    } as unknown as AppState['tasks'],
  }
}

describe('who the Orchestrator can message', () => {
  const problem = (to: string) => orchestratorRecipientProblem(to, stateWith())

  test('its own workers, by name or agent ID', () => {
    expect(problem('api')).toBeNull()
    expect(problem(workerId)).toBeNull()
    // Not in state any more: delivery resumes it from its transcript.
    expect(problem(createAgentId())).toBeNull()
  })

  test('nothing else', () => {
    expect(problem('')).toMatch(/must name one of your workers/)
    expect(problem('*')).toMatch(/Broadcast is not available/)
    for (const address of ['uds:/tmp/peer.sock', 'bridge:session_01', '/tmp/peer.sock']) {
      expect(problem(address)).toMatch(/other sessions are not reachable/)
    }
    expect(problem('nobody')).toMatch(/No worker is named "nobody"/)
    expect(problem('main')).toMatch(/not one of your background workers/)
    expect(problem('shell')).toMatch(/not one of your background workers/)
  })
})

describe('the Orchestrator SendMessage call', () => {
  type Call = (input: Record<string, unknown>, context: unknown, canUseTool: unknown, message: unknown) => Promise<{ data: { success: boolean; message: string } }>
  const call = OrchestratorSendMessageTool.call.bind(OrchestratorSendMessageTool) as unknown as Call

  function context(initial: AppState) {
    let state = initial
    return {
      get state() {
        return state
      },
      getAppState: () => state,
      setAppState: (update: (previous: AppState) => AppState) => {
        state = update(state)
      },
    }
  }

  test('queues a message for a running worker', async () => {
    const ctx = context(stateWith('running'))
    const { data } = await call({ to: 'api', summary: 'fix', message: 'Use displayName.' }, ctx, async () => ({}), undefined)
    expect(data).toEqual({ success: true, message: 'Message queued for delivery to api at its next tool round.' })
    expect((ctx.state.tasks[workerId] as unknown as { pendingMessages: string[] }).pendingMessages).toEqual(['Use displayName.'])
  })

  test('refuses what validation would refuse, without touching state', async () => {
    const ctx = context(stateWith('running'))
    const { data } = await call({ to: '*', message: 'everyone' }, ctx, async () => ({}), undefined)
    expect(data.success).toBe(false)
    expect(data.message).toMatch(/Broadcast is not available/)
    expect((ctx.state.tasks[workerId] as unknown as { pendingMessages: string[] }).pendingMessages).toEqual([])
  })

  test('is never deferred and only carries plain text', () => {
    expect(OrchestratorSendMessageTool.shouldDefer).toBe(false)
    const schema = OrchestratorSendMessageTool.inputSchema
    expect(schema.safeParse({ to: 'api', message: 'hi' }).success).toBe(true)
    expect(schema.safeParse({ to: 'api', message: { type: 'shutdown_request' } }).success).toBe(false)
  })
})

describe('which tool pools carry SendMessage', () => {
  const pool = (mode: string, extra: Record<string, unknown> = {}) =>
    getTools({ ...getEmptyToolPermissionContext(), mode, ...extra } as never)
  const sendMessage = (tools: ReturnType<typeof pool>) => tools.find(tool => tool.name === 'SendMessage')

  test('the Orchestrator main thread gets the worker-only variant', () => {
    // Compared by a property unique to the variant: tools.ts loads it with require().
    expect(sendMessage(pool('orchestrator'))?.searchHint).toBe(OrchestratorSendMessageTool.searchHint)
  })

  test('other modes, and so every worker pool, do not', () => {
    // AgentTool builds worker pools under the worker's own mode (acceptEdits by default).
    for (const mode of ['default', 'acceptEdits', 'plan', 'fullManage']) {
      expect(sendMessage(pool(mode))).toBeUndefined()
    }
  })

  test('a blanket deny rule still removes it', () => {
    const denied = pool('orchestrator', { alwaysDenyRules: { session: ['SendMessage'] } })
    expect(sendMessage(denied)).toBeUndefined()
  })
})

describe('the Agent tool mentions SendMessage only where it exists', () => {
  const asyncResult = (canSendMessage?: boolean) =>
    String(
      (AgentTool.mapToolResultToToolResultBlockParam(
        {
          status: 'async_launched',
          agentId: 'a1',
          description: 'api packet',
          prompt: 'p',
          outputFile: '/tmp/a1.output',
          canReadOutputFile: false,
          ...(canSendMessage !== undefined && { canSendMessage }),
        } as never,
        'toolu_1',
      ).content as Array<{ text: string }>)[0]!.text,
    )

  test('async launch result', () => {
    expect(asyncResult(false)).toContain('agentId: a1 (internal ID - do not mention to user.)')
    expect(asyncResult(false)).not.toContain('SendMessage')
    expect(asyncResult(true)).toContain("Use SendMessage with to: 'a1' to continue this agent.")
    // Recorded before the flag existed: unchanged text.
    expect(asyncResult()).toBe(asyncResult(true))
  })

  test('completed result trailer', () => {
    const trailer = (canSendMessage: boolean) => {
      const block = AgentTool.mapToolResultToToolResultBlockParam(
        {
          status: 'completed',
          prompt: 'p',
          agentId: 'a1',
          agentType: 'planner',
          content: [{ type: 'text', text: 'The plan.' }],
          totalToolUseCount: 1,
          totalDurationMs: 10,
          totalTokens: 100,
          canSendMessage,
        } as never,
        'toolu_2',
      )
      const parts = block.content as Array<{ text: string }>
      return parts[parts.length - 1]!.text
    }
    expect(trailer(false)).toMatch(/^agentId: a1\n<usage>/)
    expect(trailer(true)).toContain("agentId: a1 (use SendMessage with to: 'a1' to continue this agent)")
  })

  test('the tool prompt is conditional, so it stays true in every mode', async () => {
    const prompt = await getPrompt([], false)
    expect(prompt).toContain('If the SendMessage tool is available, use it to continue a previously spawned agent')
  })
})
