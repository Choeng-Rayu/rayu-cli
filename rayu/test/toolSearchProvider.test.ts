// Regression: tool search (deferred-tool loading via tool_reference /
// defer_loading) must be DISABLED for Rayu third-party providers, because their
// upstreams don't accept that Anthropic beta. When it was wrongly enabled,
// deferred tools (WebFetch, TaskUpdate, WebSearch, LSP, TodoWrite, all Task/Plan
// tools…) were withheld but never discoverable, so the model called them blind
// and guessed parameters (e.g. task_id vs taskId, missing prompt) → the
// client-side validator rejected the call with "this tool's schema was not sent".
//
// The trap this locks in: getAPIProvider() returns 'anthropic' (default
// fall-through) for kind:'anthropic-compatible', and its baseURL is set on the
// SDK client — NOT via ANTHROPIC_BASE_URL — so isFirstPartyAnthropicBaseUrl()
// returns true and the old proxy guard could not catch it.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-tsprov-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.ENABLE_TOOL_SEARCH
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  delete process.env.RAYU_OPENAI_COMPATIBLE
  delete process.env.ANTHROPIC_BASE_URL
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.ENABLE_TOOL_SEARCH
  delete process.env.RAYU_OPENAI_COMPATIBLE
})

async function freshCfg() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  return cfg
}

describe('tool search disabled for Rayu third-party providers', () => {
  test('anthropic-compatible active (e.g. Ollama Cloud / rayu-hosted) → tool search OFF', async () => {
    const cfg = await freshCfg()
    const providers = await import('../src/utils/model/providers.ts')
    const { isToolSearchEnabledOptimistic } = await import(
      '../src/utils/toolSearch.ts'
    )
    cfg.upsertProvider(
      {
        id: 'ollama-cloud',
        kind: 'anthropic-compatible',
        apiKey: 'test-key',
        baseURL: 'https://gw.example/anthropic',
        defaultModel: 'kimi-k2.7',
      },
      true,
    )
    // Sanity: the exact trap — reports 'anthropic' + first-party despite being a proxy.
    expect(providers.isRayuAnthropicCompatibleActive()).toBe(true)
    expect(providers.getAPIProvider()).toBe('anthropic')
    expect(providers.isFirstPartyAnthropicBaseUrl()).toBe(true)
    // The fix: tool search is off, so ALL tool schemas are sent inline.
    expect(isToolSearchEnabledOptimistic()).toBe(false)
  })

  test('escape hatch: ENABLE_TOOL_SEARCH=true re-enables it for anthropic-compatible', async () => {
    const cfg = await freshCfg()
    const { isToolSearchEnabledOptimistic } = await import(
      '../src/utils/toolSearch.ts'
    )
    cfg.upsertProvider(
      {
        id: 'ollama-cloud',
        kind: 'anthropic-compatible',
        apiKey: 'k',
        baseURL: 'https://gw.example/anthropic',
        defaultModel: 'kimi-k2.7',
      },
      true,
    )
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })

  test('openai-compatible active → tool search OFF', async () => {
    await freshCfg()
    const { isToolSearchEnabledOptimistic } = await import(
      '../src/utils/toolSearch.ts'
    )
    // RAYU_OPENAI_COMPATIBLE=1 forces isOpenAICompatibleActive() true.
    process.env.RAYU_OPENAI_COMPATIBLE = '1'
    expect(isToolSearchEnabledOptimistic()).toBe(false)
  })

  test('first-party Anthropic (no third-party provider) → tool search stays ON', async () => {
    const cfg = await freshCfg()
    const { isToolSearchEnabledOptimistic } = await import(
      '../src/utils/toolSearch.ts'
    )
    cfg.upsertProvider(
      {
        id: 'anthropic',
        kind: 'anthropic',
        apiKey: 'sk-ant-test',
        defaultModel: 'claude-sonnet-4-6',
      },
      true,
    )
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })
})
