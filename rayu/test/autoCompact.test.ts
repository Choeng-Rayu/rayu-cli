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
  'RAYU_MEDIA_COMPACT_BUDGET_BYTES',
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

// A user message carrying a base64 image of `base64Bytes` wire bytes — the
// shape a pasted screenshot takes. Its token estimate is a flat 2000 regardless
// of byte size, which is exactly why the byte-based trigger is needed.
function imageMessage(base64Bytes: number): Message {
  return createUserMessage({
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(base64Bytes) },
      },
    ],
  })
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

  test('accumulated media bytes trigger compaction even when the token count is low', async () => {
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = String(4 * 1024 * 1024)
    // Three ~1.5MB images in EARLIER turns = ~4.5MB, over the 4MB budget — yet
    // the token estimate scores them as a flat 2000 each (~6k tokens), nowhere
    // near the 967k threshold. Token-only compaction would never fire. The
    // trailing text user turn is the current prompt; the images precede it, so
    // they are "accumulated".
    const messages = [
      usageMessage(10_000),
      imageMessage(1_500_000),
      imageMessage(1_500_000),
      imageMessage(1_500_000),
      createUserMessage({ content: 'please continue' }),
    ]
    expect(tokenCountWithEstimation(messages)).toBeLessThan(getAutoCompactThreshold(MODEL))
    expect(await shouldAutoCompact(messages, MODEL)).toBe(true)
  })

  test('media under the byte budget does not trigger compaction', async () => {
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = String(4 * 1024 * 1024)
    const messages = [
      usageMessage(10_000),
      imageMessage(1_000_000),
      createUserMessage({ content: 'next' }),
    ]
    expect(await shouldAutoCompact(messages, MODEL)).toBe(false)
  })

  test('a large fresh paste in the current turn alone does not trigger compaction', async () => {
    // The images ARE the last user turn — a just-pasted batch. Compaction would
    // summarize them away (and its summary request strips images) before the
    // model ever saw them, so accumulated-only must NOT trigger here.
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = String(4 * 1024 * 1024)
    const messages = [usageMessage(10_000), imageMessage(6_000_000)]
    expect(await shouldAutoCompact(messages, MODEL)).toBe(false)
  })

  test('media-byte compaction records the byte trigger, not a token or heap reason', async () => {
    // Use the legacy full-compaction path (the production default — SM-compact
    // is off unless tengu_session_memory/tengu_sm_compact are on) and spy the
    // summarizer so no network call happens.
    process.env.DISABLE_CLAUDE_CODE_SM_COMPACT = '1'
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = String(4 * 1024 * 1024)
    const compactSpy = spyOn(compact, 'compactConversation').mockResolvedValue({
      boundaryMarker: createCompactBoundaryMessage('auto', 40_000),
      summaryMessages: [createUserMessage({ content: 'Summary.' })],
      attachments: [],
      hookResults: [],
    })
    try {
      const result = await autoCompactIfNeeded(
        [
          usageMessage(10_000),
          imageMessage(1_500_000),
          imageMessage(1_500_000),
          imageMessage(1_500_000),
          createUserMessage({ content: 'continue' }),
        ],
        { options: { mainLoopModel: MODEL } } as ToolUseContext,
        {} as CacheSafeParams,
        'sdk',
      )
      expect(result.wasCompacted).toBe(true)
      const boundary = result.compactionResult?.boundaryMarker
      if (boundary?.subtype !== 'compact_boundary') throw new Error('Missing boundary')
      expect(boundary.compactMetadata.autoCompact).toMatchObject({
        reason: 'media_bytes',
        mediaBudget: 4 * 1024 * 1024,
      })
      const decision = boundary.compactMetadata.autoCompact
      if (decision?.reason !== 'media_bytes') throw new Error('Expected media_bytes reason')
      expect(decision.mediaBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024)
    } finally {
      compactSpy.mockRestore()
    }
  })

  test('media_bytes falls back to full compaction when the session-memory tail still exceeds the budget', async () => {
    // SM-compact keeps a verbatim tail (messagesToKeep), NOT image-stripped. If
    // that tail is image-heavy it stays over the byte budget, so accepting it
    // would re-compact every turn without fixing the 413. The guard must reject
    // it and fall through to legacy full compaction (which keeps nothing).
    process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = '1'
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = String(4 * 1024 * 1024)
    const lead = usageMessage(10_000)
    const messages = [
      lead,
      imageMessage(1_500_000),
      imageMessage(1_500_000),
      imageMessage(1_500_000),
      createUserMessage({ content: 'continue' }),
    ]
    // Point the summarized boundary at the FIRST message so the kept tail is
    // everything after it — i.e. all three images survive into messagesToKeep.
    sessionMemory.setLastSummarizedMessageId(lead.uuid)
    const compactSpy = spyOn(compact, 'compactConversation').mockResolvedValue({
      boundaryMarker: createCompactBoundaryMessage('auto', 40_000),
      summaryMessages: [createUserMessage({ content: 'Summary.' })],
      attachments: [],
      hookResults: [],
    })
    try {
      const result = await autoCompactIfNeeded(
        messages,
        { options: { mainLoopModel: MODEL } } as ToolUseContext,
        {} as CacheSafeParams,
        'sdk',
      )
      expect(result.wasCompacted).toBe(true)
      // Fell back to full compaction rather than accepting the ineffective SM tail.
      expect(compactSpy).toHaveBeenCalledTimes(1)
      const boundary = result.compactionResult?.boundaryMarker
      if (boundary?.subtype !== 'compact_boundary') throw new Error('Missing boundary')
      expect(boundary.compactMetadata.autoCompact).toMatchObject({ reason: 'media_bytes' })
    } finally {
      compactSpy.mockRestore()
    }
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
