import { describe, expect, test } from 'bun:test'
import orchestratorCommand from '../src/commands/orchestrator/index.ts'
import { call as normalCall } from '../src/commands/normal/normal.ts'
import {
  type AppState,
  getDefaultAppState,
} from '../src/state/AppStateStore.ts'
import {
  getOrchestratorMode,
  setOrchestratorModeUpdater,
} from '../src/utils/orchestratorMode.ts'
import { getNextPermissionMode } from '../src/utils/permissions/getNextPermissionMode.ts'
import {
  PERMISSION_MODES,
  permissionModeShortTitle,
  permissionModeSymbol,
  permissionModeTitle,
} from '../src/utils/permissions/PermissionMode.ts'

function fakeContext() {
  let state: AppState = getDefaultAppState()
  return {
    getAppState: () => state,
    setAppState: (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    },
    get state() {
      return state
    },
  }
}

describe('Orchestrator mode state', () => {
  test('uses a distinct mode and exits to the normal default mode', () => {
    const initial = getDefaultAppState()
    expect(getOrchestratorMode(initial)).toBe(false)

    const orchestrating = setOrchestratorModeUpdater(true)(initial)
    expect(orchestrating.toolPermissionContext.mode).toBe('orchestrator')
    expect(getOrchestratorMode(orchestrating)).toBe(true)

    const normal = setOrchestratorModeUpdater(false)(orchestrating)
    expect(normal.toolPermissionContext.mode).toBe('default')
    expect(getOrchestratorMode(normal)).toBe(false)
  })

  test('/orchestrator enters and /normal exits', async () => {
    const context = fakeContext()
    await orchestratorCommand.getPromptForCommand('build a website', context as never)
    expect(context.state.toolPermissionContext.mode).toBe('orchestrator')

    const result = await normalCall('', context as never)
    expect(context.state.toolPermissionContext.mode).toBe('default')
    expect(String((result as { value: string }).value)).toContain(
      'Exited Orchestrator',
    )
  })

  test('CLI Shift+Tab includes Orchestrator before wrapping to Ask', () => {
    const state = getDefaultAppState()
    const planContext = {
      ...state.toolPermissionContext,
      mode: 'plan' as const,
      isBypassPermissionsModeAvailable: false,
    }
    expect(getNextPermissionMode(planContext)).toBe('fullManage')
    expect(
      getNextPermissionMode({ ...planContext, mode: 'fullManage' }),
    ).toBe('orchestrator')
    expect(
      getNextPermissionMode({ ...planContext, mode: 'orchestrator' }),
    ).toBe('default')
  })

  test('keeps Full Access, Full Manage, and Orchestrator as distinct CLI modes', () => {
    expect(PERMISSION_MODES).toContain('bypassPermissions')
    expect(PERMISSION_MODES).toContain('fullManage')
    expect(PERMISSION_MODES).toContain('orchestrator')
    expect(permissionModeTitle('fullManage')).toBe('Full Manage')
    expect(permissionModeShortTitle('fullManage')).toBe('FullMng')
    expect(permissionModeSymbol('fullManage')).toBe('⏩')

    const state = getDefaultAppState()
    const context = {
      ...state.toolPermissionContext,
      isBypassPermissionsModeAvailable: true,
    }
    expect(getNextPermissionMode({ ...context, mode: 'plan' })).toBe(
      'bypassPermissions',
    )
    expect(
      getNextPermissionMode({ ...context, mode: 'bypassPermissions' }),
    ).toBe('fullManage')
    expect(getNextPermissionMode({ ...context, mode: 'fullManage' })).toBe(
      'orchestrator',
    )
  })
})
