// The image/video model pickers' presentation layer, shared by the terminal
// pickers and the Rayucode chooser: order, labels, caveats, and the on-open
// live fetch that makes an admin's change visible without a release.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetMediaModelsForTesting,
  type MediaCatalog,
  type MediaModelEntry,
} from '../src/services/rayuAuth/mediaModels.ts'
import {
  describeMediaModel,
  loadMediaModelPicker,
  mediaBackendLabel,
  mediaCatalogNotice,
  mediaModelPickerOptions,
  orderMediaModelsForPicker,
} from '../src/services/rayuAuth/mediaModelPicker.ts'

const WAN_IMAGE: MediaModelEntry = {
  id: 'rayu-wan2.7-image',
  label: 'Wan 2.7 Image',
  mediaType: 'image',
  capabilities: ['generate', 'edit'],
  backend: 'rayu',
  family: 'dashscope_multimodal',
}
const WAN_IMAGE_PRO: MediaModelEntry = {
  ...WAN_IMAGE,
  id: 'rayu-wan2.7-image-pro',
  label: 'Wan 2.7 Image Pro',
}
const IMAGEN: MediaModelEntry = {
  id: 'imagen-4.0-generate-001',
  label: 'Imagen 4',
  mediaType: 'image',
  capabilities: ['generate'],
  backend: 'vertex',
  family: 'imagen',
  isDefault: true,
}
const KLING: MediaModelEntry = {
  id: 'fal-ai/kling-video/v2.1/standard/text-to-video',
  label: 'fal-ai/kling-video/v2.1/standard/text-to-video',
  mediaType: 'video',
  capabilities: ['text2video'],
  backend: 'fal',
  family: 'fal-kling',
}
const WAN_VIDEO: MediaModelEntry = {
  id: 'rayu-wan3-video-480p',
  label: 'Wan 3.0 Video 480P',
  mediaType: 'video',
  capabilities: ['text2video'],
  backend: 'rayu',
  family: 'dashscope_video',
}

function catalogOf(
  image: MediaModelEntry[],
  video: MediaModelEntry[] = [],
  source: MediaCatalog['source'] = 'gateway',
): MediaCatalog {
  return { image, video, source, fetchedAt: Date.now() }
}

/** A gateway row as GET /v1/models?media=all serves it. */
function wire(entry: MediaModelEntry): Record<string, unknown> {
  return { ...entry, object: 'model', default: entry.isDefault === true }
}

const realFetch = globalThis.fetch
let cfgDir: string
let savedConfigDir: string | undefined
let savedAuthDir: string | undefined
let savedOAuth: string | undefined

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'rayu-mediapicker-'))
  savedConfigDir = process.env.RAYU_CONFIG_DIR
  savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
  savedOAuth = process.env.USE_RAYU_OAUTH
  process.env.RAYU_CONFIG_DIR = cfgDir
  process.env.RAYU_AUTH_CONFIG_DIR = cfgDir
  delete process.env.USE_RAYU_OAUTH
  _resetMediaModelsForTesting()
})

afterEach(() => {
  globalThis.fetch = realFetch
  _resetMediaModelsForTesting()
  rmSync(cfgDir, { recursive: true, force: true })
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
  if (savedOAuth === undefined) delete process.env.USE_RAYU_OAUTH
  else process.env.USE_RAYU_OAUTH = savedOAuth
})

/** A session the catalog fetch accepts without a token refresh. */
function stubSignedIn(): void {
  process.env.USE_RAYU_OAUTH = 'true'
  writeFileSync(
    join(cfgDir, 'rayu-auth.json'),
    JSON.stringify({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      user: { id: 7, email: null, displayName: null, avatarUrl: null, role: 'user' },
    }),
    { mode: 0o600 },
  )
}

describe('presentation', () => {
  test('hosted models lead, each group keeps the gateway (admin) order', () => {
    // The gateway sends BYO rows first, then hosted rows sorted by Sort Order.
    const ordered = orderMediaModelsForPicker([IMAGEN, WAN_IMAGE_PRO, WAN_IMAGE])
    expect(ordered.map((m) => m.id)).toEqual([
      'rayu-wan2.7-image-pro',
      'rayu-wan2.7-image',
      'imagen-4.0-generate-001',
    ])
  })

  test('backend labels name the upstream, never NVIDIA', () => {
    expect(mediaBackendLabel(WAN_IMAGE)).toBe('Rayu-hosted')
    expect(mediaBackendLabel(IMAGEN)).toBe('Vertex Imagen')
    expect(mediaBackendLabel({ backend: 'vertex', mediaType: 'video' })).toBe('Vertex Veo')
    expect(mediaBackendLabel(KLING)).toBe('fal.ai')
  })

  test('the terminal detail line carries the admin name, backend and capabilities', () => {
    expect(describeMediaModel(WAN_IMAGE)).toBe('Wan 2.7 Image · Rayu-hosted · generate, edit')
    // A label that is just the id is not repeated.
    expect(describeMediaModel(KLING)).toBe('fal.ai · text2video')
  })

  test('editor rows lead with the display name and keep the id for matching', () => {
    const rows = mediaModelPickerOptions(catalogOf([IMAGEN, WAN_IMAGE]), 'image')
    expect(rows).toEqual([
      {
        value: 'rayu-wan2.7-image',
        label: 'Wan 2.7 Image',
        description: 'rayu-wan2.7-image · Rayu-hosted · generate, edit',
        model: 'rayu-wan2.7-image',
        providerId: 'rayu',
      },
      {
        value: 'imagen-4.0-generate-001',
        label: 'Imagen 4',
        description: 'imagen-4.0-generate-001 · Vertex Imagen · generate',
        model: 'imagen-4.0-generate-001',
        providerId: 'vertex',
      },
    ])
    // Each media type lists only its own half of the catalog.
    const video = mediaModelPickerOptions(catalogOf([IMAGEN], [KLING, WAN_VIDEO]), 'video')
    expect(video.map((r) => r.value)).toEqual([WAN_VIDEO.id, KLING.id])
  })
})

describe('mediaCatalogNotice', () => {
  test('signed out: built-in defaults say how to get the real list', () => {
    expect(mediaCatalogNotice(catalogOf([IMAGEN], [], 'fallback'), false)).toMatch(
      /built-in defaults.*\/login/,
    )
  })

  test('signed in: a fresh list needs no caveat, a stale one says so', () => {
    stubSignedIn()
    expect(mediaCatalogNotice(catalogOf([WAN_IMAGE]), true)).toBeUndefined()
    expect(mediaCatalogNotice(catalogOf([WAN_IMAGE]), false)).toMatch(
      /last list it sent/,
    )
    expect(mediaCatalogNotice(catalogOf([IMAGEN], [], 'fallback'), false)).toMatch(
      /Could not reach Rayu/,
    )
  })
})

describe('loadMediaModelPicker (the on-open live fetch)', () => {
  test('every open asks the gateway again, so an admin reorder shows at once', async () => {
    stubSignedIn()
    let order = [WAN_IMAGE, WAN_IMAGE_PRO]
    let calls = 0
    globalThis.fetch = (async (url: string) => {
      calls++
      expect(String(url)).toContain('/v1/models?media=all')
      return new Response(
        JSON.stringify({ object: 'list', media: 'all', data: [IMAGEN, ...order].map(wire) }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const first = await loadMediaModelPicker('image')
    expect(first.options.map((o) => o.value)).toEqual([
      'rayu-wan2.7-image',
      'rayu-wan2.7-image-pro',
      'imagen-4.0-generate-001',
    ])
    expect(first.notice).toBeUndefined()

    // The admin moves Pro to the top; the cache is still inside its TTL.
    order = [WAN_IMAGE_PRO, WAN_IMAGE]
    const second = await loadMediaModelPicker('image')
    expect(calls).toBe(2)
    expect(second.options.map((o) => o.value)).toEqual([
      'rayu-wan2.7-image-pro',
      'rayu-wan2.7-image',
      'imagen-4.0-generate-001',
    ])
  })

  test('NVIDIA rows the backend still publishes never reach the picker', async () => {
    stubSignedIn()
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          media: 'all',
          data: [
            {
              id: 'black-forest-labs/flux.1-schnell',
              mediaType: 'image',
              capabilities: ['generate'],
              backend: 'nvidia',
              family: 'flux',
              default: true,
            },
            wire(WAN_IMAGE),
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const { options } = await loadMediaModelPicker('image')
    expect(options.map((o) => o.value)).toEqual(['rayu-wan2.7-image'])
  })

  test('a failed fetch lists the last good catalog with a caveat', async () => {
    stubSignedIn()
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ object: 'list', media: 'all', data: [wire(WAN_VIDEO)] }),
        { status: 200 },
      )) as unknown as typeof fetch
    await loadMediaModelPicker('video')

    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const { options, notice } = await loadMediaModelPicker('video')
    expect(options.map((o) => o.value)).toEqual([WAN_VIDEO.id])
    expect(notice).toMatch(/last list it sent/)
  })

  test('signed out: built-in BYO defaults, no network call, a sign-in hint', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch

    const { options, notice } = await loadMediaModelPicker('video')
    expect(calls).toBe(0)
    expect(options.length).toBeGreaterThan(0)
    expect(options.every((o) => o.providerId === 'fal' || o.providerId === 'vertex')).toBe(true)
    expect(notice).toMatch(/\/login/)
  })
})
