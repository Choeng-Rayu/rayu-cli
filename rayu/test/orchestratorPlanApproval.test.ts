/**
 * Task 3: a plan approval names the mode it leaves the session in, the CLI dialog offers
 * Orchestrator as an explicit choice, and a mode change that takes auto-approval away
 * from running background workers is announced instead of silently denying their tools.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  needsPlanModeExitAttachment,
  setHasExitedPlanMode,
  setNeedsPlanModeExitAttachment,
} from '../src/bootstrap/state.js'
import {
  buildPermissionUpdates,
  buildPlanApprovalOptions,
  buildPromptRuleUpdates,
  canOfferOrchestrate,
} from '../src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx'
import { ORCHESTRATOR_PAID_FEATURE } from '../src/constants/orchestrator.ts'
import {
  describeWorkerApprovalLoss,
  formatWorkerApprovalLoss,
  type WorkerApprovalLoss,
} from '../src/orchestrator/modeChange.ts'
import {
  _resetRayuEntitlementsForTesting,
  _setRayuEntitlementsForTesting,
} from '../src/services/rayuAuth/rayuEntitlements.ts'
import { type AppState, getDefaultAppState } from '../src/state/AppStateStore.ts'
import { onChangeAppState } from '../src/state/onChangeAppState.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.js'
import { ExitPlanModeV2Tool } from '../src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { PermissionMode } from '../src/types/permissions.ts'
import { normalizeAttachmentForAPI } from '../src/utils/messages.ts'
import { getPlanFilePath, getPlansDirectory } from '../src/utils/plans.js'
import { subscribeWorkerApprovalLoss } from '../src/utils/sessionState.ts'

const savedEnv = { config: process.env.RAYU_CONFIG_DIR, oauth: process.env.USE_RAYU_OAUTH }
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'rayu-plan-approval-'))
  process.env.RAYU_CONFIG_DIR = configDir
  delete process.env.USE_RAYU_OAUTH
  getPlansDirectory.cache.clear?.()
})

afterEach(() => {
  setHasExitedPlanMode(false)
  setNeedsPlanModeExitAttachment(false)
  delete process.env.USE_RAYU_OAUTH
  _resetRayuEntitlementsForTesting()
})

afterAll(() => {
  for (const [key, value] of [['RAYU_CONFIG_DIR', savedEnv.config], ['USE_RAYU_OAUTH', savedEnv.oauth]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  getPlansDirectory.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

// ── The CLI dialog ───────────────────────────────────────────────────────────

describe('the CLI plan approval dialog', () => {
  const values = (extra: Partial<Parameters<typeof buildPlanApprovalOptions>[0]> = {}) =>
    buildPlanApprovalOptions({
      showClearContext: false,
      showUltraplan: false,
      usedPercent: null,
      isAutoModeAvailable: false,
      isBypassPermissionsModeAvailable: false,
      onFeedbackChange: () => {},
      ...extra,
    }).map(option => option.value)

  test('offers Orchestrator as the first keep-context choice, so it is the default without clear-context', () => {
    expect(values({ showOrchestrate: true })).toEqual([
      'yes-orchestrate',
      'yes-accept-edits-keep-context',
      'yes-default-keep-context',
      'no',
    ])
    expect(values({ showOrchestrate: true, showClearContext: true, usedPercent: 40 })).toEqual([
      'yes-accept-edits',
      'yes-orchestrate',
      'yes-accept-edits-keep-context',
      'yes-default-keep-context',
      'no',
    ])
  })

  test('does not offer Orchestrator unless asked to', () => {
    expect(values()).not.toContain('yes-orchestrate')
  })

  test('Orchestrator needs the main agent and the Agent tool', () => {
    expect(canOfferOrchestrate({ isWorker: false, tools: [{ name: 'Read' }, { name: 'Agent' }] })).toBe(true)
    expect(canOfferOrchestrate({ isWorker: true, tools: [{ name: 'Agent' }] })).toBe(false)
    expect(canOfferOrchestrate({ isWorker: false, tools: [{ name: 'Read' }] })).toBe(false)
    expect(canOfferOrchestrate({ isWorker: false, tools: undefined })).toBe(false)
  })

  test('Orchestrator is not offered on a plan without the entitlement', () => {
    process.env.USE_RAYU_OAUTH = 'true'
    _setRayuEntitlementsForTesting({
      plan: { code: 'free', name: 'Free', priceCents: 0, availability: 'active' },
      maxDailyTurns: null,
      features: { [ORCHESTRATOR_PAID_FEATURE]: { enabled: false } },
    } as never)
    expect(canOfferOrchestrate({ isWorker: false, tools: [{ name: 'Agent' }] })).toBe(false)
  })

  test('"orchestrate" sends no mode change; the other choices still set theirs', () => {
    // The tool performs the plan→Orchestrator switch itself; a setMode cannot carry the
    // internal mode (it would be externalized to bypassPermissions).
    expect(buildPromptRuleUpdates(undefined)).toEqual([])
    expect(buildPromptRuleUpdates([{ tool: 'Bash', prompt: 'run tests' }])).toEqual([])
    expect(buildPermissionUpdates('acceptEdits')).toEqual([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ])
  })
})

// ── What the ExitPlanMode tool reports ──────────────────────────────────────

type ToolCall = (input: Record<string, unknown>, context: unknown) => Promise<{ data: Record<string, unknown> }>

async function approve(modeAfterApproval: PermissionMode | null, input: Record<string, unknown> = {}) {
  writeFileSync(getPlanFilePath(), '1. Ship it')
  // `null`: the approval changed nothing (CLI "orchestrate", Rayucode's orchestrate
  // button); otherwise the mode an approval's setMode already applied.
  let state = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: modeAfterApproval ?? 'plan' },
  }
  const call = ExitPlanModeV2Tool.call.bind(ExitPlanModeV2Tool) as unknown as ToolCall
  const { data } = await call(input, {
    agentId: undefined,
    options: { tools: [] },
    getAppState: () => state,
    setAppState: (update: (previous: typeof state) => typeof state) => {
      state = update(state)
    },
  })
  const block = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(data as never, 'toolu_plan')
  return { mode: state.toolPermissionContext.mode, data, text: String(block.content) }
}

describe('the ExitPlanMode result names the mode actually in effect', () => {
  test('an approval that changed nothing enters Orchestrator mode', async () => {
    const result = await approve(null)
    expect(result.mode).toBe('orchestrator')
    expect(result.data.resultingMode).toBe('orchestrator')
    expect(result.text).toContain('Orchestrator mode is now active')
    expect(needsPlanModeExitAttachment()).toBe(true)
  })

  test('an approval that set Accept edits keeps it, says so, and still announces the plan exit', async () => {
    const result = await approve('acceptEdits')
    expect(result.mode).toBe('acceptEdits')
    expect(result.text).toContain('The permission mode is now Accept edits.')
    expect(result.text).not.toContain('Orchestrator')
    expect(result.text).toContain('1. Ship it')
    expect(needsPlanModeExitAttachment()).toBe(true)
  })

  test('an approval that set Default says so', async () => {
    const result = await approve('default')
    expect(result.text).toContain('The permission mode is now Default.')
    expect(result.text).not.toContain('Orchestrator')
  })

  test('a result recorded before resultingMode existed still reads as Orchestrator', () => {
    const block = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(
      { plan: '1. Ship it', isAgent: false, filePath: '/p.md' } as never,
      'toolu_old',
    )
    expect(String(block.content)).toContain('Orchestrator mode is now active')
  })

  test('the plan is only labelled as edited when the approval carried an edit', async () => {
    // What Rayucode now sends: the input without the injected plan text.
    const unedited = await approve(null, { planFilePath: getPlanFilePath() })
    expect(unedited.text).toContain('## Approved Plan:')
    expect(unedited.text).not.toContain('edited by user')

    const edited = await approve(null, { plan: '1. Ship it\n2. Then test it' })
    expect(edited.text).toContain('## Approved Plan (edited by user):')
  })
})

describe('the plan-exit notice the model sees next', () => {
  const text = (mode?: PermissionMode) =>
    JSON.stringify(
      normalizeAttachmentForAPI({ type: 'plan_mode_exit', planFilePath: '/p.md', planExists: true, ...(mode && { mode }) } as never),
    )

  test('claims Orchestrator only when the approval entered it', () => {
    expect(text('orchestrator')).toContain('Orchestrator Active')
    for (const mode of ['acceptEdits', 'default', undefined] as const) {
      expect(text(mode)).toContain('You have exited plan mode')
      expect(text(mode)).not.toContain('Orchestrator')
    }
  })
})

// ── Mode changes while workers run ──────────────────────────────────────────

function stateWith(mode: PermissionMode, tasks: Record<string, unknown> = {}): AppState {
  const base = getDefaultAppState()
  return {
    ...base,
    toolPermissionContext: { ...base.toolPermissionContext, mode },
    tasks: tasks as AppState['tasks'],
  }
}

const worker = (id: string, extra: Record<string, unknown> = {}) => ({
  [id]: { id, type: 'local_agent', status: 'running', description: `${id} packet`, ...extra },
})

describe('losing auto-approval while background workers run', () => {
  const running = { ...worker('types'), ...worker('api') }

  test('is detected when leaving an auto-approving mode for a prompting one', () => {
    const loss = describeWorkerApprovalLoss(stateWith('orchestrator'), stateWith('default', running))
    expect(loss).toEqual({
      fromMode: 'orchestrator',
      toMode: 'default',
      workers: [
        { taskId: 'types', description: 'types packet' },
        { taskId: 'api', description: 'api packet' },
      ],
    })
    expect(describeWorkerApprovalLoss(stateWith('fullManage'), stateWith('acceptEdits', running))?.toMode).toBe('acceptEdits')
  })

  test('is not reported when approval is kept, was never automatic, or nothing is running', () => {
    expect(describeWorkerApprovalLoss(stateWith('orchestrator'), stateWith('fullManage', running))).toBeNull()
    expect(describeWorkerApprovalLoss(stateWith('default'), stateWith('acceptEdits', running))).toBeNull()
    expect(describeWorkerApprovalLoss(stateWith('orchestrator'), stateWith('default'))).toBeNull()
    const notBackground = { ...worker('done', { status: 'completed' }), ...worker('fg', { isBackgrounded: false }) }
    expect(describeWorkerApprovalLoss(stateWith('orchestrator'), stateWith('default', notBackground))).toBeNull()
  })

  test('is worded with the workers and both modes', () => {
    const loss: WorkerApprovalLoss = {
      fromMode: 'orchestrator',
      toMode: 'default',
      workers: [{ taskId: 'types', description: 'types packet' }],
    }
    expect(formatWorkerApprovalLoss(loss)).toBe(
      '1 background worker is still running (types packet). Now that the mode is Default, workers cannot ask for approval, so their edits and commands that need approval will be denied. Switch back to Orchestrator Mode to let them finish.',
    )
  })

  test('reaches subscribers from the app-state choke point, and a failing one cannot break the state update', () => {
    const seen: WorkerApprovalLoss[] = []
    const unsubscribeThrowing = subscribeWorkerApprovalLoss(() => {
      throw new Error('display failed')
    })
    const unsubscribe = subscribeWorkerApprovalLoss(loss => seen.push(loss))
    const oldState = stateWith('orchestrator', running)
    const newState = { ...oldState, toolPermissionContext: { ...oldState.toolPermissionContext, mode: 'default' as const } }

    expect(() => onChangeAppState({ oldState, newState })).not.toThrow()
    unsubscribeThrowing()
    onChangeAppState({ oldState, newState })
    expect(seen.map(loss => loss.toMode)).toEqual(['default'])

    unsubscribe()
    onChangeAppState({ oldState, newState })
    expect(seen).toHaveLength(1)
  })
})
