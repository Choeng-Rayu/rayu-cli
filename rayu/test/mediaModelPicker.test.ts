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
  emptyHostedPickerNote,
  hostedPickerModels,
  loadMediaModelPicker,
  mediaBackendLabel,
  mediaCatalogNotice,
  mediaModelPickerOptions,
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
/**
 * A RETIRED video backend (fal.ai) that an older gateway may still publish. It is
 * here so the tests can prove such a row never reaches a picker.
 */
const RETIRED_FAL_VIDEO = {
  id: 'fal-ai/kling-video/v2.1/standard/text-to-video',
  label: 'fal-ai/kling-video/v2.1/standard/text-to-video',
  mediaType: 'video',
  capabilities: ['text2video'],
  backend: 'fal',
  family: 'fal-kling',
} as unknown as MediaModelEntry
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

beforeEach(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), 'rayu-mediapicker-'))
  savedConfigDir = process.env.RAYU_CONFIG_DIR
  savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
  savedOAuth = process.env.USE_RAYU_OAUTH
  process.env.RAYU_CONFIG_DIR = cfgDir
  process.env.RAYU_AUTH_CONFIG_DIR = cfgDir
  delete process.env.USE_RAYU_OAUTH
  _resetMediaModelsForTesting()
  // The provider file (where a Rayu API key lives) is read through a module-level
  // cache, so a previous test file that stored a key would otherwise still look
  // like a credential here.
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
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
  test('backend labels name the upstream', () => {
    expect(mediaBackendLabel(WAN_IMAGE)).toBe('Rayu-hosted')
    expect(mediaBackendLabel(IMAGEN)).toBe('Vertex Imagen')
    // A retired BYO video row can still be PARSED by an older gateway; the label
    // falls back to the raw backend name rather than claiming a client we have.
    expect(mediaBackendLabel(RETIRED_FAL_VIDEO)).toBe('fal')
  })

  test('the terminal detail line carries the admin name, backend and capabilities', () => {
    expect(describeMediaModel(WAN_IMAGE)).toBe('Wan 2.7 Image · Rayu-hosted · generate, edit')
    expect(describeMediaModel(WAN_VIDEO)).toBe('Wan 3.0 Video 480P · Rayu-hosted · text2video')
  })

  test('editor rows lead with the display name and keep the id for matching', () => {
    // Image generation is Rayu-hosted only, so a BYO Imagen row in the catalog is
    // NOT offered even though it is parsed and may already be selected.
    const rows = mediaModelPickerOptions(catalogOf([IMAGEN, WAN_IMAGE]), 'image')
    expect(rows).toEqual([
      {
        value: 'rayu-wan2.7-image',
        label: 'Wan 2.7 Image',
        description: 'rayu-wan2.7-image · Rayu-hosted · generate, edit',
        model: 'rayu-wan2.7-image',
        providerId: 'rayu',
      },
    ])
    // Video is Rayu-hosted only too, so the retired fal row is not offered.
    const video = mediaModelPickerOptions(
      catalogOf([IMAGEN], [RETIRED_FAL_VIDEO, WAN_VIDEO]),
      'video',
    )
    expect(video.map((r) => r.value)).toEqual([WAN_VIDEO.id])
  })

  test('a catalog with only retired/BYO rows yields an explained empty chooser', async () => {
    stubSignedIn()
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ object: 'list', media: 'all', data: [IMAGEN].map(wire) }),
        { status: 200 },
      )) as unknown as typeof fetch

    const image = await loadMediaModelPicker('image')
    expect(image.options).toEqual([])
    // An empty list is always explained: "no hosted models published" is never
    // presented as a bare blank chooser.
    expect(image.notice).toMatch(/No Rayu-hosted image models/)

    // Same for video: a retired fal row is parsed, then hidden by policy.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          media: 'all',
          data: [RETIRED_FAL_VIDEO].map(wire),
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    // A retired `fal` row is DROPPED at parse time (it is a backend this build no
    // longer serves), so the video catalog genuinely has no models: same empty
    // chooser, but not the "policy hid them" case.
    const video = await loadMediaModelPicker('video')
    expect(video.options).toEqual([])
    expect(video.notice).toMatch(/No Rayu-hosted video models/)
  })

  test('the chooser offers Rayu-hosted models only, in admin order, for both types', () => {
    expect(
      hostedPickerModels([IMAGEN, WAN_IMAGE_PRO, WAN_IMAGE]).map((m) => m.id),
    ).toEqual(['rayu-wan2.7-image-pro', 'rayu-wan2.7-image'])
    // A BYO-only catalog offers nothing: neither media type has a BYO model to offer.
    expect(hostedPickerModels([IMAGEN])).toEqual([])
    expect(hostedPickerModels([RETIRED_FAL_VIDEO])).toEqual([])
    expect(hostedPickerModels([RETIRED_FAL_VIDEO, WAN_VIDEO]).map((m) => m.id)).toEqual([
      WAN_VIDEO.id,
    ])
  })

  test('an empty hosted list is explained per media type', () => {
    expect(emptyHostedPickerNote('image')).toMatch(/No Rayu-hosted image models/)
    expect(emptyHostedPickerNote('video')).toMatch(/No Rayu-hosted video models/)
  })
})

describe('mediaCatalogNotice', () => {
  test('signed out: says a credential is what shows the hosted list', () => {
    // Hosted models are the only ones a picker offers, so the notice names the
    // missing credential rather than promising built-in defaults (video has none).
    expect(mediaCatalogNotice(catalogOf([IMAGEN], [], 'fallback'), false)).toMatch(
      /No Rayu credential.*\/login/s,
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
    // Image offers Rayu-hosted models only — the BYO Imagen row in the payload
    // is deliberately absent from the chooser.
    expect(first.options.map((o) => o.value)).toEqual([
      'rayu-wan2.7-image',
      'rayu-wan2.7-image-pro',
    ])
    expect(first.notice).toBeUndefined()

    // The admin moves Pro to the top; the cache is still inside its TTL.
    order = [WAN_IMAGE_PRO, WAN_IMAGE]
    const second = await loadMediaModelPicker('image')
    expect(calls).toBe(2)
    expect(second.options.map((o) => o.value)).toEqual([
      'rayu-wan2.7-image-pro',
      'rayu-wan2.7-image',
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

  test('signed out: no network call, an empty chooser, a credential hint', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch

    const { options, notice } = await loadMediaModelPicker('video')
    expect(calls).toBe(0)
    // Video has no BYO fallback any more, so there is nothing to list offline —
    // and the notice names the missing credential instead of implying models exist.
    expect(options).toEqual([])
    expect(notice).toMatch(/\/login/)
  })
})
