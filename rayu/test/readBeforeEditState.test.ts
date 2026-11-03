// Read → Edit/Write state handshake, driven through the REAL FileReadTool.
//
// WHY THIS DRIVES THE ACTUAL TOOL
// The bug these tests lock down survived the existing suite precisely because
// test/fileWriteEditValidation.test.ts seeds readFileState BY HAND with
// `offset: undefined`. Only FileReadTool.call produces the shape the bug lived
// in: it destructures `{ offset = 1 }`, so every Read-produced entry stored
// `offset: 1`, which made FileEditTool's `isFullRead` check
// (`offset === undefined && limit === undefined`) permanently false — so the
// "content unchanged, safe to proceed" bypass was unreachable and any mtime bump
// produced "File has been modified since read … Read it again without offset or
// limit", an instruction the next Read could not satisfy either.
//
// So: no hand-seeded cache here. Every entry comes from FileReadTool.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  type AppState,
  getDefaultAppState,
} from '../src/state/AppStateStore.ts'
import { FileEditTool } from '../src/tools/FileEditTool/FileEditTool.ts'
import { FileReadTool } from '../src/tools/FileReadTool/FileReadTool.ts'
import { FileWriteTool } from '../src/tools/FileWriteTool/FileWriteTool.ts'
import {
  createFileStateCacheWithSizeLimit,
  isFullViewOfFile,
  readRequiredMessage,
} from '../src/utils/fileStateCache.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-read-before-edit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test context: the minimum ToolUseContext surface FileReadTool.call touches.
// ---------------------------------------------------------------------------
function createContext() {
  let state: AppState = getDefaultAppState()
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    forceFreshReadPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'claude-sonnet-4-5-20250929' },
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
  }
}

type TestContext = ReturnType<typeof createContext>

async function read(
  context: TestContext,
  file_path: string,
  range?: { offset?: number; limit?: number },
) {
  // parentMessage is only used for its message id in the attachment path.
  return await FileReadTool.call(
    { file_path, ...(range ?? {}) } as never,
    context as never,
    undefined,
    undefined as never,
  )
}

/** Push mtime forward WITHOUT changing content — a formatter/watcher/sync touch. */
function touch(filePath: string): void {
  const future = new Date(Date.now() + 5_000)
  utimesSync(filePath, future, future)
}

// ---------------------------------------------------------------------------

describe('FileReadTool records whether the model saw the whole file', () => {
  test('a Read with no offset/limit is marked fullRead', async () => {
    const context = createContext()
    const filePath = join(dir, 'whole.ts')
    writeFileSync(filePath, 'a\nb\nc\n')

    await read(context, filePath)

    const entry = context.readFileState.get(filePath)
    expect(entry).toBeDefined()
    expect(entry?.fullRead).toBe(true)
    // The regression guard: offset is STILL a concrete 1, so any consumer
    // inferring "full read" from `offset === undefined` would be wrong.
    expect(entry?.offset).toBe(1)
    expect(isFullViewOfFile(entry)).toBe(true)
  })

  test('a Read with an explicit range is NOT marked fullRead', async () => {
    const context = createContext()
    const filePath = join(dir, 'ranged.ts')
    writeFileSync(filePath, 'a\nb\nc\nd\ne\n')

    await read(context, filePath, { offset: 2, limit: 2 })

    const entry = context.readFileState.get(filePath)
    expect(entry?.fullRead).toBe(false)
    expect(isFullViewOfFile(entry)).toBe(false)
  })

  test('an offset-only Read is NOT marked fullRead', async () => {
    const context = createContext()
    const filePath = join(dir, 'offset-only.ts')
    writeFileSync(filePath, 'a\nb\nc\n')

    await read(context, filePath, { offset: 2 })

    expect(context.readFileState.get(filePath)?.fullRead).toBe(false)
  })
})

describe('Edit after a full Read survives a content-preserving mtime bump', () => {
  test('touching the file without changing it does NOT demand another Read', async () => {
    const context = createContext()
    const filePath = join(dir, 'touched.ts')
    writeFileSync(filePath, 'const a = 1\nconst b = 2\n')
    await read(context, filePath)

    touch(filePath)

    const result = await FileEditTool.validateInput?.(
      {
        file_path: filePath,
        old_string: 'const a = 1',
        new_string: 'const a = 9',
        replace_all: false,
      },
      context as never,
    )

    expect(result?.result).toBe(true)
  })

  test('a genuine content change still rejects with errorCode 7', async () => {
    const context = createContext()
    const filePath = join(dir, 'changed.ts')
    writeFileSync(filePath, 'const a = 1\nconst b = 2\n')
    await read(context, filePath)

    // Someone else edited it for real.
    writeFileSync(filePath, 'const a = 1\nconst b = 999\n')
    touch(filePath)

    const result = await FileEditTool.validateInput?.(
      {
        file_path: filePath,
        old_string: 'const a = 1',
        new_string: 'const a = 9',
        replace_all: false,
      },
      context as never,
    )

    expect(result?.result).toBe(false)
    if (!result || result.result) throw new Error('Expected validation failure')
    expect(result.errorCode).toBe(7)
    expect(result.message).toContain('modified since read')
  })

  test('a PARTIAL read cannot use the bypass — content equality is meaningless', async () => {
    const context = createContext()
    const filePath = join(dir, 'partial.ts')
    writeFileSync(filePath, 'const a = 1\nconst b = 2\nconst c = 3\n')
    await read(context, filePath, { offset: 1, limit: 1 })

    touch(filePath)

    const result = await FileEditTool.validateInput?.(
      {
        file_path: filePath,
        old_string: 'const a = 1',
        new_string: 'const a = 9',
        replace_all: false,
      },
      context as never,
    )

    expect(result?.result).toBe(false)
    if (!result || result.result) throw new Error('Expected validation failure')
    expect(result.errorCode).toBe(7)
  })
})

describe('Write after a full Read survives a content-preserving mtime bump', () => {
  test('touching the file without changing it does NOT demand another Read', async () => {
    const context = createContext()
    const filePath = join(dir, 'write-touched.ts')
    writeFileSync(filePath, 'old\n')
    await read(context, filePath)

    touch(filePath)

    const result = await FileWriteTool.validateInput?.(
      { file_path: filePath, content: 'new\n' },
      context as never,
    )

    expect(result?.result).toBe(true)
  })

  test('a genuine content change still rejects with errorCode 3', async () => {
    const context = createContext()
    const filePath = join(dir, 'write-changed.ts')
    writeFileSync(filePath, 'old\n')
    await read(context, filePath)

    writeFileSync(filePath, 'somebody else\n')
    touch(filePath)

    const result = await FileWriteTool.validateInput?.(
      { file_path: filePath, content: 'new\n' },
      context as never,
    )

    expect(result?.result).toBe(false)
    if (!result || result.result) throw new Error('Expected validation failure')
    expect(result.errorCode).toBe(3)
  })
})

describe('"you must Read first" wording names the actual cause', () => {
  test('never read → says exactly that', () => {
    const cache = createFileStateCacheWithSizeLimit(100)
    const message = readRequiredMessage(cache, join(dir, 'nope.ts'), 'retry.')
    expect(message).toContain('File has not been read yet')
    expect(message).not.toContain('aged out')
  })

  test('read earlier but evicted → says the entry aged out, not "never read"', async () => {
    // A 2-entry cache makes eviction deterministic without reading 100 files.
    const cache = createFileStateCacheWithSizeLimit(2)
    const first = join(dir, 'first.ts')
    cache.set(first, {
      content: 'x',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    cache.set(join(dir, 'second.ts'), {
      content: 'y',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    cache.set(join(dir, 'third.ts'), {
      content: 'z',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })

    expect(cache.get(first)).toBeUndefined()
    expect(cache.wasEverRead(first)).toBe(true)

    const message = readRequiredMessage(cache, first, 'retry.')
    expect(message).toContain('aged out of the read cache')
    expect(message).not.toContain('File has not been read yet')
  })

  test('partial view → says only part of the file was seen', () => {
    const cache = createFileStateCacheWithSizeLimit(100)
    const filePath = join(dir, 'partial-view.ts')
    cache.set(filePath, {
      content: 'raw disk bytes',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    const message = readRequiredMessage(cache, filePath, 'retry.')
    expect(message).toContain('only seen part of this file')
  })

  test('Edit surfaces the evicted wording rather than "never read"', async () => {
    const context = createContext()
    const filePath = join(dir, 'evicted-edit.ts')
    writeFileSync(filePath, 'hello\n')
    await read(context, filePath)

    // Simulate LRU eviction: the entry is gone, but the path was read.
    context.readFileState.delete(filePath)
    expect(context.readFileState.wasEverRead(filePath)).toBe(true)

    const result = await FileEditTool.validateInput?.(
      {
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
        replace_all: false,
      },
      context as never,
    )

    expect(result?.result).toBe(false)
    if (!result || result.result) throw new Error('Expected validation failure')
    expect(result.errorCode).toBe(6)
    expect(result.message).toContain('aged out of the read cache')
  })
})

describe('a rejected Edit forces the recovery Read to return real content', () => {
  test('string-not-found marks the path, and the next Read skips the dedup stub', async () => {
    const context = createContext()
    const filePath = join(dir, 'recover.ts')
    writeFileSync(filePath, 'alpha\nbeta\n')

    // First read populates the cache with a dedup-eligible entry.
    await read(context, filePath)
    expect(context.forceFreshReadPaths.size).toBe(0)

    // Sanity: without a rejection, an identical re-read dedups to a stub.
    const stub = await read(context, filePath)
    expect((stub.data as { type: string }).type).toBe('file_unchanged')

    // Now a failing Edit — this is what tells the model to "Read it again".
    const rejected = await FileEditTool.validateInput?.(
      {
        file_path: filePath,
        old_string: 'not in the file',
        new_string: 'x',
        replace_all: false,
      },
      context as never,
    )
    expect(rejected?.result).toBe(false)
    expect(context.forceFreshReadPaths.size).toBe(1)

    // The recovery Read must carry content, not a stub.
    const fresh = await read(context, filePath)
    expect((fresh.data as { type: string }).type).toBe('text')
    expect((fresh.data as { file: { content: string } }).file.content).toContain(
      'alpha',
    )

    // One-shot: the marker is consumed, so normal dedup resumes.
    expect(context.forceFreshReadPaths.size).toBe(0)
    const again = await read(context, filePath)
    expect((again.data as { type: string }).type).toBe('file_unchanged')
  })

  test('an unrelated file still dedups after a rejection elsewhere', async () => {
    const context = createContext()
    const rejectedPath = join(dir, 'rejected.ts')
    const otherPath = join(dir, 'other.ts')
    writeFileSync(rejectedPath, 'alpha\n')
    writeFileSync(otherPath, 'omega\n')

    await read(context, rejectedPath)
    await read(context, otherPath)

    await FileEditTool.validateInput?.(
      {
        file_path: rejectedPath,
        old_string: 'absent',
        new_string: 'x',
        replace_all: false,
      },
      context as never,
    )

    const other = await read(context, otherPath)
    expect((other.data as { type: string }).type).toBe('file_unchanged')
  })
})
