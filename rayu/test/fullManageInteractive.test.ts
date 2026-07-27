import { describe, expect, it } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext } from 'src/Tool'
import { hasPermissionsToUseToolInner } from 'src/utils/permissions/permissions'

// Minimal ToolUseContext for the mode-gating path: step 0 (fullManage) + steps
// 1a–1e only read abortController + toolPermissionContext.
function ctxForMode(mode: string) {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: { ...getEmptyToolPermissionContext(), mode },
    }),
  } as unknown as Parameters<typeof hasPermissionsToUseToolInner>[2]
}

// A tool whose checkPermissions asks for confirmation (like AskUserQuestion),
// with configurable requiresUserInteraction.
function fakeAskTool(name: string, requiresUserInteraction: boolean) {
  return {
    name,
    mcpInfo: undefined,
    inputSchema: z.object({}).passthrough(),
    requiresUserInteraction: () => requiresUserInteraction,
    async checkPermissions(input: Record<string, unknown>) {
      return {
        behavior: 'ask' as const,
        message: 'Answer questions?',
        updatedInput: input,
      }
    },
  } as never
}

describe('fullManage mode honors requiresUserInteraction (AskUserQuestion fix)', () => {
  it('does NOT auto-allow an interactive tool in fullManage — surfaces the ask so the dialog shows', async () => {
    const res = await hasPermissionsToUseToolInner(
      fakeAskTool('AskUserQuestion', true),
      {},
      ctxForMode('fullManage'),
    )
    // Before the fix this returned {behavior:'allow'} at step 0, so the dialog
    // never rendered and the tool ran with empty answers ("nothing happens").
    expect(res.behavior).toBe('ask')
  })

  it('still auto-allows a NON-interactive tool in fullManage (full-auto preserved)', async () => {
    const res = await hasPermissionsToUseToolInner(
      fakeAskTool('SomeAutoTool', false),
      {},
      ctxForMode('fullManage'),
    )
    expect(res.behavior).toBe('allow')
    expect(res.decisionReason).toMatchObject({ type: 'mode', mode: 'fullManage' })
  })

  it('surfaces the ask for an interactive tool in default mode too (baseline)', async () => {
    const res = await hasPermissionsToUseToolInner(
      fakeAskTool('AskUserQuestion', true),
      {},
      ctxForMode('default'),
    )
    expect(res.behavior).toBe('ask')
  })
})
