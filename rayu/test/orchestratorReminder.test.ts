import { describe, expect, test } from 'bun:test'
import normalCommand from '../src/commands/normal/index.ts'
import { isNonInteractiveCommand } from '../src/commands.ts'
import { ORCHESTRATOR_FULL_REMINDER_EVERY } from '../src/constants/orchestrator.ts'
import {
  decideOrchestratorReminder,
  needsOrchestratorExitNotice,
  ORCHESTRATOR_REMINDER_HEADING,
  renderOrchestratorExit,
  renderOrchestratorReminder,
} from '../src/orchestrator/reminder.ts'
import { createOrchestratorModeAttachmentIfNeeded } from '../src/services/compact/compact.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { Message } from '../src/types/message.ts'

const reminder = (reminderType?: 'full' | 'sparse') =>
  ({ type: 'attachment', attachment: { type: 'orchestrator_mode', ...(reminderType && { reminderType }) } }) as unknown as Message
const exitNotice = { type: 'attachment', attachment: { type: 'orchestrator_mode_exit' } } as unknown as Message
const boundary = { type: 'system', subtype: 'compact_boundary' } as unknown as Message
const userTurn = { type: 'user', message: { content: 'hi' } } as unknown as Message

const decide = (messages: Message[], input: string | null = 'next prompt', extra: Partial<Parameters<typeof decideOrchestratorReminder>[0]> = {}) =>
  decideOrchestratorReminder({ isSubagent: false, mode: 'orchestrator', input, messages, ...extra })

describe('when the Orchestrator reminder attaches', () => {
  test('never for a subagent or outside Orchestrator mode', () => {
    expect(decide([], 'x', { isSubagent: true })).toBeNull()
    expect(decide([], 'x', { mode: 'fullManage' })).toBeNull()
  })

  test('in full on the first turn, whatever the turn', () => {
    expect(decide([])).toBe('full')
    expect(decide([], null)).toBe('full')
  })

  test('short at the start of later turns, and not during tool rounds', () => {
    const history = [userTurn, reminder('full')]
    expect(decide(history)).toBe('sparse')
    expect(decide(history, null)).toBeNull()
    expect(decide([...history, userTurn, reminder('sparse')])).toBe('sparse')
  })

  test('in full again on entry: after an exit notice, even mid-turn', () => {
    expect(decide([reminder('full'), exitNotice], null)).toBe('full')
    expect(decide([reminder('full'), exitNotice, userTurn])).toBe('full')
  })

  test('in full after compaction: markers before the boundary no longer count', () => {
    expect(decide([reminder('full'), userTurn, boundary])).toBe('full')
    expect(decide([reminder('full'), boundary], null)).toBe('full')
  })

  test('a reminder recorded without a kind counts as a full one', () => {
    expect(decide([reminder()])).toBe('sparse')
  })

  test(`every ${ORCHESTRATOR_FULL_REMINDER_EVERY}th reminder is a full one`, () => {
    const history: Message[] = [reminder('full')]
    for (let i = 0; i < ORCHESTRATOR_FULL_REMINDER_EVERY - 2; i++) history.push(userTurn, reminder('sparse'))
    expect(decide(history)).toBe('sparse')
    history.push(userTurn, reminder('sparse'))
    expect(decide(history)).toBe('full')
  })
})

describe('the exit notice', () => {
  const exits = (messages: Message[], mode = 'default', isSubagent = false) =>
    needsOrchestratorExitNotice({ isSubagent, mode, messages })

  test('is due once the mode is left after a reminder', () => {
    expect(exits([reminder('full')])).toBe(true)
    expect(exits([reminder('full'), userTurn, reminder('sparse')], 'acceptEdits')).toBe(true)
  })

  test('is not repeated, and is never due without a reminder, in the mode, or for a subagent', () => {
    expect(exits([reminder('full'), exitNotice])).toBe(false)
    expect(exits([])).toBe(false)
    expect(exits([reminder('full')], 'orchestrator')).toBe(false)
    expect(exits([reminder('full')], 'default', true)).toBe(false)
    expect(exits([reminder('full'), boundary])).toBe(false)
  })
})

describe('the reminder text', () => {
  test('the full reminder carries the delegation rules', () => {
    const text = renderOrchestratorReminder({ reminderType: 'full', availableAgents: ['general-purpose', 'planner', 'Explore'] })
    expect(text.startsWith(ORCHESTRATOR_REMINDER_HEADING)).toBe(true)
    expect(text).toContain('You are the ORCHESTRATOR')
    expect(text).toMatch(/Do not edit or write project files/)
    expect(text).toContain('`general-purpose`')
    expect(text).toContain('run_in_background: true')
    expect(text).toMatch(/never overlapping with another worker/)
    expect(text).toContain('`planner`')
    expect(text).toContain('`Explore`')
    expect(text).toContain('/normal')
  })

  test('names only the agents and tools this session has', () => {
    const bare = renderOrchestratorReminder({ reminderType: 'full', availableAgents: ['general-purpose'], canMessageWorkers: false })
    expect(bare).not.toContain('`planner`')
    expect(bare).not.toContain('`Explore`')
    expect(bare).not.toContain('SendMessage')
    expect(bare).toContain('Research the code yourself with read-only tools')
    expect(bare).toContain('to a new worker for the owning packet')

    const messaging = renderOrchestratorReminder({ reminderType: 'full', availableAgents: ['planner'], canMessageWorkers: true })
    expect(messaging).toContain('SendMessage')
    expect(messaging).toContain('back to the worker that owns the files')
    expect(messaging).not.toContain('`Explore`')
  })

  test('the short reminder keeps the core rule; an old attachment renders in full', () => {
    const sparse = renderOrchestratorReminder({ reminderType: 'sparse' })
    expect(sparse).toMatch(/still ON/)
    expect(sparse).toMatch(/do not edit files/)
    expect(sparse.length).toBeLessThan(300)
    expect(renderOrchestratorReminder({})).toContain(ORCHESTRATOR_REMINDER_HEADING)
  })

  test('the exit notice says the rules stop applying', () => {
    expect(renderOrchestratorExit()).toMatch(/no longer apply/)
  })
})

describe('compaction keeps the role', () => {
  const context = (mode: string, agentId?: string) => {
    const state = getDefaultAppState()
    return {
      agentId,
      getAppState: () => ({ ...state, toolPermissionContext: { ...state.toolPermissionContext, mode } }),
      options: { agentDefinitions: { activeAgents: [{ agentType: 'planner' }] }, tools: [] },
    } as never
  }

  test('re-attaches the full reminder for the main thread in Orchestrator mode only', () => {
    const attachment = createOrchestratorModeAttachmentIfNeeded(context('orchestrator'))
    expect(attachment?.attachment).toMatchObject({ type: 'orchestrator_mode', reminderType: 'full', availableAgents: ['planner'], canMessageWorkers: false })
    expect(createOrchestratorModeAttachmentIfNeeded(context('default'))).toBeNull()
    expect(createOrchestratorModeAttachmentIfNeeded(context('orchestrator', 'agent-1'))).toBeNull()
  })
})

test('/normal can run headless, so Rayucode can leave Orchestrator mode', () => {
  expect(isNonInteractiveCommand(normalCommand)).toBe(true)
})
