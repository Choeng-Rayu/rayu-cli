/**
 * Rayucode's plan approval: the card offers how the approved plan continues (Ask,
 * Auto-edit or Orchestrator), and the host's answer is run through the engine's REAL
 * stdio permission mapping and the REAL ExitPlanMode tool, so what the button says is
 * what the session ends up in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { setHasExitedPlanMode, setNeedsPlanModeExitAttachment } from '../src/bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../src/Tool.js'
import { ExitPlanModeV2Tool } from '../src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import {
  outputSchema,
  permissionPromptToolResultToPermissionDecision,
} from '../src/utils/permissions/PermissionPromptToolResultSchema.js'
import { getPlanFilePath, getPlansDirectory } from '../src/utils/plans.js'
import type { ControlClient } from '../src/vscode/host/engine/controlClient.js'
import { PermissionRouter, type PermissionDecision } from '../src/vscode/host/panel/permissionRouter.js'
import {
  isPlanApprovalChoice,
  PLAN_APPROVAL_CHOICES,
  planApprovalLabel,
  planApprovalMode,
} from '../src/vscode/shared/planApproval.js'
import type { PermissionRequestView } from '../src/vscode/shared/webviewProtocol.js'
import { PlanApprovalCard } from '../src/vscode/webview/components/PlanApprovalCard.js'

const PLAN = '1. Add the endpoint\n2. Test it'

const savedConfigDir = process.env.RAYU_CONFIG_DIR
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'rayucode-plan-approval-'))
  process.env.RAYU_CONFIG_DIR = configDir
  getPlansDirectory.cache.clear?.()
})

afterEach(() => {
  setHasExitedPlanMode(false)
  setNeedsPlanModeExitAttachment(false)
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  getPlansDirectory.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

/** The router with a recording control client, holding one ExitPlanMode request. */
function planRequest(options: { mirrored?: boolean; toolName?: string } = {}) {
  const sent: Record<string, unknown>[] = []
  const remote: unknown[] = []
  const shown: PermissionRequestView[] = []
  const dismissed: string[] = []
  const control = {
    respond: (_id: string, response: Record<string, unknown>) => sent.push(response),
  } as unknown as ControlClient
  const router = new PermissionRouter({
    onShow: view => shown.push(view),
    onDismiss: id => dismissed.push(id),
  })
  const toolName = options.toolName ?? 'ExitPlanMode'
  const input = toolName === 'ExitPlanMode'
    ? { plan: PLAN, planFilePath: getPlanFilePath() }
    : { command: 'git status' }
  if (options.mirrored) {
    router.presentMirrored({ requestId: 'r1', toolName, input }, response => remote.push(response))
  } else {
    router.present({
      requestId: 'r1',
      subtype: 'can_use_tool',
      request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: 'toolu_1' },
    })
  }
  const decide = (kind: PermissionDecision['kind']) => router.resolve(control, 'r1', { kind } as PermissionDecision)
  return { router, input, sent, remote, shown, dismissed, decide }
}

describe('the plan card offers how the plan continues', () => {
  test('for this panel\u2019s own engine only', () => {
    expect(planRequest().shown[0]!.planApproval?.offersModeChoice).toBe(true)
    // An attached CLI session applies its own plan-exit rule over IPC.
    expect(planRequest({ mirrored: true }).shown[0]!.planApproval?.offersModeChoice).toBeUndefined()
  })

  test('one approve button per mode, named after the mode pill, Orchestrator as the primary action', () => {
    const request = planRequest().shown[0]!
    const html = renderToStaticMarkup(<PlanApprovalCard request={request} onDecide={() => {}} />)
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map(match => ({
      label: match[2],
      primary: match[1]!.includes('rc-button-primary'),
    }))
    expect(buttons).toEqual([
      { label: 'Keep planning', primary: false },
      { label: 'Approve · Ask', primary: false },
      { label: 'Approve · Auto-edit', primary: false },
      { label: 'Approve · Orchestrator', primary: true },
    ])
    expect(PLAN_APPROVAL_CHOICES.map(choice => planApprovalLabel(choice).label)).toEqual(
      buttons.slice(1).map(button => button.label),
    )
  })

  test('a mirrored request keeps the single Approve plan', () => {
    const request = planRequest({ mirrored: true }).shown[0]!
    const html = renderToStaticMarkup(<PlanApprovalCard request={request} onDecide={() => {}} />)
    expect([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1])).toEqual([
      'Keep planning',
      'Approve plan',
    ])
  })

  test('the choice table', () => {
    expect(PLAN_APPROVAL_CHOICES.map(planApprovalMode)).toEqual(['default', 'acceptEdits', null])
    expect(isPlanApprovalChoice('approve-orchestrate')).toBe(true)
    expect(isPlanApprovalChoice('allow-once')).toBe(false)
    expect(isPlanApprovalChoice('toString')).toBe(false)
  })
})

describe('what each choice answers', () => {
  test('orchestrate: allow without the injected plan text and without a mode change', () => {
    const h = planRequest()
    h.decide('approve-orchestrate')
    expect(h.sent).toEqual([
      { behavior: 'allow', updatedInput: { planFilePath: getPlanFilePath() }, decisionClassification: 'user_temporary' },
    ])
    expect(h.dismissed).toEqual(['r1'])
  })

  test('auto-edit and ask: allow plus a session setMode the engine schema keeps', () => {
    for (const [choice, mode] of [['approve-accept-edits', 'acceptEdits'], ['approve-default', 'default']] as const) {
      const h = planRequest()
      h.decide(choice)
      const parsed = outputSchema().parse(h.sent[0])
      // `.catch` in the schema would silently drop a malformed entry, so check it survived.
      expect(parsed).toMatchObject({
        behavior: 'allow',
        updatedInput: { planFilePath: getPlanFilePath() },
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
      })
    }
  })

  test('a plan choice is ignored on a card that did not offer it, and the card stays', () => {
    for (const h of [planRequest({ mirrored: true }), planRequest({ toolName: 'Bash' })]) {
      h.decide('approve-accept-edits')
      expect(h.sent).toEqual([])
      expect(h.remote).toEqual([])
      expect(h.dismissed).toEqual([])
      expect(h.router.hasPending).toBe(true)
    }
  })

  test('a mirrored Approve plan also leaves the plan text out', () => {
    const h = planRequest({ mirrored: true })
    h.decide('allow-once')
    expect(h.remote).toEqual([{ behavior: 'allow', updatedInput: { planFilePath: getPlanFilePath() } }])
  })

  test('other tools still echo their input unchanged', () => {
    const h = planRequest({ toolName: 'Bash' })
    h.decide('allow-once')
    expect(h.sent).toEqual([
      { behavior: 'allow', updatedInput: { command: 'git status' }, decisionClassification: 'user_temporary' },
    ])
  })
})

/** Apply the host's answer the way the engine does, then run the real tool. */
async function engineOutcome(choice: PermissionDecision['kind']) {
  writeFileSync(getPlanFilePath(), PLAN)
  const h = planRequest()
  h.decide(choice)
  let state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'plan' as string } }
  const context = {
    agentId: undefined,
    options: { tools: [] },
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (previous: typeof state) => typeof state) => {
      state = update(state)
    },
  }
  const decision = permissionPromptToolResultToPermissionDecision(
    outputSchema().parse(h.sent[0]),
    ExitPlanModeV2Tool as never,
    h.input,
    context as never,
  )
  if (decision.behavior !== 'allow') throw new Error('expected an allow')
  const call = ExitPlanModeV2Tool.call.bind(ExitPlanModeV2Tool) as unknown as (
    input: unknown,
    ctx: unknown,
  ) => Promise<{ data: Record<string, unknown> }>
  const { data } = await call(decision.updatedInput, context)
  const block = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(data as never, 'toolu_1')
  return { mode: state.toolPermissionContext.mode, text: String(block.content) }
}

describe('the session ends up in the mode the button named', () => {
  test('Approve · Orchestrator', async () => {
    const outcome = await engineOutcome('approve-orchestrate')
    expect(outcome.mode).toBe('orchestrator')
    expect(outcome.text).toContain('Orchestrator mode is now active')
    expect(outcome.text).toContain('## Approved Plan:')
    expect(outcome.text).not.toContain('edited by user')
  })

  test('Approve · Auto-edit', async () => {
    const outcome = await engineOutcome('approve-accept-edits')
    expect(outcome.mode).toBe('acceptEdits')
    expect(outcome.text).toContain('The permission mode is now Accept edits.')
    expect(outcome.text).not.toContain('Orchestrator')
  })

  test('Approve · Ask', async () => {
    const outcome = await engineOutcome('approve-default')
    expect(outcome.mode).toBe('default')
    expect(outcome.text).toContain('The permission mode is now Default.')
  })

  test('the generic Allow once on a plan request is not reported as an edit either', async () => {
    const outcome = await engineOutcome('allow-once')
    expect(outcome.mode).toBe('orchestrator')
    expect(outcome.text).not.toContain('edited by user')
  })
})
