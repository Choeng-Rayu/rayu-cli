/**
 * A side query (session search, permission explainer, model validation, ...) is a
 * billed request on the Rayu gateway too, so its charge counts toward the turn's
 * "Credits:" line. Driven in-process through the real `sideQuery` and the real
 * provider client, against a local endpoint that answers like the gateway.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  markRayuCharges,
  rayuCreditsSince,
} from '../src/services/rayuAuth/rayuTurnCredits.ts'
import { _resetRayuConfigCache, loadRayuConfig, saveRayuConfig } from '../src/utils/rayuConfig.ts'
import { sideQuery } from '../src/utils/sideQuery.ts'

let server: ReturnType<typeof Bun.serve>
let charge: Record<string, unknown> | undefined
let dir: string
const savedConfigDir = process.env.RAYU_CONFIG_DIR
const savedOAuth = process.env.USE_RAYU_OAUTH

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/v1/messages')) return new Response('', { status: 404 })
      const body = (await req.json()) as { model: string }
      return Response.json({
        id: 'msg_side', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 1 },
        ...(charge && { rayu: charge }),
      })
    },
  })
})

afterAll(() => server.stop(true))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-side-charge-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.USE_RAYU_OAUTH = 'false'
  _resetRayuConfigCache()
  const cfg = loadRayuConfig()
  cfg.providers = [{
    id: 'fixture',
    kind: 'anthropic-compatible',
    baseURL: server.url.origin,
    apiKey: 'fixture-key',
    models: ['test-model'],
    defaultModel: 'test-model',
  }]
  cfg.activeProvider = 'fixture'
  saveRayuConfig(cfg)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  if (savedOAuth === undefined) delete process.env.USE_RAYU_OAUTH
  else process.env.USE_RAYU_OAUTH = savedOAuth
  _resetRayuConfigCache()
})

const ask = () =>
  sideQuery({
    querySource: 'model_validation',
    model: 'test-model',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Hi' }],
  })

test('a charged side query counts toward the turn', async () => {
  charge = { billableTokens: 80, tokensPerCredit: 1000, credits: 0.08 }
  const mark = markRayuCharges()
  await ask()
  expect(rayuCreditsSince(mark)).toBe(0.08)
})

test('a side query that reports no charge adds nothing', async () => {
  charge = undefined
  const mark = markRayuCharges()
  await ask()
  expect(rayuCreditsSince(mark)).toBeUndefined()
})
