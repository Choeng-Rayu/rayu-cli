import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Steering: paid features (subagent_model, collaborator_swarm, collaborator_model,
// telegram, image/video) stay VISIBLE as slash commands for everyone, but a Free
// user who runs one is shown an upgrade notice instead of it executing; paid /
// entitled users (and the BYOK / OAuth-off path) run them as usual.
//
// These tests lock in (a) that each command declares the correct admin-configured
// paidFeature key, and (b) the soft-gate predicate the dispatcher uses —
// `paidFeature && isPaidFeatureLocked(paidFeature)` — resolves correctly per plan.

// Command module → expected admin entitlement key.
const PAID_COMMANDS: Array<{ path: string; feature: string }> = [
  { path: '../src/commands/model-subagent/index.ts', feature: 'subagent_model' },
  { path: '../src/commands/collaborator-model/index.ts', feature: 'collaborator_model' },
  { path: '../src/commands/collaborator-swarm/index.ts', feature: 'collaborator_swarm' },
  { path: '../src/commands/telegram-bot/index.ts', feature: 'telegram' },
  { path: '../src/commands/generate-image.ts', feature: 'image_generation' },
  { path: '../src/commands/image-editor.ts', feature: 'image_generation' },
  { path: '../src/commands/image-video.ts', feature: 'video_generation' },
]

const ent = (features: Record<string, { enabled: boolean }>) => ({
  plan: { code: 'x', name: 'X', priceCents: 0, availability: 'active' },
  maxDailyTurns: null,
  features,
})

describe('paid command soft-gating (declared paidFeature keys)', () => {
  test('each paid command declares the correct admin-configured feature key', async () => {
    for (const { path, feature } of PAID_COMMANDS) {
      const cmd = (await import(path)).default as { paidFeature?: string }
      expect(cmd.paidFeature).toBe(feature)
    }
  })
})

describe('paid command soft-gate decision (dispatcher predicate)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-paidcmd-'))
    process.env.RAYU_CONFIG_DIR = dir
    delete process.env.USE_RAYU_OAUTH
  })
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.USE_RAYU_OAUTH
    ;(
      await import('../src/services/rayuAuth/rayuEntitlements.ts')
    )._resetRayuEntitlementsForTesting()
  })

  // The dispatcher runs: command.paidFeature && isPaidFeatureLocked(command.paidFeature)
  async function locked(feature: string): Promise<boolean> {
    const { isPaidFeatureLocked } = await import(
      '../src/services/rayuAuth/paidFeatureGate.ts'
    )
    return isPaidFeatureLocked(feature)
  }
  async function ents() {
    return await import('../src/services/rayuAuth/rayuEntitlements.ts')
  }

  test('OAuth OFF (BYOK) -> no command is gated (all run as usual)', async () => {
    for (const { feature } of PAID_COMMANDS) {
      expect(await locked(feature)).toBe(false)
    }
  })

  test('Free plan (all features disabled) -> every paid command is gated -> upgrade notice', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(
      ent({
        subagent_model: { enabled: false },
        collaborator_model: { enabled: false },
        collaborator_swarm: { enabled: false },
        telegram: { enabled: false },
        image_generation: { enabled: false },
        video_generation: { enabled: false },
      }),
    )
    for (const { feature } of PAID_COMMANDS) {
      expect(await locked(feature)).toBe(true)
    }
  })

  test('Paid plan (all features enabled) -> no paid command is gated -> runs as usual', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(
      ent({
        subagent_model: { enabled: true },
        collaborator_model: { enabled: true },
        collaborator_swarm: { enabled: true },
        telegram: { enabled: true },
        image_generation: { enabled: true },
        video_generation: { enabled: true },
      }),
    )
    for (const { feature } of PAID_COMMANDS) {
      expect(await locked(feature)).toBe(false)
    }
  })
})
