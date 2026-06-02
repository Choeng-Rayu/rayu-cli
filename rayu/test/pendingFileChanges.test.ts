import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  type AppState,
  getDefaultAppState,
} from '../src/state/AppStateStore.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { getFileModificationTime } from '../src/utils/file.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'
import {
  keepPendingFileChanges,
  recordPendingFileChange,
  undoLatestPendingFileChange,
} from '../src/utils/pendingFileChanges.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-pending-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('pending file changes', () => {
  test('undo restores previous content for an update', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const filePath = join(dir, 'example.ts')
      writeFileSync(filePath, 'after\n')
      context.readFileState.set(filePath, fileState('after\n', filePath))
      recordPendingFileChange(context, {
        filePath,
        toolName: 'FileEditTool',
        before: beforeSnapshot('before\n'),
        afterContent: 'after\n',
        structuredPatch: [],
      })

      const message = await undoLatestPendingFileChange(context)

      expect(message).toBe('Undid changes to example.ts.')
      expect(readFileSync(filePath, 'utf8')).toBe('before\n')
      expect(context.getAppState().pendingFileChanges[0]?.status).toBe('undone')
    })
  })

  test('undo deletes a newly created file', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const filePath = join(dir, 'created.ts')
      writeFileSync(filePath, 'created\n')
      context.readFileState.set(filePath, fileState('created\n', filePath))
      recordPendingFileChange(context, {
        filePath,
        toolName: 'FileWriteTool',
        before: { exists: false },
        afterContent: 'created\n',
        structuredPatch: [],
      })

      const message = await undoLatestPendingFileChange(context)

      expect(message).toBe('Undid changes to created.ts.')
      expect(existsSync(filePath)).toBe(false)
      expect(context.readFileState.has(filePath)).toBe(false)
    })
  })

  test('undo skips kept changes and reverts the newest remaining pending change', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const firstPath = join(dir, 'first.ts')
      const secondPath = join(dir, 'second.ts')
      writeFileSync(firstPath, 'first-after\n')
      writeFileSync(secondPath, 'second-after\n')
      recordUpdate(context, firstPath, 'first-before\n', 'first-after\n')
      recordUpdate(context, secondPath, 'second-before\n', 'second-after\n')

      expect(keepPendingFileChanges(context, 'second.ts')).toBe(
        'Kept 1 pending change for second.ts.',
      )
      const message = await undoLatestPendingFileChange(context)

      expect(message).toBe('Undid changes to first.ts.')
      expect(readFileSync(firstPath, 'utf8')).toBe('first-before\n')
      expect(readFileSync(secondPath, 'utf8')).toBe('second-after\n')
    })
  })

  test('keep with no file keeps all pending changes', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      recordUpdate(context, join(dir, 'one.ts'), 'one-before\n', 'one-after\n')
      recordUpdate(context, join(dir, 'two.ts'), 'two-before\n', 'two-after\n')

      expect(keepPendingFileChanges(context, '')).toBe(
        'Kept 2 pending file changes.',
      )
      expect(
        context
          .getAppState()
          .pendingFileChanges.map((change: { status: string }) => change.status),
      ).toEqual(['kept', 'kept'])
    })
  })

  test('keep file keeps only matching pending changes', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      recordUpdate(context, join(dir, 'one.ts'), 'one-before\n', 'one-after\n')
      recordUpdate(context, join(dir, 'two.ts'), 'two-before\n', 'two-after\n')

      expect(keepPendingFileChanges(context, 'one.ts')).toBe(
        'Kept 1 pending change for one.ts.',
      )
      expect(
        context
          .getAppState()
          .pendingFileChanges.map((change: { status: string }) => change.status),
      ).toEqual(['kept', 'pending'])
    })
  })

  test('ambiguous basename keep returns an error without changing state', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      mkdirSync(join(dir, 'a'))
      mkdirSync(join(dir, 'b'))
      recordUpdate(context, join(dir, 'a', 'same.ts'), 'a\n', 'aa\n')
      recordUpdate(context, join(dir, 'b', 'same.ts'), 'b\n', 'bb\n')

      expect(keepPendingFileChanges(context, 'same.ts')).toBe(
        'Multiple pending files match same.ts: a/same.ts, b/same.ts. Use a more specific path.',
      )
      expect(
        context
          .getAppState()
          .pendingFileChanges.map((change: { status: string }) => change.status),
      ).toEqual(['pending', 'pending'])
    })
  })

  test('undo blocks when the file changed after Rayu edited it', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const filePath = join(dir, 'dirty.ts')
      writeFileSync(filePath, 'after\n')
      recordUpdate(context, filePath, 'before\n', 'after\n')
      writeFileSync(filePath, 'manual\n')

      const message = await undoLatestPendingFileChange(context)

      expect(message).toBe(
        'Cannot undo dirty.ts: file changed since Rayu edited it.',
      )
      expect(readFileSync(filePath, 'utf8')).toBe('manual\n')
      expect(context.getAppState().pendingFileChanges[0]?.status).toBe('pending')
    })
  })
})

function createContext() {
  let state: AppState = getDefaultAppState()
  const readFileState = createFileStateCacheWithSizeLimit(100)

  return {
    readFileState,
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
  }
}

function recordUpdate(
  context: ReturnType<typeof createContext>,
  filePath: string,
  before: string,
  after: string,
): void {
  writeFileSync(filePath, after)
  context.readFileState.set(filePath, fileState(after, filePath))
  recordPendingFileChange(context, {
    filePath,
    toolName: 'FileEditTool',
    before: beforeSnapshot(before),
    afterContent: after,
    structuredPatch: [],
  })
}

function beforeSnapshot(content: string) {
  return {
    exists: true as const,
    content,
    encoding: 'utf8' as const,
    lineEndings: 'LF' as const,
  }
}

function fileState(content: string, filePath: string) {
  return {
    content,
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  }
}
