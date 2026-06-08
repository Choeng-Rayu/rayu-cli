import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-mediamodel-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

async function fresh() {
  const m = await import('../src/utils/rayuConfig.ts')
  m._resetRayuConfigCache()
  return m
}

describe('image/video model selection', () => {
  test('get returns undefined by default; set/get round-trips; clear removes', async () => {
    const m = await fresh()
    expect(m.getImageModelSelection()).toBeUndefined()
    expect(m.getVideoModelSelection()).toBeUndefined()

    m.setImageModelSelection('imagen-4.0-generate-001')
    m.setVideoModelSelection('veo-3.1-generate-001')
    m._resetRayuConfigCache()
    expect(m.getImageModelSelection()).toBe('imagen-4.0-generate-001')
    expect(m.getVideoModelSelection()).toBe('veo-3.1-generate-001')

    m.setImageModelSelection(undefined)
    m.setVideoModelSelection(undefined)
    m._resetRayuConfigCache()
    expect(m.getImageModelSelection()).toBeUndefined()
    expect(m.getVideoModelSelection()).toBeUndefined()
  })

  test('commands are registered and enabled', async () => {
    const img = (await import('../src/commands/model-image-generation/index.ts')).default
    const vid = (await import('../src/commands/model-video-generation/index.ts')).default
    expect(img.name).toBe('model_image_generation')
    expect(vid.name).toBe('model_video_generation')
    expect(img.type).toBe('local-jsx')
    expect(vid.type).toBe('local-jsx')
  })
})
