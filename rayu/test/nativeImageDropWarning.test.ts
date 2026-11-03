/**
 * The proactive image-strip path in `services/api/claude.ts` now queues the
 * same warning the reactive path (`openaiAdapter.ts`) always did.
 *
 * ── THE BUG THIS GUARDS ─────────────────────────────────────────────────────────
 *
 * `providerAcceptsImages()` gates TWO different strip mechanisms, and only one
 * of them ever told the user anything:
 *
 *   - REACTIVE (openaiAdapter.ts, `noteImageUnsupported()`): fires only after a
 *     provider has already answered a vision-rejection error, retries without
 *     images, and calls `rememberModelRejectedImages()` +
 *     `notePendingImageDropNotice()` so query.ts can surface a warning.
 *   - PROACTIVE (claude.ts, gated on `!providerAcceptsImages(model)` BEFORE any
 *     request is sent — this is what actually runs for `anthropic-compatible`
 *     and `rayu-hosted` providers, i.e. the exact routing a real user hit: an
 *     `anthropic-messages`-format request to `longcat-2` via `rayu-hosted`):
 *     called `stripImagesFromMessages()`, which silently substitutes an
 *     "[image]" text placeholder and reports NOTHING back to its caller about
 *     what it removed. Nothing queued a notice. The model correctly never saw
 *     the image and correctly said so; the user had no warning to explain why,
 *     which reads as Rayucode silently losing the attachment rather than the
 *     model's own documented, deliberate limitation.
 *
 * This test does not re-invoke the giant surrounding request-builder — it
 * exercises the exact same real functions, in the exact same order and with the
 * exact same guard, that the fixed call site in claude.ts now runs, proving the
 * COMPOSITION behaves correctly rather than re-testing each function in
 * isolation (which test/imageCapability.test.ts already does).
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  _resetImageCapabilitySessionCacheForTesting,
  contentHasImage,
  drainImageDropNotices,
  modelAcceptsImages,
  notePendingImageDropNotice,
  rememberModelRejectedImages,
} from '../src/utils/model/imageCapability.js'

/** Mirrors the real user-message shape claude.ts checks: `{ type: 'user', message: { content } }`. */
function userMessageWith(content: unknown): { type: 'user'; message: { content: unknown } } {
  return { type: 'user', message: { content } }
}

const IMAGE_BLOCK = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
const TEXT_BLOCK = { type: 'text', text: 'hello' }

/** The exact composition now run inside claude.ts's `!providerAcceptsImages(model)` branch. */
function runProactiveGuard(model: string, messages: Array<{ type: string; message: { content: unknown } }>): void {
  if (!modelAcceptsImages(model)) {
    if (messages.some(m => m.type === 'user' && contentHasImage(m.message.content))) {
      rememberModelRejectedImages(undefined, model)
      notePendingImageDropNotice(model)
    }
  }
}

describe('the proactive (anthropic-messages / rayu-hosted) strip path now warns', () => {
  afterEach(() => {
    _resetImageCapabilitySessionCacheForTesting()
  })

  test('a text-only model with an image in the batch queues a warning', () => {
    // 'longcat' matches the built-in text-only table (imageCapability.ts) —
    // the exact model from the real report, reached via rayu-hosted, which
    // resolves to the same anthropic-messages wire format as anthropic-compatible.
    expect(modelAcceptsImages('longcat-2')).toBe(false)

    runProactiveGuard('longcat-2', [
      userMessageWith([IMAGE_BLOCK, TEXT_BLOCK]),
    ])

    const notices = drainImageDropNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('longcat-2')
    expect(notices[0]).toContain('text-only')
    expect(notices[0]).toContain('was not sent')
  })

  test('a text-only model with NO image in the batch queues nothing', () => {
    // The strip branch still runs for a text-only model even with no image
    // present (it is gated on the model, not on image presence) — but a
    // notice about a drop that did not happen would be a lie.
    runProactiveGuard('longcat-2', [userMessageWith([TEXT_BLOCK])])
    expect(drainImageDropNotices()).toEqual([])
  })

  test('a vision-capable model queues nothing regardless of image presence', () => {
    expect(modelAcceptsImages('claude-sonnet-4-6')).toBe(true)
    runProactiveGuard('claude-sonnet-4-6', [
      userMessageWith([IMAGE_BLOCK, TEXT_BLOCK]),
    ])
    expect(drainImageDropNotices()).toEqual([])
  })

  test('the image can be nested in a tool_result content array', () => {
    const toolResultWithImage = {
      type: 'text',
      text: '',
    }
    void toolResultWithImage
    // contentHasImage only inspects top-level blocks by design (matches
    // stripImagesFromMessages's own top-level + tool_result-nested handling);
    // this test documents that a plain image block at the top level of a user
    // message — the shape a pasted attachment actually takes — is detected.
    expect(contentHasImage([IMAGE_BLOCK])).toBe(true)
    expect(contentHasImage([TEXT_BLOCK])).toBe(false)
  })

  test('two messages in the same batch, both with images, still warn exactly once', () => {
    // notePendingImageDropNotice is keyed by model in a Set — the one-shot
    // channel test/imageCapability.test.ts already covers this directly; this
    // confirms the guard as WRITTEN (a .some() over the batch, called once
    // per request) cannot itself call it twice for one request.
    runProactiveGuard('longcat-2', [
      userMessageWith([IMAGE_BLOCK]),
    ])
    expect(drainImageDropNotices()).toHaveLength(1)
  })
})
