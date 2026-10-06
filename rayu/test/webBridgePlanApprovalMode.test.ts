/**
 * What a remote plan approval does to the session's permission mode.
 *
 * Studio's plan card states the outcome of each button ("Approve · Orchestrator",
 * "Approve · auto-accept edits"). Those outcomes are decided by the engine, not by
 * Studio, so they are pinned here by running the response the Web Bridge builds through
 * the REAL ExitPlanMode tool, with permission updates applied the way the CLI's
 * permission flow applies them (PermissionContext.persistPermissions →
 * applyPermissionUpdates). If either assertion changes, Studio's card copy
 * (rayu-studio/app/components/remote/PlanApprovalCard.tsx) must change with it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext } from '../src/Tool.js'
import { setHasExitedPlanMode, setNeedsPlanModeExitAttachment } from '../src/bootstrap/state.js'
import { ExitPlanModeV2Tool } from '../src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { applyPermissionUpdates } from '../src/utils/permissions/PermissionUpdate.js'
import { getPlansDirectory } from '../src/utils/plans.js'
import { resolveApprovalDecision } from '../src/webBridge/webBridgeApprovals.js'

type PermissionContext = ReturnType<typeof getEmptyToolPermissionContext>
type ToolCall = (input: Record<string, unknown>, context: unknown) => Promise<unknown>

const savedConfigDir = process.env.RAYU_CONFIG_DIR
let configDir: string

beforeAll(() => {
  // The tool resolves — and creates — the plans directory under the config home.
  configDir = mkdtempSync(join(tmpdir(), 'rayu-plan-mode-'))
  process.env.RAYU_CONFIG_DIR = configDir
  getPlansDirectory.cache.clear?.()
})

afterEach(() => {
  // Process-wide plan-exit flags the tool sets; other suites must not inherit them.
  setHasExitedPlanMode(false)
  setNeedsPlanModeExitAttachment(false)
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  getPlansDirectory.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

async function modeAfterRemoteApproval(updatedPermissions?: unknown[]): Promise<string> {
  const response = resolveApprovalDecision(
    'plan',
    { requestId: 'r', toolName: 'ExitPlanMode', input: { plan: '1. Ship it' } },
    { callId: 'r', behavior: 'allow', ...(updatedPermissions ? { updatedPermissions } : {}) },
  )
  if (!response?.updatedInput) throw new Error('plan approval produced no response')

  let toolPermissionContext: PermissionContext = { ...getEmptyToolPermissionContext(), mode: 'plan' }
  if (response.updatedPermissions?.length) {
    toolPermissionContext = applyPermissionUpdates(
      toolPermissionContext,
      response.updatedPermissions as never,
    )
  }

  let state = { toolPermissionContext }
  const call = ExitPlanModeV2Tool.call.bind(ExitPlanModeV2Tool) as unknown as ToolCall
  await call(response.updatedInput, {
    agentId: undefined,
    options: { tools: [] },
    getAppState: () => state,
    setAppState: (update: (previous: typeof state) => typeof state) => {
      state = update(state)
    },
  })
  return state.toolPermissionContext.mode
}

describe('remote plan approval → permission mode', () => {
  test('plain Approve hands the plan to Orchestrator mode', async () => {
    expect(await modeAfterRemoteApproval()).toBe('orchestrator')
  })

  test('Approve + auto-accept edits ends in acceptEdits, not Orchestrator', async () => {
    expect(
      await modeAfterRemoteApproval([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
    ).toBe('acceptEdits')
  })
})
