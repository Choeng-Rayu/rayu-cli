import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type AppState, getDefaultAppState } from '../src/state/AppStateStore.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { recordPendingFileChange } from '../src/utils/pendingFileChanges.ts'
import { resolveFileChangeRecorder } from '../src/tools/AgentTool/runAgent.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-agentrec-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const noop = () => {}

test('resolveFileChangeRecorder: worktree-isolated agent → no-op (does not record to root)', () => {
  let rootCalls = 0
  const root = () => {
    rootCalls++
  }
  const rec = resolveFileChangeRecorder({
    worktreePath: '/tmp/wt',
    rootSetAppState: root,
  })
  rec(prev => prev) // invoking the no-op must not reach root
  expect(rootCalls).toBe(0)
  expect(rec).not.toBe(root)
})

test('resolveFileChangeRecorder: inherits parent recorder when no worktree', () => {
  const parent = noop
  const root = noop
  expect(
    resolveFileChangeRecorder({ parentRecorder: parent, rootSetAppState: root }),
  ).toBe(parent)
})

test('resolveFileChangeRecorder: non-worktree, no parent → records to root', () => {
  const root = noop
  expect(resolveFileChangeRecorder({ rootSetAppState: root })).toBe(root)
})

test('recordPendingFileChange (async agent): records via recordFileChangeSetAppState, NOT setAppState', () => {
  runWithCwdOverride(dir, () => {
    let state: AppState = getDefaultAppState()
    let setAppStateCalls = 0
    const context = {
      getAppState: () => state,
      // Simulates an async/background agent: setAppState is a no-op — if the
      // record went through here it would be LOST (the original bug).
      setAppState: () => {
        setAppStateCalls++
      },
      // The root-store channel runAgent wires for non-worktree agents.
      recordFileChangeSetAppState: (updater: (p: AppState) => AppState) => {
        state = updater(state)
      },
    }
    recordPendingFileChange(context, {
      filePath: join(dir, 'collab.ts'),
      toolName: 'FileWriteTool',
      before: { exists: false },
      afterContent: 'hello\n',
      structuredPatch: [],
    })
    expect(state.pendingFileChanges).toHaveLength(1)
    expect(state.pendingFileChanges[0]?.filePath).toContain('collab.ts')
    expect(setAppStateCalls).toBe(0)
  })
})

test('recordPendingFileChange (main agent): falls back to setAppState when no recorder', () => {
  runWithCwdOverride(dir, () => {
    let state: AppState = getDefaultAppState()
    const context = {
      getAppState: () => state,
      setAppState: (updater: (p: AppState) => AppState) => {
        state = updater(state)
      },
    }
    recordPendingFileChange(context, {
      filePath: join(dir, 'main.ts'),
      toolName: 'FileEditTool',
      before: { exists: false },
      afterContent: 'x\n',
      structuredPatch: [],
    })
    expect(state.pendingFileChanges).toHaveLength(1)
  })
})
