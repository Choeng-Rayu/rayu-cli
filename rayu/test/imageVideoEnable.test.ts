import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ENV = ['NVIDIA_API_KEY', 'FAL_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_VERTEX_PROJECT_ID']
let dir: string
let saved: Record<string, string | undefined>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-enable-'))
  process.env.RAYU_CONFIG_DIR = dir
  saved = {}
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function tools() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  const { ImageGenTool } = await import('../src/tools/ImageGenTool/ImageGenTool.ts')
  const { VideoGenTool } = await import('../src/tools/VideoGenTool/VideoGenTool.ts')
  return { ImageGenTool, VideoGenTool }
}

describe('image/video tools isEnabled truth table', () => {
  test('neither NVIDIA nor Vertex -> disabled', async () => {
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(false)
    expect(VideoGenTool.isEnabled()).toBe(false)
  })

  test('NVIDIA only -> enabled', async () => {
    process.env.NVIDIA_API_KEY = 'nv-key'
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(VideoGenTool.isEnabled()).toBe(true)
  })

  test('Vertex only -> enabled', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'proj'
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(VideoGenTool.isEnabled()).toBe(true)
  })

  test('both -> enabled', async () => {
    process.env.NVIDIA_API_KEY = 'nv-key'
    process.env.GOOGLE_CLOUD_PROJECT = 'proj'
    const { ImageGenTool, VideoGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(VideoGenTool.isEnabled()).toBe(true)
  })
})
