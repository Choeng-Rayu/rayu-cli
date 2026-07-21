import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// End-to-end model-fidelity: the model the user SELECTS must be the model that
// actually goes on the wire (and in the gateway headers), EVEN when a malicious
// family-crossing modelOverride is present. This composes the real pieces:
//   Task 1 (resolution drops the bad override) + Task 2 (routing fetch emits the
//   authoritative resolved/canonical + intended headers) + the shared
//   modelFamilyOf rule the gateway enforces.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-fidelity-e2e-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  process.env.USE_RAYU_OAUTH = 'true'
  process.env.RAYU_GATEWAY_URL = 'https://gw.example.test'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.USE_RAYU_OAUTH
  delete process.env.RAYU_GATEWAY_URL
})

async function setup() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  const state = await import('../src/bootstrap/state.ts')
  state.resetModelStringsForTestingOnly()
  const ms = await import('../src/utils/model/modelStrings.ts')
  ms._resetModelOverrideFidelityWarningsForTesting()
  const sess = await import('../src/services/rayuAuth/rayuSession.ts')
  sess.writeRayuSession({
    accessToken: 'rayu-jwt',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3600_000,
    user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'user' },
  })
  cfg.upsertProvider(
    {
      id: 'bedrock-anthropic',
      kind: 'bedrock',
      bedrockApi: 'anthropic',
      apiKey: 'bearer',
      awsRegion: 'us-east-1',
    } as never,
    true,
  )
}

describe('end-to-end model fidelity (Bedrock, malicious Sonnet->Opus override present)', () => {
  test('a Sonnet selection routes a Sonnet wire model — selected === routed', async () => {
    await setup()
    const s = await import('../src/utils/settings/settings.ts')
    // Malicious override: Sonnet key -> Opus value. Task 1 must drop it.
    s.updateSettingsForSource('userSettings', {
      modelOverrides: { 'claude-sonnet-4-6': 'us.anthropic.claude-opus-4-6-v1' },
    })

    const { getModelStrings } = await import('../src/utils/model/modelStrings.ts')
    const { getCanonicalName } = await import('../src/utils/model/model.ts')
    const { modelFamilyOf } = await import('../src/utils/model/configs.ts')

    // The resolved Sonnet wire id must NOT be an Opus id.
    const wire = getModelStrings().sonnet46
    expect(modelFamilyOf(wire)).toBe('sonnet')
    expect(wire).not.toContain('opus')

    // The Bedrock SDK would build this URL from the wire id.
    const url = `https://bedrock-runtime.us-east-1.amazonaws.com/model/${wire}/invoke-with-response-stream`
    const intended = getCanonicalName(wire) // 'claude-sonnet-4-6'

    const { makeGatewayRoutingFetch } = await import(
      '../src/services/api/rayuHosted/gatewayRouting.ts'
    )
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const inner = (async (u: unknown, init: RequestInit | undefined) => {
      calls.push({ url: String(u), init })
      return new Response('{}', { status: 200, headers: { 'x-rayu-proxied': '1' } })
    }) as unknown as typeof fetch

    const provider = (await import('../src/utils/rayuConfig.ts')).getActiveProvider()
    await makeGatewayRoutingFetch(provider as never, inner)(url, {
      method: 'POST',
      headers: { 'x-rayu-intended-model': intended },
      body: '{"max_tokens":1,"messages":[],"anthropic_version":"bedrock-2023-05-31"}',
    })

    const h = new Headers(calls[0].init?.headers)
    const resolved = h.get('x-rayu-resolved-model') ?? ''
    const canonical = h.get('x-rayu-canonical-model') ?? ''
    const sentIntended = h.get('x-rayu-intended-model') ?? ''

    // The gateway sees a Sonnet-family resolved model — matching the intent.
    expect(modelFamilyOf(resolved)).toBe('sonnet')
    expect(canonical).toBe('claude-sonnet-4-6')
    expect(sentIntended).toBe('claude-sonnet-4-6')
    // The gateway's fidelity rule (same modelFamilyOf) would NOT flag a mismatch.
    expect(modelFamilyOf(resolved)).toBe(modelFamilyOf(sentIntended))
  })
})
