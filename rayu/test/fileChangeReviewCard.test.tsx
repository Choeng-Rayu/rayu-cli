import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Writable } from 'stream'
import stripAnsi from 'strip-ansi'
import { FileChangeReviewCard } from '../src/components/FileChangeReviewCard.tsx'
import { FileChangeReviewActionsProvider } from '../src/context/fileChangeReviewContext.tsx'
import { render } from '../src/ink.ts'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
} from '../src/state/AppState.tsx'
import { getPatchFromContents } from '../src/utils/diff.ts'
import { isNotEmptyMessage, normalizeMessages } from '../src/utils/messages.ts'
import {
  buildFileChangeReviewSummary,
  createFileChangeReviewSystemMessage,
  createPendingFileChangeReviewSystemMessage,
  isFileChangeReviewSystemMessage,
  recordPendingFileChange,
} from '../src/utils/pendingFileChanges.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-review-card-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FileChangeReviewCard', () => {
  test('creates a renderable review message for all pending session changes', () => {
    const state = getDefaultAppState()
    const context = createContext(state)
    const firstPath = join(dir, 'first.ts')
    writeFileSync(firstPath, 'new\n')
    recordPendingFileChange(context, {
      filePath: firstPath,
      toolName: 'FileEditTool',
      before: {
        exists: true,
        content: 'old\n',
        encoding: 'utf8',
        lineEndings: 'LF',
      },
      afterContent: 'new\n',
      structuredPatch: getPatchFromContents({
        filePath: firstPath,
        oldContent: 'old\n',
        newContent: 'new\n',
      }),
    })
    state.pendingFileChanges[0] = {
      ...state.pendingFileChanges[0]!,
      status: 'kept',
    }
    const secondPath = join(dir, 'second.ts')
    writeFileSync(secondPath, 'after\n')
    recordPendingFileChange(context, {
      filePath: secondPath,
      toolName: 'FileWriteTool',
      before: { exists: false },
      afterContent: 'after\n',
      structuredPatch: getPatchFromContents({
        filePath: secondPath,
        oldContent: '',
        newContent: 'after\n',
      }),
    })

    const message = createPendingFileChangeReviewSystemMessage(
      state.pendingFileChanges,
    )
    expect(message).not.toBeNull()
    expect(message?.review.totalFiles).toBe(1)
    expect(message?.review.files[0]?.filePath).toBe(secondPath)

    const normalized = normalizeMessages([message!]).filter(isNotEmptyMessage)
    expect(normalized).toHaveLength(1)
    expect(isFileChangeReviewSystemMessage(normalized[0])).toBe(true)
  })

  test('filters kept files from an older review card and recalculates totals', async () => {
    const state = getDefaultAppState()
    const context = createContext(state)
    const firstPath = join(dir, 'kept.ts')
    const secondPath = join(dir, 'pending.ts')

    for (const [filePath, before, after] of [
      [firstPath, 'old\n', 'new\n'],
      [secondPath, 'x\n', 'y\n'],
    ] as const) {
      writeFileSync(filePath, after)
      recordPendingFileChange(context, {
        filePath,
        toolName: 'FileEditTool',
        before: {
          exists: true,
          content: before,
          encoding: 'utf8',
          lineEndings: 'LF',
        },
        afterContent: after,
        structuredPatch: getPatchFromContents({
          filePath,
          oldContent: before,
          newContent: after,
        }),
      })
    }

    const summary = buildFileChangeReviewSummary(state.pendingFileChanges)
    if (!summary) throw new Error('Expected review summary')
    const message = createFileChangeReviewSystemMessage(summary)
    state.pendingFileChanges[0] = {
      ...state.pendingFileChanges[0]!,
      status: 'kept',
    }

    const stdout = new CaptureStream()
    const instance = await render(
      <AppStateProvider initialState={state}>
        <FileChangeReviewActionsProvider
          actions={{ undoChangeIds: async () => 'No pending changes.' }}
        >
          <FileChangeReviewCard message={message} />
        </FileChangeReviewActionsProvider>
      </AppStateProvider>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )

    await new Promise(resolve => setTimeout(resolve, 20))
    instance.unmount()
    instance.cleanup()

    const output = stripAnsi(stdout.output)
    expect(output).toContain('Edited 1 file')
    expect(output).toContain('+1')
    expect(output).toContain('-1')
    expect(output).toContain('pending.ts')
    expect(output).not.toContain('kept.ts')
    expect(output).not.toContain('kept')
  })

  test('renders all summary rows (no truncation) without inline code preview', async () => {
    const state = getDefaultAppState()
    const context = createContext(state)
    const files = ['one.ts', 'two.ts', 'three.ts', 'four.ts']

    for (const file of files) {
      const filePath = join(dir, file)
      writeFileSync(filePath, 'after\n')
      recordPendingFileChange(context, {
        filePath,
        toolName: 'FileEditTool',
        before: {
          exists: true,
          content: 'before\n',
          encoding: 'utf8',
          lineEndings: 'LF',
        },
        afterContent: 'after\n',
        structuredPatch: getPatchFromContents({
          filePath,
          oldContent: 'before\n',
          newContent: 'after\n',
        }),
      })
    }

    const summary = buildFileChangeReviewSummary(state.pendingFileChanges)
    if (!summary) throw new Error('Expected review summary')
    const message = createFileChangeReviewSystemMessage(summary)
    const stdout = new CaptureStream()
    const instance = await render(
      <AppStateProvider initialState={state}>
        <FileChangeReviewActionsProvider
          actions={{ undoChangeIds: async () => 'No pending changes.' }}
        >
          <FileChangeReviewCard message={message} />
        </FileChangeReviewActionsProvider>
      </AppStateProvider>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )

    await new Promise(resolve => setTimeout(resolve, 20))
    instance.unmount()
    instance.cleanup()

    const output = stripAnsi(stdout.output)
    expect(output).toContain('Edited 4 files')
    expect(output).toContain('+4')
    expect(output).toContain('-4')
    // All changed files are shown (no 3-file truncation / "Show more" button).
    expect(output).toContain('one.ts')
    expect(output).toContain('two.ts')
    expect(output).toContain('three.ts')
    expect(output).toContain('four.ts')
    expect(output).not.toContain('Show 1 more file')
    expect(output).toContain('Details: /review_detail  [file_name]')
    expect(output).not.toContain('Hide review')
    expect(output).not.toContain('review record')
    expect(output).not.toContain('before')
    expect(output).not.toContain('after')
  })
})

function createContext(state: AppState) {
  return {
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      Object.assign(state, updater(state))
    },
  }
}

class CaptureStream extends Writable {
  columns = 100
  rows = 30
  isTTY = false
  private chunks: string[] = []

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    callback()
  }

  get output(): string {
    return this.chunks.join('')
  }
}
