import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autoCompactIfNeeded,
  getAutoCompactThreshold,
  shouldAutoCompact,
} from '../src/services/compact/autoCompact.js'
import * as compact from '../src/services/compact/compact.js'
import {
  resetSessionMemoryCompactConfig,
  trySessionMemoryCompaction,
} from '../src/services/compact/sessionMemoryCompact.js'
import * as sessionMemory from '../src/services/SessionMemory/sessionMemoryUtils.js'
import type { ToolUseContext } from '../src/Tool.js'
import type { Message } from '../src/types/message.js'
import { getGlobalConfig, saveGlobalConfig } from '../src/utils/config.js'
import type { CacheSafeParams } from '../src/utils/forkedAgent.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../src/utils/messages.js'
import * as memoryPressure from '../src/utils/memoryPressureGuard.js'
import {
  _resetRayuConfigCache,
  encodeModelWithProvider,
  upsertProvider,
} from '../src/utils/rayuConfig.js'
import * as sessionStart from '../src/utils/sessionStart.js'
import { tokenCountWithEstimation } from '../src/utils/tokens.js'

const MODEL = encodeModelWithProvider('compact-test', 'test-1m')
const ENV_KEYS = [
  'RAYU_CONFIG_DIR',
  'RAYU_AUTH_CONFIG_DIR',
  'RAYU_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'ENABLE_CLAUDE_CODE_SM_COMPACT',
  'DISABLE_CLAUDE_CODE_SM_COMPACT',
] as const

let dir: string
let previousEnv: Map<string, string | undefined>
let previousAutoCompact: boolean
let memorySpy: ReturnType<typeof spyOn<typeof sessionMemory, 'getSessionMemoryContent'>>
let hooksSpy: ReturnType<typeof spyOn<typeof sessionStart, 'processSessionStartHooks'>>
let heapSpy: ReturnType<typeof spyOn<typeof memoryPressure, 'getHeapPressure'>>

beforeEach(() => {
  previousEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'rayu-auto-compact-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  _resetRayuConfigCache()
  upsertProvider({
    id: 'compact-test',
    kind: 'openai-compatible',
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'test',
    modelContextWindows: { 'test-1m': 1_000_000 },
  })
  previousAutoCompact = getGlobalConfig().autoCompactEnabled
  saveGlobalConfig(config => ({ ...config, autoCompactEnabled: true }))
  resetSessionMemoryCompactConfig()
  sessionMemory.setLastSummarizedMessageId(undefined)
  memorySpy = spyOn(sessionMemory, 'getSessionMemoryContent').mockResolvedValue(
    '# Project progress\nThe user is investigating context compaction in the shared engine.',
  )
  hooksSpy = spyOn(sessionStart, 'processSessionStartHooks').mockResolvedValue([])
  heapSpy = spyOn(memoryPressure, 'getHeapPressure').mockReturnValue({
    heapUsed: 100_000_000, heapLimit: 1_000_000_000, isHigh: false,
  })
})

afterEach(() => {
  memorySpy.mockRestore()
  hooksSpy.mockRestore()
  heapSpy.mockRestore()
  sessionMemory.setLastSummarizedMessageId(undefined)
  resetSessionMemoryCompactConfig()
  saveGlobalConfig(config => ({ ...config, autoCompactEnabled: previousAutoCompact }))
  rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetRayuConfigCache()
})

function usageMessage(inputTokens: number, cachedTokens = 0): Message {
  const message = createAssistantMessage({ content: 'Working on the task.' })
  message.message.model = 'test-1m'
  message.message.usage.input_tokens = inputTokens
  message.message.usage.cache_read_input_tokens = cachedTokens
  return message
}

describe('automatic compaction on a 1M context window', () => {
  test.each([799, 800, 1_600])('%i records at about 10% usage keep their context', async count => {
    const messages = [
      usageMessage(2_000, 98_000),
      ...Array.from({ length: count - 1 }, () => createUserMessage({ content: 'ok' })),
    ]
    expect(tokenCountWithEstimation(messages)).toBeLessThan(110_000)
    expect(await shouldAutoCompact(messages, MODEL, 'sdk')).toBe(false)
  })

  test('the token threshold still triggers compaction, including cached input', async () => {
    const threshold = getAutoCompactThreshold(MODEL)
    expect(threshold).toBe(967_000)
    expect(await shouldAutoCompact([usageMessage(threshold - 1)], MODEL)).toBe(false)
    expect(await shouldAutoCompact([usageMessage(1_000, threshold - 1_000)], MODEL)).toBe(true)
  })

  test('measured heap pressure retains the emergency fallback for long histories', async () => {
    heapSpy.mockReturnValue({ heapUsed: 850_000_000, heapLimit: 1_000_000_000, isHigh: true })
    const messages = Array.from({ length: 800 }, () => createUserMessage({ content: 'ok' }))
    expect(await shouldAutoCompact(messages.slice(0, 799), MODEL)).toBe(false)
    expect(await shouldAutoCompact(messages, MODEL)).toBe(true)
  })

  test('emergency compaction records memory pressure instead of claiming context exhaustion', async () => {
    process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = '1'
    heapSpy.mockReturnValue({ heapUsed: 850_000_000, heapLimit: 1_000_000_000, isHigh: true })
    const result = await autoCompactIfNeeded(
      Array.from({ length: 800 }, () => createUserMessage({ content: 'ok' })),
      { options: { mainLoopModel: MODEL } } as ToolUseContext,
      {} as CacheSafeParams,
      'sdk',
    )
    expect(result.wasCompacted).toBe(true)
    const boundary = result.compactionResult?.boundaryMarker
    if (boundary?.subtype !== 'compact_boundary') throw new Error('Missing boundary')
    expect(boundary.compactMetadata.autoCompact).toMatchObject({
      reason: 'heap_pressure', heapUsed: 850_000_000, heapLimit: 1_000_000_000,
    })
  })

  test('new tool results count toward the threshold before the next API response', async () => {
    const messages = [
      usageMessage(getAutoCompactThreshold(MODEL) - 100),
      createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'data '.repeat(1_000) }],
      }),
    ]
    expect(await shouldAutoCompact(messages, MODEL)).toBe(true)
  })

  test.each(['compact', 'session_memory'] as const)('%s queries cannot recursively compact', async source => {
    expect(await shouldAutoCompact([usageMessage(990_000)], MODEL, source)).toBe(false)
  })

  test.each(['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT'] as const)('%s still disables automatic compaction', async key => {
    process.env[key] = '1'
    expect(await shouldAutoCompact([usageMessage(990_000)], MODEL)).toBe(false)
  })

  test('the user setting still disables automatic compaction', async () => {
    saveGlobalConfig(config => ({ ...config, autoCompactEnabled: false }))
    expect(await shouldAutoCompact([usageMessage(990_000)], MODEL)).toBe(false)
  })

  test('explicit window and percentage overrides still control the threshold', async () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '200000'
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
    expect(getAutoCompactThreshold(MODEL)).toBe(90_000)
    expect(await shouldAutoCompact([usageMessage(100_000)], MODEL)).toBe(true)
  })

  test('snipped tokens are subtracted before deciding to compact', async () => {
    expect(await shouldAutoCompact([usageMessage(970_000)], MODEL, 'sdk', 5_000)).toBe(false)
  })

  test('successful automatic compaction records its actual decision inputs', async () => {
    process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = '1'
    const messages = [usageMessage(970_000)]
    const result = await autoCompactIfNeeded(
      messages,
      { options: { mainLoopModel: MODEL } } as ToolUseContext,
      {} as CacheSafeParams,
      'sdk',
    )
    expect(result.wasCompacted).toBe(true)
    const boundary = result.compactionResult?.boundaryMarker
    expect(boundary?.subtype).toBe('compact_boundary')
    if (boundary?.subtype !== 'compact_boundary') throw new Error('Missing boundary')
    expect(boundary.compactMetadata.autoCompact).toEqual({
      reason: 'token_threshold',
      model: MODEL,
      contextWindow: 1_000_000,
      effectiveContextWindow: 980_000,
      threshold: 967_000,
      tokenCount: 970_000,
      messageCount: 1,
      querySource: 'sdk',
    })
    expect(JSON.parse(JSON.stringify(boundary)).compactMetadata.autoCompact)
      .toEqual(boundary.compactMetadata.autoCompact)
  })

  test('low-context histories do not request a summary or session-memory compaction', async () => {
    const result = await autoCompactIfNeeded(
      [usageMessage(100_000), ...Array.from({ length: 1_000 }, () => createUserMessage({ content: 'ok' }))],
      { options: { mainLoopModel: MODEL } } as ToolUseContext,
      {} as CacheSafeParams,
      'sdk',
    )
    expect(result).toEqual({ wasCompacted: false })
    expect(memorySpy).not.toHaveBeenCalled()
  })

  test('the legacy summary path records the same trigger inputs and resets failures', async () => {
    process.env.DISABLE_CLAUDE_CODE_SM_COMPACT = '1'
    const compactSpy = spyOn(compact, 'compactConversation').mockResolvedValue({
      boundaryMarker: createCompactBoundaryMessage('auto', 970_000),
      summaryMessages: [createUserMessage({ content: 'Summary of the task.' })],
      attachments: [],
      hookResults: [],
    })
    try {
      const result = await autoCompactIfNeeded(
        [usageMessage(970_000)],
        { options: { mainLoopModel: MODEL } } as ToolUseContext,
        {} as CacheSafeParams,
        'sdk',
        { compacted: false, turnCounter: 0, turnId: 'turn-1', consecutiveFailures: 2 },
      )
      expect(result.wasCompacted).toBe(true)
      expect(result.consecutiveFailures).toBe(0)
      const boundary = result.compactionResult?.boundaryMarker
      if (boundary?.subtype !== 'compact_boundary') throw new Error('Missing boundary')
      expect(boundary.compactMetadata.autoCompact).toMatchObject({
        reason: 'token_threshold', tokenCount: 970_000, threshold: 967_000,
      })
      expect(compactSpy).toHaveBeenCalledTimes(1)
    } finally {
      compactSpy.mockRestore()
    }
  })

  test('failed summaries still stop retrying after the third consecutive failure', async () => {
    process.env.DISABLE_CLAUDE_CODE_SM_COMPACT = '1'
    const compactSpy = spyOn(compact, 'compactConversation').mockRejectedValue(
      new Error(compact.ERROR_MESSAGE_USER_ABORT),
    )
    try {
      const context = { options: { mainLoopModel: MODEL } } as ToolUseContext
      const tracking = { compacted: false, turnCounter: 0, turnId: 'turn-1', consecutiveFailures: 2 }
      const failed = await autoCompactIfNeeded(
        [usageMessage(970_000)], context, {} as CacheSafeParams, 'sdk', tracking,
      )
      expect(failed).toEqual({ wasCompacted: false, consecutiveFailures: 3 })
      const skipped = await autoCompactIfNeeded(
        [usageMessage(970_000)], context, {} as CacheSafeParams, 'sdk',
        { ...tracking, consecutiveFailures: 3 },
      )
      expect(skipped).toEqual({ wasCompacted: false })
      expect(compactSpy).toHaveBeenCalledTimes(1)
    } finally {
      compactSpy.mockRestore()
    }
  })
})

describe('session-memory compaction metadata', () => {
  test('manual compaction is labelled manual and includes messages added after API usage', async () => {
    process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = '1'
    const messages = [usageMessage(100_000), createUserMessage({ content: 'Follow up '.repeat(500) })]
    const result = await trySessionMemoryCompaction(messages, undefined, undefined, MODEL)
    expect(result).not.toBeNull()
    const boundary = result?.boundaryMarker
    if (boundary?.subtype !== 'compact_boundary') throw new Error('Missing boundary')
    expect(boundary.compactMetadata.trigger).toBe('manual')
    expect(boundary.compactMetadata.preTokens).toBe(tokenCountWithEstimation(messages))
  })

  test('automatic session-memory compaction remains labelled auto', async () => {
    process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = '1'
    const result = await trySessionMemoryCompaction(
      [usageMessage(970_000)], undefined, getAutoCompactThreshold(MODEL), MODEL,
    )
    const boundary = result?.boundaryMarker
    if (boundary?.subtype !== 'compact_boundary') throw new Error('Missing boundary')
    expect(boundary.compactMetadata.trigger).toBe('auto')
  })
})
