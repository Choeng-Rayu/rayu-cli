// Migration coverage: attribution snapshots in session transcripts stored the
// per-file count under 'claudeContribution'; the rename moved it to
// 'rayuContribution'. Restoring an old session must dual-read the legacy key.
import { describe, expect, test } from 'bun:test'

function snapshot(fileStates: Record<string, unknown>) {
  return {
    type: 'attribution-snapshot' as const,
    messageId: '00000000-0000-0000-0000-000000000000',
    surface: 'cli',
    fileStates,
    promptCount: 3,
  }
}

describe('restoreAttributionStateFromSnapshots legacy key', () => {
  test('restores claudeContribution from an old transcript', async () => {
    const { restoreAttributionStateFromSnapshots } = await import(
      '../src/utils/commitAttribution.ts'
    )
    const state = restoreAttributionStateFromSnapshots([
      snapshot({
        'a.ts': { contentHash: 'h1', claudeContribution: 42, mtime: 1 },
      }) as never,
    ])
    const fileState = state.fileStates.get('a.ts')!
    expect(fileState.rayuContribution).toBe(42)
    expect((fileState as Record<string, unknown>).claudeContribution).toBeUndefined()
    expect(fileState.contentHash).toBe('h1')
    expect(state.promptCount).toBe(3)
  })
  test('restores rayuContribution from a new transcript', async () => {
    const { restoreAttributionStateFromSnapshots } = await import(
      '../src/utils/commitAttribution.ts'
    )
    const state = restoreAttributionStateFromSnapshots([
      snapshot({
        'b.ts': { contentHash: 'h2', rayuContribution: 7, mtime: 2 },
      }) as never,
    ])
    expect(state.fileStates.get('b.ts')!.rayuContribution).toBe(7)
  })
  test('new key wins when both present; missing count defaults to 0', async () => {
    const { restoreAttributionStateFromSnapshots } = await import(
      '../src/utils/commitAttribution.ts'
    )
    const state = restoreAttributionStateFromSnapshots([
      snapshot({
        'c.ts': { contentHash: 'h3', claudeContribution: 1, rayuContribution: 9, mtime: 3 },
        'd.ts': { contentHash: 'h4', mtime: 4 },
      }) as never,
    ])
    expect(state.fileStates.get('c.ts')!.rayuContribution).toBe(9)
    expect(state.fileStates.get('d.ts')!.rayuContribution).toBe(0)
  })
})