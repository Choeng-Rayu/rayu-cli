// Per-(provider, model) image capability.
//
// Before this module the only signal was the PROVIDER-wide `supportsImage` flag,
// so a text-only model either 400'd and lost the turn, or (when the flag was set)
// had its images dropped SILENTLY — leaving the user convinced the model saw the
// screenshot.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetImageCapabilitySessionCacheForTesting,
  contentHasImage,
  drainImageDropNotices,
  imageDroppedWarning,
  imageSupportFromModelTables,
  modelAcceptsImages,
  notePendingImageDropNotice,
  rememberModelRejectedImages,
  resolveImageSupport,
  stripImageBlocks,
} from '../src/utils/model/imageCapability.ts'

afterEach(() => {
  _resetImageCapabilitySessionCacheForTesting()
})

describe('the built-in model tables', () => {
  const textOnly = [
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-coder',
    'deepseek-v3',
    'gpt-oss-120b',
    'qwq-32b',
    'qwen3-coder-480b',
    'llama-3.3-70b',
    'llama-3-8b-instruct',
    'mixtral-8x7b',
    'codestral-latest',
    'glm-4.6',
    'glm-5',
    'longcat-2',
    'nemotron-ultra',
    'command-r-plus',
  ]
  for (const model of textOnly) {
    test(`${model} → no`, () => {
      expect(imageSupportFromModelTables(model)).toBe('no')
    })
  }

  const vision = [
    'claude-sonnet-4-5-20250929',
    'claude-3-5-haiku-20241022',
    'claude-opus-4-1',
    'gemini-2.5-flash',
    'models/gemini-3-pro',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-5',
    'o3',
    'o4-mini',
    'deepseek-vl',
    'deepseek-vl2',
    'qwen2.5-vl-72b',
    'glm-4.5v',
    'llama-3.2-11b-vision',
    'llama-4-scout',
    'pixtral-12b',
    'llava-1.6',
    'nova-lite-v1',
    'mistral-small-3.2',
    'gemma-3-27b',
  ]
  for (const model of vision) {
    test(`${model} → yes`, () => {
      expect(imageSupportFromModelTables(model)).toBe('yes')
    })
  }

  test('a vision variant beats the broader text-only family rule', () => {
    // Ordering guard: KNOWN_VISION_MODELS must be consulted first, or the
    // generic `deepseek-(chat|coder|...)` rule would swallow deepseek-vl.
    expect(imageSupportFromModelTables('deepseek-vl')).toBe('yes')
    expect(imageSupportFromModelTables('deepseek-chat')).toBe('no')
  })

  test('an unlisted model is unknown, NOT assumed text-only', () => {
    // Assuming "no" would block images on a perfectly capable new model.
    expect(imageSupportFromModelTables('brand-new-model-2031')).toBe('unknown')
    expect(imageSupportFromModelTables('')).toBe('unknown')
  })

  test('a cross-provider routing prefix is stripped before matching', () => {
    expect(imageSupportFromModelTables('deepseek\u0000deepseek-chat')).toBe('no')
    expect(imageSupportFromModelTables('openai\u0000gpt-4o')).toBe('yes')
  })
})

describe('resolveImageSupport with no provider configured', () => {
  test('falls back to the tables', () => {
    expect(resolveImageSupport('deepseek-chat')).toBe('no')
    expect(resolveImageSupport('gpt-4o')).toBe('yes')
    expect(resolveImageSupport('who-knows')).toBe('unknown')
  })

  test('undefined model is unknown', () => {
    expect(resolveImageSupport(undefined)).toBe('unknown')
  })
})

describe('modelAcceptsImages treats unknown as permissive', () => {
  test('only a positive "no" blocks', () => {
    expect(modelAcceptsImages('deepseek-chat')).toBe(false)
    expect(modelAcceptsImages('gpt-4o')).toBe(true)
    // The important one: an incomplete table must never block a capable model.
    expect(modelAcceptsImages('unlisted-model')).toBe(true)
    expect(modelAcceptsImages(undefined)).toBe(true)
  })
})

describe('a provider rejection is remembered for the session', () => {
  test('a model the tables called unknown becomes "no" after a rejection', () => {
    expect(resolveImageSupport('mystery-model-9')).toBe('unknown')
    rememberModelRejectedImages(undefined, 'mystery-model-9')
    expect(resolveImageSupport('mystery-model-9')).toBe('no')
    expect(modelAcceptsImages('mystery-model-9')).toBe(false)
  })

  test('the memory is keyed per model, not global', () => {
    rememberModelRejectedImages(undefined, 'mystery-a')
    expect(resolveImageSupport('mystery-a')).toBe('no')
    expect(resolveImageSupport('mystery-b')).toBe('unknown')
  })

  test('a routing prefix does not create a second, unmatched entry', () => {
    rememberModelRejectedImages(undefined, 'p\u0000mystery-c')
    expect(resolveImageSupport('mystery-c')).toBe('no')
  })

  test('the reset seam clears it', () => {
    rememberModelRejectedImages(undefined, 'mystery-d')
    expect(resolveImageSupport('mystery-d')).toBe('no')
    _resetImageCapabilitySessionCacheForTesting()
    expect(resolveImageSupport('mystery-d')).toBe('unknown')
  })
})

describe('the one-shot notice channel', () => {
  test('drains to a worded warning and clears', () => {
    notePendingImageDropNotice('deepseek-chat')
    const first = drainImageDropNotices()
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('deepseek-chat')
    expect(first[0]).toContain('was not sent')
    // One-shot: a second drain in the same turn yields nothing.
    expect(drainImageDropNotices()).toEqual([])
  })

  test('two notices for the same model collapse to one warning', () => {
    notePendingImageDropNotice('deepseek-chat')
    notePendingImageDropNotice('deepseek-chat')
    expect(drainImageDropNotices()).toHaveLength(1)
  })

  test('nothing pending drains to an empty list', () => {
    expect(drainImageDropNotices()).toEqual([])
  })
})

describe('imageDroppedWarning wording', () => {
  test('names the model, says the image was not sent and the text was', () => {
    const message = imageDroppedWarning('deepseek-chat')
    expect(message).toContain('deepseek-chat')
    expect(message).toContain('text-only')
    expect(message).toContain('image was not sent')
    expect(message).toContain('text was sent')
    // Not a Rayu failure, and both recovery routes are offered.
    expect(message).toContain('limitation of the model')
    expect(message).toContain('/model')
    expect(message).toContain('/connect')
  })

  test('the reactive variant says the provider rejected it', () => {
    const message = imageDroppedWarning('mystery', {
      discoveredFromProvider: true,
    })
    expect(message).toContain('provider rejected the image')
    expect(message).toContain('mystery')
  })
})

describe('image block helpers', () => {
  const imageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
  }
  const textBlock = { type: 'text', text: 'hello' }

  test('contentHasImage detects an image among blocks', () => {
    expect(contentHasImage([textBlock, imageBlock])).toBe(true)
    expect(contentHasImage([textBlock])).toBe(false)
    expect(contentHasImage('a plain string')).toBe(false)
    expect(contentHasImage(undefined)).toBe(false)
  })

  test('stripImageBlocks removes images and keeps text', () => {
    expect(stripImageBlocks([textBlock, imageBlock])).toEqual([textBlock])
  })

  test('stripImageBlocks returns the SAME reference when nothing to strip', () => {
    const blocks = [textBlock]
    expect(stripImageBlocks(blocks)).toBe(blocks)
  })
})
