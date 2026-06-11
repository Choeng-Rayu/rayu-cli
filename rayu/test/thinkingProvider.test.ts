import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  modelSupportsThinking,
  modelSupportsAdaptiveThinking,
  shouldEnableThinkingByDefault,
} from '../src/utils/thinking.ts'

// These tests drive the provider logic purely via env vars so they don't depend
// on the machine's ~/.rayu config:
//  - RAYU_OPENAI_COMPATIBLE=1 forces isOpenAICompatibleActive() on.
//  - RAYU_USE_BEDROCK=1 makes getAPIProvider() return 'bedrock' (non-anthropic),
//    which both disables the openai-compatible branch and enables the
//    get3PModelCapabilityOverride env path.
const ENV_KEYS = [
  'RAYU_OPENAI_COMPATIBLE',
  'RAYU_USE_BEDROCK',
  'MAX_THINKING_TOKENS',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('non-Claude reasoning models support thinking on a rayu OpenAI-compatible provider', () => {
  process.env.RAYU_OPENAI_COMPATIBLE = '1'
  // Names that are NOT Claude — false under the legacy Claude-only 3P path.
  expect(modelSupportsThinking('deepseek-ai/deepseek-r1')).toBe(true)
  expect(modelSupportsThinking('meta/llama-3.3-70b-instruct')).toBe(true)
  expect(modelSupportsAdaptiveThinking('deepseek-ai/deepseek-r1')).toBe(true)
})

test('explicit 3P capability override takes precedence over the rayu provider branch', () => {
  // Bedrock (non-anthropic) enables the override path; capabilities omit
  // 'thinking' and 'adaptive_thinking', so the override must win and return
  // false even though a rayu provider is active.
  process.env.RAYU_USE_BEDROCK = '1'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'thinkprov-test-model'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort'
  expect(modelSupportsThinking('thinkprov-test-model')).toBe(false)
  expect(modelSupportsAdaptiveThinking('thinkprov-test-model')).toBe(false)
})

test('MAX_THINKING_TOKENS numeric values control the default', () => {
  process.env.MAX_THINKING_TOKENS = '5000'
  expect(shouldEnableThinkingByDefault()).toBe(true)
  process.env.MAX_THINKING_TOKENS = '0'
  expect(shouldEnableThinkingByDefault()).toBe(false)
  process.env.MAX_THINKING_TOKENS = '-1'
  expect(shouldEnableThinkingByDefault()).toBe(false)
})

test('malformed MAX_THINKING_TOKENS is treated as unset (falls through to default)', () => {
  delete process.env.MAX_THINKING_TOKENS
  const whenUnset = shouldEnableThinkingByDefault()
  process.env.MAX_THINKING_TOKENS = 'not-a-number'
  // Must not force-disable on garbage input — same result as if unset.
  expect(shouldEnableThinkingByDefault()).toBe(whenUnset)
})
