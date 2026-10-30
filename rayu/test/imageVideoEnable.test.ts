import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ENV = ['NVIDIA_API_KEY', 'FAL_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_VERTEX_PROJECT_ID']
let dir: string
let saved: Record<string, string | undefined>
let savedAuthDir: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-enable-'))
  process.env.RAYU_CONFIG_DIR = dir
  // Hosted image/video availability reads rayu-auth.json from
  // RAYU_AUTH_CONFIG_DIR (which outranks RAYU_CONFIG_DIR). Isolate it too, so a
  // developer's real signed-in session cannot flip the "nothing configured" case.
  savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  saved = {}
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function tools() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  const { ImageGenTool, _resetRayuImageAvailabilityForTesting } = await import(
    '../src/tools/ImageGenTool/ImageGenTool.ts'
  )
  const { VideoGenTool, _resetRayuVideoAvailabilityForTesting } = await import(
    '../src/tools/VideoGenTool/VideoGenTool.ts'
  )
  // The availability verdicts are memoized briefly; forget them so each test
  // starts from its own env/auth state.
  _resetRayuImageAvailabilityForTesting()
  _resetRayuVideoAvailabilityForTesting()
  return { ImageGenTool, VideoGenTool }
}

describe('image/video tools isEnabled truth table', () => {
  test('nothing configured -> disabled', async () => {
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(false)
    expect(VideoGenTool.isEnabled()).toBe(false)
  })

  test('NVIDIA key only -> disabled (NVIDIA image/video generation was removed)', async () => {
    process.env.NVIDIA_API_KEY = 'nv-key'
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(false)
    expect(VideoGenTool.isEnabled()).toBe(false)
  })

  test('fal key only -> video enabled, image not (fal serves video only)', async () => {
    process.env.FAL_KEY = 'fal-key'
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(false)
    expect(VideoGenTool.isEnabled()).toBe(true)
  })

  test('Vertex only -> enabled', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'proj'
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(VideoGenTool.isEnabled()).toBe(true)
  })

  test('NVIDIA + Vertex -> enabled by Vertex', async () => {
    process.env.NVIDIA_API_KEY = 'nv-key'
    process.env.GOOGLE_CLOUD_PROJECT = 'proj'
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(VideoGenTool.isEnabled()).toBe(true)
  })

  test('signed in to Rayu with NO keys -> enabled (hosted models need no key)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    try {
      const sess = await import('../src/services/rayuAuth/rayuSession.ts')
      sess.writeRayuSession({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3600_000,
        user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'user' },
      })
      const { ImageGenTool, VideoGenTool } = await tools()
      expect(ImageGenTool.isEnabled()).toBe(true)
      expect(VideoGenTool.isEnabled()).toBe(true)
    } finally {
      delete process.env.USE_RAYU_OAUTH
    }
  })

  test('signed-out again -> disabled (availability memo cannot outlive the session)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    try {
      const sess = await import('../src/services/rayuAuth/rayuSession.ts')
      sess.writeRayuSession({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3600_000,
        user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'user' },
      })
      const { ImageGenTool, VideoGenTool } = await tools()
      expect(ImageGenTool.isEnabled()).toBe(true)
      rmSync(join(dir, 'rayu-auth.json'), { force: true })
      // Forget the memoized verdict exactly like /logout would in a fresh process.
      const { _resetRayuImageAvailabilityForTesting } = await import(
        '../src/tools/ImageGenTool/ImageGenTool.ts'
      )
      const { _resetRayuVideoAvailabilityForTesting } = await import(
        '../src/tools/VideoGenTool/VideoGenTool.ts'
      )
      _resetRayuImageAvailabilityForTesting()
      _resetRayuVideoAvailabilityForTesting()
      expect(ImageGenTool.isEnabled()).toBe(false)
      expect(VideoGenTool.isEnabled()).toBe(false)
    } finally {
      delete process.env.USE_RAYU_OAUTH
    }
  })
})
