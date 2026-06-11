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
  buildFileChangeReviewSummary,
  createPendingFileChangeReviewSystemMessage,
  getPendingFileChangeReviewDetail,
  keepPendingFileChanges,
  type PendingFileChange,
  recordPendingFileChange,
  undoAllPendingFileChanges,
  undoLatestPendingFileChange,
  undoPendingFileChangesByIds,
} from '../src/utils/pendingFileChanges.ts'
import { getPatchFromContents } from '../src/utils/diff.ts'

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
        'Kept changes to second.ts.',
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
        'Kept changes to 2 files.',
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
        'Kept changes to one.ts.',
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

  test('undo file reverts that file pending changes in reverse order', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const targetPath = join(dir, 'target.ts')
      const otherPath = join(dir, 'other.ts')
      recordUpdate(context, targetPath, 'one\n', 'two\n')
      recordUpdate(context, targetPath, 'two\n', 'three\n')
      recordUpdate(context, otherPath, 'other-before\n', 'other-after\n')

      const message = await undoLatestPendingFileChange(context, 'target.ts')

      expect(message).toBe('Undid changes to target.ts (2 edits).')
      expect(readFileSync(targetPath, 'utf8')).toBe('one\n')
      expect(readFileSync(otherPath, 'utf8')).toBe('other-after\n')
      expect(
        context
          .getAppState()
          .pendingFileChanges.map((change: { status: string }) => change.status),
      ).toEqual(['undone', 'undone', 'pending'])
    })
  })

  test('ambiguous basename undo returns an error without changing state', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      mkdirSync(join(dir, 'a'))
      mkdirSync(join(dir, 'b'))
      recordUpdate(context, join(dir, 'a', 'same.ts'), 'a\n', 'aa\n')
      recordUpdate(context, join(dir, 'b', 'same.ts'), 'b\n', 'bb\n')

      expect(await undoLatestPendingFileChange(context, 'same.ts')).toBe(
        'Multiple pending files match same.ts: a/same.ts, b/same.ts. Use a more specific path.',
      )
      expect(readFileSync(join(dir, 'a', 'same.ts'), 'utf8')).toBe('aa\n')
      expect(readFileSync(join(dir, 'b', 'same.ts'), 'utf8')).toBe('bb\n')
      expect(
        context
          .getAppState()
          .pendingFileChanges.map((change: { status: string }) => change.status),
      ).toEqual(['pending', 'pending'])
    })
  })

  test('scoped undo blocks when the target file is dirty', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const filePath = join(dir, 'dirty-scoped.ts')
      recordUpdate(context, filePath, 'before\n', 'after\n')
      writeFileSync(filePath, 'manual\n')

      expect(await undoLatestPendingFileChange(context, 'dirty-scoped.ts')).toBe(
        'Cannot undo dirty-scoped.ts: file changed since Rayu edited it.',
      )
      expect(readFileSync(filePath, 'utf8')).toBe('manual\n')
      expect(context.getAppState().pendingFileChanges[0]?.status).toBe('pending')
    })
  })

  test('card batch undo by ids is all-or-nothing when one file is dirty', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const cleanPath = join(dir, 'clean.ts')
      const dirtyPath = join(dir, 'dirty-batch.ts')
      recordUpdate(context, cleanPath, 'clean-before\n', 'clean-after\n')
      recordUpdate(context, dirtyPath, 'dirty-before\n', 'dirty-after\n')
      writeFileSync(dirtyPath, 'manual\n')
      const ids = context
        .getAppState()
        .pendingFileChanges.map((change: { id: string }) => change.id)

      expect(await undoPendingFileChangesByIds(context, ids)).toBe(
        'Cannot undo dirty-batch.ts: file changed since Rayu edited it.',
      )
      expect(readFileSync(cleanPath, 'utf8')).toBe('clean-after\n')
      expect(readFileSync(dirtyPath, 'utf8')).toBe('manual\n')
      expect(
        context
          .getAppState()
          .pendingFileChanges.map((change: { status: string }) => change.status),
      ).toEqual(['pending', 'pending'])
    })
  })

  test('undo all reports file count with edit count (3 files, 5 edits)', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const a = join(dir, 'a.ts')
      const b = join(dir, 'b.ts')
      const c = join(dir, 'c.ts')
      // 3 files, but 5 edit operations (a and b edited twice).
      recordUpdate(context, a, 'a0\n', 'a1\n')
      recordUpdate(context, b, 'b0\n', 'b1\n')
      recordUpdate(context, c, 'c0\n', 'c1\n')
      recordUpdate(context, a, 'a1\n', 'a2\n')
      recordUpdate(context, b, 'b1\n', 'b2\n')

      const message = await undoAllPendingFileChanges(context)

      // Reports FILES (matching the review card's "Edited N files"), with the
      // edit-operation count in parentheses — not the raw "5 pending changes".
      expect(message).toBe('Undid all changes to 3 files (5 edits).')
      expect(readFileSync(a, 'utf8')).toBe('a0\n')
      expect(readFileSync(b, 'utf8')).toBe('b0\n')
      expect(readFileSync(c, 'utf8')).toBe('c0\n')
    })
  })

  test('card batch undo by ids reverts pending review changes', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const onePath = join(dir, 'one.ts')
      const twoPath = join(dir, 'two.ts')
      recordUpdate(context, onePath, 'one-before\n', 'one-after\n')
      recordUpdate(context, twoPath, 'two-before\n', 'two-after\n')
      const ids = context
        .getAppState()
        .pendingFileChanges.map((change: { id: string }) => change.id)

      expect(await undoPendingFileChangesByIds(context, ids)).toBe(
        'Undid changes to 2 files from this review.',
      )
      expect(readFileSync(onePath, 'utf8')).toBe('one-before\n')
      expect(readFileSync(twoPath, 'utf8')).toBe('two-before\n')
      expect(
        context
          .getAppState()
          .pendingFileChanges.map((change: { status: string }) => change.status),
      ).toEqual(['undone', 'undone'])
    })
  })

  test('review summary groups repeated edits and keeps file order', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const onePath = join(dir, 'one.ts')
      const twoPath = join(dir, 'two.ts')
      recordUpdateWithPatch(context, onePath, 'a\n', 'b\n')
      recordUpdateWithPatch(context, twoPath, 'x\n', 'x\ny\n')
      recordUpdateWithPatch(context, onePath, 'b\n', 'b\nc\n')

      const summary = buildFileChangeReviewSummary(
        context.getAppState().pendingFileChanges,
      )

      expect(summary?.totalFiles).toBe(2)
      expect(summary?.files.map(file => file.displayPath)).toEqual([
        'one.ts',
        'two.ts',
      ])
      expect(summary?.files[0]?.changeIds).toHaveLength(2)
      expect(summary?.files[0]?.additions).toBe(2)
      expect(summary?.files[0]?.removals).toBe(1)
      expect(summary?.files[1]?.additions).toBe(1)
      expect(summary?.totalAdditions).toBe(3)
      expect(summary?.totalRemovals).toBe(1)
    })
  })

  test('review summary reports the NET diff per file, not the sum of every edit', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const p = join(dir, 'net.ts')
      // edit 1 adds a line; edit 2 rewrites that same line. The per-edit sum
      // would be +2 -1, but the NET change (baseline -> current) is only +1.
      recordUpdateWithPatch(context, p, 'L1\n', 'L1\nL2\n')
      recordUpdateWithPatch(context, p, 'L1\nL2\n', 'L1\nL2_edited\n')

      const summary = buildFileChangeReviewSummary(
        context.getAppState().pendingFileChanges,
      )

      expect(summary?.totalFiles).toBe(1)
      expect(summary?.files[0]?.changeIds).toHaveLength(2)
      // NET, not the inflated per-edit sum (+2 -1):
      expect(summary?.files[0]?.additions).toBe(1)
      expect(summary?.files[0]?.removals).toBe(0)
      expect(summary?.totalAdditions).toBe(1)
      expect(summary?.totalRemovals).toBe(0)
    })
  })

  test('after keeping changes, the summary shows only the post-keep net diff', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const p = join(dir, 'keep.ts')
      recordUpdateWithPatch(context, p, 'base\n', 'base\nfirst\n')
      keepPendingFileChanges(context, '') // /keep all -> baseline resets here
      recordUpdateWithPatch(context, p, 'base\nfirst\n', 'base\nfirst\nsecond\n')

      const summary = buildFileChangeReviewSummary(
        context.getAppState().pendingFileChanges,
      )

      // Only the post-keep edit is pending; baseline is the kept state.
      expect(summary?.totalFiles).toBe(1)
      expect(summary?.files[0]?.changeIds).toHaveLength(1)
      expect(summary?.files[0]?.additions).toBe(1)
      expect(summary?.files[0]?.removals).toBe(0)
    })
  })

  test('a file edited then reverted to its baseline is dropped (net-zero), like git', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const p = join(dir, 'zero.ts')
      recordUpdateWithPatch(context, p, 'same\n', 'changed\n')
      recordUpdateWithPatch(context, p, 'changed\n', 'same\n')

      const summary = buildFileChangeReviewSummary(
        context.getAppState().pendingFileChanges,
      )

      // baseline 'same\n' -> current 'same\n' = no net change -> not shown.
      expect(summary).toBeNull()
    })
  })

  test('review summary synthesizes create-file hunks', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      const filePath = join(dir, 'created-review.ts')
      writeFileSync(filePath, 'one\ntwo\n')
      recordPendingFileChange(context, {
        filePath,
        toolName: 'FileWriteTool',
        before: { exists: false },
        afterContent: 'one\ntwo\n',
        structuredPatch: [],
      })

      const summary = buildFileChangeReviewSummary(
        context.getAppState().pendingFileChanges,
      )

      expect(summary?.totalFiles).toBe(1)
      expect(summary?.files[0]?.isCreated).toBe(true)
      expect(summary?.files[0]?.hunks.length).toBeGreaterThan(0)
      expect(summary?.files[0]?.additions).toBe(2)
      expect(summary?.files[0]?.removals).toBe(0)
    })
  })

  test('pending review message includes all unkept session changes', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      recordUpdateWithPatch(context, join(dir, 'kept.ts'), 'a\n', 'b\n')
      recordUpdateWithPatch(context, join(dir, 'pending.ts'), 'x\n', 'y\n')
      context.setAppState(prev => ({
        ...prev,
        pendingFileChanges: prev.pendingFileChanges.map(
          (change: PendingFileChange) =>
            change.displayPath === 'kept.ts'
              ? { ...change, status: 'kept' }
              : change,
        ),
      }))

      const message = createPendingFileChangeReviewSystemMessage(
        context.getAppState().pendingFileChanges,
      )

      expect(message).not.toBeNull()
      expect(message?.review.totalFiles).toBe(1)
      expect(message?.review.files[0]?.displayPath).toBe('pending.ts')
      expect(message?.review.totalAdditions).toBe(1)
      expect(message?.review.totalRemovals).toBe(1)
    })
  })

  test('review detail with no file shows all pending code diffs', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      recordUpdateWithPatch(context, join(dir, 'one.ts'), 'a\n', 'b\n')
      recordUpdateWithPatch(context, join(dir, 'two.ts'), 'x\n', 'y\n')

      const detail = getPendingFileChangeReviewDetail(context, '')

      expect(detail).toContain('Edited 2 files +2 -2')
      expect(detail).toContain('one.ts +1 -1')
      expect(detail).toContain('two.ts +1 -1')
      expect(detail).toContain('@@')
      expect(detail).toContain('-a')
      expect(detail).toContain('+b')
      expect(detail).toContain('-x')
      expect(detail).toContain('+y')
    })
  })

  test('review detail file shows only matching pending code diffs', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      recordUpdateWithPatch(context, join(dir, 'one.ts'), 'a\n', 'b\n')
      recordUpdateWithPatch(context, join(dir, 'two.ts'), 'x\n', 'y\n')

      const detail = getPendingFileChangeReviewDetail(context, 'one.ts')

      expect(detail).toContain('Edited 1 file +1 -1')
      expect(detail).toContain('one.ts +1 -1')
      expect(detail).toContain('-a')
      expect(detail).toContain('+b')
      expect(detail).not.toContain('two.ts')
      expect(detail).not.toContain('-x')
      expect(detail).not.toContain('+y')
    })
  })

  test('review detail ambiguous basename returns an error', async () => {
    await runWithCwdOverride(dir, async () => {
      const context = createContext()
      mkdirSync(join(dir, 'a'))
      mkdirSync(join(dir, 'b'))
      recordUpdateWithPatch(context, join(dir, 'a', 'same.ts'), 'a\n', 'aa\n')
      recordUpdateWithPatch(context, join(dir, 'b', 'same.ts'), 'b\n', 'bb\n')

      expect(getPendingFileChangeReviewDetail(context, 'same.ts')).toBe(
        'Multiple pending files match same.ts: a/same.ts, b/same.ts. Use a more specific path.',
      )
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

function recordUpdateWithPatch(
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
    structuredPatch: getPatchFromContents({
      filePath,
      oldContent: before,
      newContent: after,
    }),
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
