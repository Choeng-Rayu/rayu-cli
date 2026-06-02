import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  type AppState,
  getDefaultAppState,
} from '../src/state/AppStateStore.ts'
import { FileEditTool } from '../src/tools/FileEditTool/FileEditTool.ts'
import { FileWriteTool } from '../src/tools/FileWriteTool/FileWriteTool.ts'
import { getFileModificationTime } from '../src/utils/file.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-tool-validation-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FileWriteTool validation guidance', () => {
  test('rejects overwriting an existing file before a fresh full read', async () => {
    const context = createContext()
    const filePath = join(dir, 'write.ts')
    writeFileSync(filePath, 'old\n')

    const result = await FileWriteTool.validateInput?.(
      { file_path: filePath, content: 'new\n' },
      context as any,
    )

    expect(result?.result).toBe(false)
    if (!result || result.result) throw new Error('Expected validation failure')
    expect(result.message).toContain(
      'Existing-file Write requires a fresh full Read',
    )
    expect(result.message).toContain('without offset or limit')
  })

  test('allows overwriting an existing file after a fresh full read', async () => {
    const context = createContext()
    const filePath = join(dir, 'write-read.ts')
    writeFileSync(filePath, 'old\n')
    context.readFileState.set(filePath, {
      content: 'old\n',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    const result = await FileWriteTool.validateInput?.(
      { file_path: filePath, content: 'new\n' },
      context as any,
    )

    expect(result?.result).toBe(true)
  })
})

describe('FileEditTool validation guidance', () => {
  test('explains exact-match recovery and Write fallback requirements', async () => {
    const context = createContext()
    const filePath = join(dir, 'edit.ts')
    writeFileSync(filePath, 'hello\nworld\n')
    context.readFileState.set(filePath, {
      content: 'hello\nworld\n',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    const result = await FileEditTool.validateInput?.(
      {
        file_path: filePath,
        old_string: 'missing',
        new_string: 'replacement',
        replace_all: false,
      },
      context as any,
    )

    expect(result?.result).toBe(false)
    if (!result || result.result) throw new Error('Expected validation failure')
    expect(result.message).toContain(
      'Retry with a smaller exact string copied from a fresh Read result',
    )
    expect(result.message).toContain(
      'fresh full Read of this exact file path',
    )
    expect(result.message).toContain('use Write with the complete new file')
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
