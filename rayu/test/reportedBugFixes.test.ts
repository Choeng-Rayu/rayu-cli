// Regression tests for four reported bugs:
//   Bug 2 — a text-only model rejecting an image must produce a clear,
//           model-blame message instead of the raw provider 400.
//   Bug 3 — Read's per-call token cap must shrink as the context window fills,
//           and its overflow errors must carry actionable numbers.
//   Bug 4 — Edit's old_string matching must tolerate invisible/look-alike
//           characters and stray CRs, and must explain WHERE it diverged.
//   Bug 5 — the non-streaming fallback must never trip the Anthropic SDK's local
//           "Streaming is required…" guard.
import { APIError } from '@anthropic-ai/sdk/index.js'
import { describe, expect, test } from 'bun:test'
import {
  MAX_NON_STREAMING_TOKENS,
  SDK_NONSTREAMING_MAX_TOKENS,
  adjustParamsForNonStreaming,
  nonStreamingMaxTokensForClient,
} from '../src/services/api/claude.js'
import {
  classifyAPIError,
  isModelImageUnsupportedError,
  isNonStreamingTokenGuardError,
} from '../src/services/api/errors.js'
import {
  CONTEXT_RESERVE_TOKENS,
  MIN_ADAPTIVE_READ_TOKENS,
  clampReadTokensToRemainingContext,
} from '../src/tools/FileReadTool/contextBudget.js'
import {
  describeEditMismatch,
  findActualString,
} from '../src/tools/FileEditTool/utils.js'
import { FileEditTool } from '../src/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from '../src/tools/FileReadTool/FileReadTool.js'

/** Build the APIError shape the SDK produces for a provider 400. */
function apiError(status: number, message: string): APIError {
  return new APIError(status, undefined, message, undefined)
}

describe('Bug 2 — model does not support image input', () => {
  test('detects the Anthropic-Messages wording (DeepSeek / rayu-hosted)', () => {
    const err = apiError(
      400,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"this model does not support image input (ref: d2ab84d0)"}}',
    )
    expect(isModelImageUnsupportedError(err)).toBe(true)
    expect(classifyAPIError(err)).toBe('image_unsupported')
  })

  test('detects OpenAI-compatible wordings', () => {
    for (const message of [
      'model does not support images',
      'This model does not support vision',
      'vision is not supported for this model',
      'image input is not supported',
      'Invalid content type. image_url is only supported by certain models.',
    ]) {
      expect(isModelImageUnsupportedError(apiError(400, message))).toBe(true)
    }
  })

  test('does not misfire on size / dimension rejections', () => {
    const tooLarge = apiError(
      400,
      'image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes',
    )
    expect(isModelImageUnsupportedError(tooLarge)).toBe(false)
    expect(classifyAPIError(tooLarge)).toBe('image_too_large')

    const tooBig = apiError(
      400,
      'image dimensions exceed max allowed size for many-image requests',
    )
    expect(isModelImageUnsupportedError(tooBig)).toBe(false)
    expect(classifyAPIError(tooBig)).toBe('image_too_large')
  })

  test('does not misfire on unrelated unsupported-feature errors', () => {
    expect(
      isModelImageUnsupportedError(apiError(400, 'tool use is not supported')),
    ).toBe(false)
    expect(
      isModelImageUnsupportedError(apiError(400, 'prompt is too long')),
    ).toBe(false)
    expect(isModelImageUnsupportedError('not an error')).toBe(false)
  })
})

describe('Bug 3 — Read cap adapts to remaining context', () => {
  const ctx = (usedChars: number) => ({
    messages: [
      {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'x'.repeat(usedChars) },
      },
    ] as never,
    options: { mainLoopModel: 'claude-sonnet-4-5' } as never,
  })

  test('leaves the configured cap alone on a fresh conversation', () => {
    expect(clampReadTokensToRemainingContext(25_000, ctx(100))).toBe(25_000)
  })

  test('shrinks the cap as the transcript grows', () => {
    // ~4 chars/token heuristic: 400k chars ≈ 100k tokens used.
    const shrunk = clampReadTokensToRemainingContext(25_000, ctx(400_000))
    expect(shrunk).toBeLessThanOrEqual(25_000)
    expect(shrunk).toBeGreaterThanOrEqual(MIN_ADAPTIVE_READ_TOKENS)
  })

  test('never drops below the usable floor, even when over budget', () => {
    const huge = clampReadTokensToRemainingContext(
      25_000,
      ctx(CONTEXT_RESERVE_TOKENS * 400),
    )
    expect(huge).toBe(MIN_ADAPTIVE_READ_TOKENS)
  })

  test('degrades to no clamp for an unresolvable model', () => {
    expect(
      clampReadTokensToRemainingContext(25_000, {
        messages: [] as never,
        options: { mainLoopModel: '' } as never,
      }),
    ).toBe(25_000)
  })
})

describe('Bug 3 — tool prompts state the caps', () => {
  test('Read prompt names both caps and the offset/limit + Grep escape hatch', async () => {
    const prompt = await FileReadTool.prompt({} as never)
    expect(prompt).toContain('capped at')
    expect(prompt).toContain('use offset and limit to read slices')
    expect(prompt).toContain('Grep')
  })

  test('Edit prompt warns that large old_string blocks are the top failure mode', async () => {
    const prompt = await FileEditTool.prompt({} as never)
    expect(prompt).toContain('SMALLEST `old_string`')
    expect(prompt).toContain('String to replace not found in file')
  })
})

describe('Bug 4 — Edit old_string matching', () => {  test('matches through a no-break space the model could not see', () => {
    const file = 'const a = 1\nconst\u00A0b = 2\nconst c = 3\n'
    const found = findActualString(file, 'const b = 2')
    // Returns the FILE bytes (with the NBSP), not the normalized search text.
    expect(found).toBe('const\u00A0b = 2')
    expect(file.includes(found!)).toBe(true)
  })

  test('matches through zero-width characters', () => {
    const file = 'export function f\u200B() {\n  return 1\n}\n'
    expect(findActualString(file, 'export function f() {')).toBe(
      'export function f\u200B() {',
    )
  })

  test('matches when old_string carries stray CRs', () => {
    const file = 'line one\nline two\nline three\n'
    expect(findActualString(file, 'line one\r\nline two')).toBe(
      'line one\nline two',
    )
  })

  test('still returns null for a genuinely absent string', () => {
    expect(findActualString('alpha\nbeta\n', 'gamma')).toBeNull()
  })

  test('does not fold tabs into spaces (indentation stays significant)', () => {
    expect(findActualString('if x:\n\treturn 1\n', 'if x:\n    return 1')).toBeNull()
  })

  test('diagnostic names the first diverging line', () => {
    const file = ['function a() {', '  const x = 1', '  return x', '}'].join(
      '\n',
    )
    const attempted = ['function a() {', '  const x = 2', '  return x'].join(
      '\n',
    )
    const msg = describeEditMismatch(file, attempted)
    expect(msg).toContain('file line 1')
    expect(msg).toContain('const·x·=·1')
    expect(msg).toContain('const·x·=·2')
  })

  test('diagnostic calls out a whitespace-only difference', () => {
    const file = 'function a() {\n      return 1\n}'
    const attempted = 'function a() {\n  return 1\n}'
    const msg = describeEditMismatch(file, attempted)
    expect(msg).toContain('ONLY in indentation/whitespace')
  })

  test('diagnostic says so when the anchor line is absent entirely', () => {
    const msg = describeEditMismatch('alpha\nbeta\n', 'zeta\n')
    expect(msg).toContain('not in the file at all')
  })
})

describe('Bug 5 — non-streaming fallback token ceiling', () => {
  test('SDK ceiling matches the SDK arithmetic (10min at 128k tokens/hour)', () => {
    expect(SDK_NONSTREAMING_MAX_TOKENS).toBe(21_333)
  })

  test('full cap when the client carries a client-level timeout', () => {
    expect(nonStreamingMaxTokensForClient({ _options: { timeout: 600_000 } })).toBe(
      MAX_NON_STREAMING_TOKENS,
    )
  })

  test('SDK-safe cap when the client has no client-level timeout', () => {
    for (const client of [
      { _options: {} },
      { _options: { timeout: undefined } },
      {},
      null,
    ]) {
      expect(nonStreamingMaxTokensForClient(client)).toBe(
        SDK_NONSTREAMING_MAX_TOKENS,
      )
    }
  })

  test('a timeout-less client can never be sent a guard-tripping max_tokens', () => {
    const params = adjustParamsForNonStreaming(
      { max_tokens: 64_000 },
      nonStreamingMaxTokensForClient({ _options: {} }),
    )
    // The SDK throws when 60min * max_tokens / 128_000 > 10min.
    expect((60 * params.max_tokens) / 128_000).toBeLessThanOrEqual(10)
  })

  test('the guard error is recognized and classified', () => {
    const err = new Error(
      'Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details',
    )
    expect(isNonStreamingTokenGuardError(err)).toBe(true)
    expect(classifyAPIError(err)).toBe('nonstreaming_token_guard')
    expect(isNonStreamingTokenGuardError(new Error('Request timed out'))).toBe(
      false,
    )
  })
})
