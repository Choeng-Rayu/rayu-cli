import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { countTokensViaHaikuFallback } from '../src/services/tokenEstimation.ts'
import { isRayuHostedActive } from '../src/utils/model/providers.ts'
import { loadRayuConfig, saveRayuConfig } from '../src/utils/rayuConfig.ts'

// REGRESSION: /context is the CLI counting its OWN context, and on the hosted
// path that bookkeeping used to be billed to the user.
//
// The chain was: the gateway had no POST /anthropic/v1/messages/count_tokens, so
// the SDK's countTokens() 404'd; the CLI then fell back to "count by asking the
// model", i.e. a REAL max_tokens=1 completion per context section (~20 of them).
// Those requests charged credits and saturated the plan's concurrency cap, so the
// gateway answered 429 and /context failed while the user paid for it.
//
// The gateway now answers count_tokens locally and for free. This test guards the
// OTHER half: even when that endpoint is unavailable (older gateway, transient
// failure), the CLI must degrade to a LOCAL estimate rather than spend credits.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-count-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

function useProvider(kind: 'rayu-hosted' | 'anthropic-compatible'): void {
  const cfg = loadRayuConfig()
  cfg.providers = [
    {
      id: kind === 'rayu-hosted' ? 'rayu-hosted' : 'longcat',
      kind,
      baseURL: 'http://127.0.0.1:1/v1', // unreachable: a real call would fail loudly
      models: ['m1'],
      defaultModel: 'm1',
      ...(kind === 'anthropic-compatible' ? { apiKey: 'sk-byo' } : {}),
    },
  ]
  cfg.activeProvider = cfg.providers[0]!.id
  saveRayuConfig(cfg)
}

describe('token counting never bills the hosted user', () => {
  test('isRayuHostedActive tracks the active provider kind', () => {
    useProvider('rayu-hosted')
    expect(isRayuHostedActive()).toBe(true)

    useProvider('anthropic-compatible')
    expect(isRayuHostedActive()).toBe(false)
  })

  test('the billed haiku fallback is refused on the hosted path', async () => {
    useProvider('rayu-hosted')
    // Returning null means "no count available" — callers then use the local
    // heuristic. Anything else here would be a network call the user pays for;
    // the base URL is unroutable, so a real attempt would hang or throw instead
    // of resolving to null.
    const result = await countTokensViaHaikuFallback(
      [{ role: 'user', content: 'how many tokens is this' }],
      [],
    )
    expect(result).toBeNull()
  })
})
