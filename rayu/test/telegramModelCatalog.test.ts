/**
 * Model catalog suite (Task 8).
 *
 * The `/model` command replaced a paginated inline keyboard with copyable text.
 * Three properties matter and are pinned here:
 *   1. every rendered line is a COMPLETE, SENDABLE, UNAMBIGUOUS command, so
 *      copying any line selects exactly that model on exactly that provider;
 *   2. chunking a large catalog never severs a <code> span — an unclosed tag
 *      makes Telegram reject the whole message, so the user would see nothing;
 *   3. a user-supplied model id is sanitised before it can influence routing.
 *      `\u0000` is the separator rayuConfig.encodeModelWithProvider uses for
 *      `providerId\u0000model`, so an id carrying one could redirect a request —
 *      and the credential attached to it — to a provider the user never chose.
 */
import { describe, expect, test } from 'bun:test'

import { chunkText, escapeHtml } from '../src/telegram/telegramApi.js'
import {
  collectModelCatalog,
  formatAmbiguityHelp,
  formatModelCatalog,
  resolveModelSelection,
  type CatalogEntry,
} from '../src/telegram/telegramModelCatalog.js'
import type { RayuProvider } from '../src/utils/rayuConfig.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function provider(over: Partial<RayuProvider> & { id: string }): RayuProvider {
  return { kind: 'openai-compatible', ...over } as RayuProvider
}

const HOSTED = provider({
  id: 'rayu-hosted',
  kind: 'rayu-hosted',
  models: ['rayu-sonnet', 'rayu-haiku'],
  defaultModel: 'rayu-sonnet',
})
const NVIDIA = provider({
  id: 'nvidia',
  models: ['meta/llama-3.1-70b-instruct', 'shared-model'],
  modelLabels: { 'meta/llama-3.1-70b-instruct': 'Llama 3.1 70B' },
})
const DEEPSEEK = provider({
  id: 'deepseek',
  fetchedModels: ['deepseek-chat', 'shared-model'],
  defaultModel: 'deepseek-chat',
})

// ---------------------------------------------------------------------------
// collectModelCatalog
// ---------------------------------------------------------------------------

describe('collectModelCatalog', () => {
  test('walks EVERY configured provider, not just the active one', () => {
    // The whole point of the redesign: switch provider and model in one message.
    const entries = collectModelCatalog([HOSTED, NVIDIA, DEEPSEEK], 'nvidia')
    const providers = new Set(entries.map(e => e.providerId))
    expect(providers).toEqual(new Set(['rayu-hosted', 'nvidia', 'deepseek']))
  })

  test('de-duplicates fetchedModels against models', () => {
    const p = provider({
      id: 'x',
      fetchedModels: ['a', 'b'],
      models: ['b', 'c'],
    })
    expect(collectModelCatalog([p], 'x').map(e => e.modelId)).toEqual(['a', 'b', 'c'])
  })

  test('drops empty model ids instead of rendering a broken command', () => {
    const p = provider({ id: 'x', models: ['good', '', 'also-good'] })
    expect(collectModelCatalog([p], 'x').map(e => e.modelId)).toEqual([
      'good',
      'also-good',
    ])
  })

  test('orders rayu-hosted first, then the active provider, then alphabetically', () => {
    const zeta = provider({ id: 'zeta', models: ['z1'] })
    const alpha = provider({ id: 'alpha', models: ['a1'] })
    const entries = collectModelCatalog([zeta, alpha, DEEPSEEK, HOSTED], 'deepseek')
    const order: string[] = []
    for (const e of entries) {
      if (order[order.length - 1] !== e.providerId) order.push(e.providerId)
    }
    // rayu-hosted needs no API key, so it is what most users want to see first.
    expect(order).toEqual(['rayu-hosted', 'deepseek', 'alpha', 'zeta'])
  })

  test('ordering is stable across calls', () => {
    const list = [DEEPSEEK, NVIDIA, HOSTED]
    const a = collectModelCatalog(list, 'nvidia').map(e => `${e.providerId}/${e.modelId}`)
    const b = collectModelCatalog(list, 'nvidia').map(e => `${e.providerId}/${e.modelId}`)
    expect(a).toEqual(b)
  })

  test('marks exactly the (active provider, default model) pair as active', () => {
    const entries = collectModelCatalog([HOSTED, DEEPSEEK], 'deepseek')
    const active = entries.filter(e => e.isActive)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ providerId: 'deepseek', modelId: 'deepseek-chat' })
    // rayu-hosted also declares defaultModel: 'rayu-sonnet', but it is not the
    // active provider, so it must NOT be shown as the model in use.
    expect(entries.find(e => e.modelId === 'rayu-sonnet')?.isActive).toBe(false)
  })

  test('nothing is active when the active provider is unknown', () => {
    const entries = collectModelCatalog([HOSTED, DEEPSEEK], undefined)
    expect(entries.some(e => e.isActive)).toBe(false)
  })

  test('includes a label only when it adds something the id does not', () => {
    const p = provider({
      id: 'x',
      models: ['a', 'b'],
      modelLabels: { a: 'Model A', b: 'b' },
    })
    const entries = collectModelCatalog([p], 'x')
    expect(entries[0]!.label).toBe('Model A')
    // A label identical to the id is noise on a phone screen.
    expect(entries[1]!.label).toBeUndefined()
  })

  test('handles no providers and providers with no models', () => {
    expect(collectModelCatalog([], 'x')).toEqual([])
    expect(collectModelCatalog([provider({ id: 'empty' })], 'empty')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// formatModelCatalog
// ---------------------------------------------------------------------------

describe('formatModelCatalog', () => {
  test('explains how to add a provider when there is nothing to list', () => {
    const out = formatModelCatalog([])
    expect(out).toContain('No models available')
    expect(out).toContain('/connect')
    // Must not render an empty header claiming "0 models available" and stop.
    expect(out).not.toContain('<code>')
  })

  test('every model line is a complete, sendable, UNAMBIGUOUS command', () => {
    const out = formatModelCatalog(collectModelCatalog([HOSTED, DEEPSEEK], 'deepseek'))
    const codeSpans = [...out.matchAll(/<code>(.*?)<\/code>/g)].map(m => m[1]!)

    expect(codeSpans.length).toBeGreaterThan(0)
    for (const span of codeSpans) {
      // Whole command inside <code>: one tap copies something sendable verbatim.
      expect(span).toMatch(/^\/model \S+ \S+$/)
      // The provider is INSIDE the copied text, so a pasted line can never be
      // ambiguous even when two providers offer the same id.
      const parts = span.split(' ')
      expect(parts).toHaveLength(3)
      expect(parts[2]).toBeTruthy()
    }
  })

  test('keeps the label OUTSIDE the code span so a copy stays clean', () => {
    const out = formatModelCatalog(collectModelCatalog([NVIDIA], 'nvidia'))
    expect(out).toContain('</code> — Llama 3.1 70B')
    // If the label were inside, copying the line would produce an unsendable
    // command with the human-readable name appended.
    expect(out).not.toMatch(/<code>[^<]*Llama 3\.1 70B/)
  })

  test('marks the active model and only the active model', () => {
    const out = formatModelCatalog(collectModelCatalog([HOSTED, DEEPSEEK], 'deepseek'))
    const ticked = out.split('\n').filter(l => l.includes('✅'))
    expect(ticked).toHaveLength(1)
    expect(ticked[0]).toContain('/model deepseek-chat deepseek')
  })

  test('groups by provider with per-provider counts', () => {
    const out = formatModelCatalog(collectModelCatalog([HOSTED, NVIDIA], 'nvidia'))
    expect(out).toContain('<b>rayu-hosted</b> (2)')
    expect(out).toContain('<b>nvidia</b> (2)')
  })

  test('agrees with itself on singular vs plural', () => {
    const one = formatModelCatalog([
      { providerId: 'x', modelId: 'solo', isActive: false },
    ])
    expect(one).toContain('1 model available')
    const two = formatModelCatalog([
      { providerId: 'x', modelId: 'a', isActive: false },
      { providerId: 'x', modelId: 'b', isActive: false },
    ])
    expect(two).toContain('2 models available')
  })

  test('escapes HTML in ids, providers and labels', () => {
    const entries: CatalogEntry[] = [
      {
        providerId: 'evil<provider>',
        modelId: 'a&b<script>',
        label: 'Label <b>bold</b> & co',
        isActive: false,
      },
    ]
    const out = formatModelCatalog(entries)
    // Telegram rejects a message with stray tags; worse, unescaped markup lets a
    // provider label forge formatting in the user's chat.
    expect(out).not.toContain('<script>')
    expect(out).toContain(escapeHtml('/model a&b<script> evil<provider>'))
    expect(out).toContain('Label &lt;b&gt;bold&lt;/b&gt; &amp; co')
  })

  test('chunking a large catalog never severs a code span', () => {
    // A real catalog (OpenRouter) is hundreds of models, so this path always runs.
    const many = Array.from({ length: 500 }, (_, i) =>
      provider({ id: `p${String(i).padStart(3, '0')}`, models: [`model-${i}-long-name-suffix`] }),
    )
    const out = formatModelCatalog(collectModelCatalog(many, 'p000'))
    const chunks = chunkText(out)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
      // An unclosed <code> makes Telegram reject the WHOLE message, so the user
      // would silently see nothing.
      const opens = (chunk.match(/<code>/g) ?? []).length
      const closes = (chunk.match(/<\/code>/g) ?? []).length
      expect(opens).toBe(closes)
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length)
      expect((chunk.match(/<i>/g) ?? []).length).toBe((chunk.match(/<\/i>/g) ?? []).length)
    }
    // Nothing lost in the split.
    expect(chunks.join('')).toBe(out)
  })
})

// ---------------------------------------------------------------------------
// resolveModelSelection — security first
// ---------------------------------------------------------------------------

describe('resolveModelSelection sanitisation', () => {
  const providers = [HOSTED, NVIDIA, DEEPSEEK]

  test('REJECTS a NUL byte — it is the provider-routing separator', () => {
    // encodeModelWithProvider uses `providerId\u0000model`. An id carrying one
    // could name a provider the user never chose, sending the request and that
    // provider's credential somewhere unintended.
    const attack = 'anthropic\u0000claude-opus-4'
    const out = resolveModelSelection(providers, 'nvidia', attack)
    expect(out.kind).toBe('invalid')
  })

  test('rejects a NUL byte even when a provider is named explicitly', () => {
    const out = resolveModelSelection(providers, 'nvidia', 'x\u0000y', 'nvidia')
    // Validation happens BEFORE the provider branch, so naming a provider does
    // not buy a way past it.
    expect(out.kind).toBe('invalid')
  })

  test.each([
    ['newline', 'model\nid'],
    ['carriage return', 'model\rid'],
    ['tab', 'model\tid'],
    ['bell', 'model\u0007id'],
    ['escape', 'model\u001bid'],
    ['delete', 'model\u007fid'],
  ])('rejects a %s control character', (_name, id) => {
    expect(resolveModelSelection(providers, 'nvidia', id).kind).toBe('invalid')
  })

  test.each([
    ['space', 'model id'],
    ['quote', 'model"id'],
    ['backtick', 'model`id'],
    ['angle bracket', 'model<id'],
    ['dollar', 'model$id'],
    ['semicolon', 'model;id'],
    ['backslash', 'model\\id'],
    ['empty', ''],
    ['only whitespace', '   '],
  ])('rejects a %s in the model id', (_name, id) => {
    expect(resolveModelSelection(providers, 'nvidia', id).kind).toBe('invalid')
  })

  test('rejects an absurdly long id', () => {
    expect(resolveModelSelection(providers, 'nvidia', 'a'.repeat(513)).kind).toBe(
      'invalid',
    )
    expect(resolveModelSelection(providers, 'nvidia', 'a'.repeat(512)).kind).toBe('ok')
  })

  test.each([
    'deepseek-chat',
    'meta/llama-3.1-70b-instruct',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'org@model+variant',
    'Model_With.Mixed-Case',
  ])('accepts the legitimate id %s', id => {
    expect(resolveModelSelection(providers, 'nvidia', id).kind).toBe('ok')
  })

  test('trims surrounding whitespace rather than refusing', () => {
    const out = resolveModelSelection(providers, 'nvidia', '  deepseek-chat  ')
    expect(out.kind).toBe('ok')
    expect(out.kind === 'ok' && out.modelId).toBe('deepseek-chat')
  })
})

describe('resolveModelSelection routing', () => {
  const providers = [HOSTED, NVIDIA, DEEPSEEK]

  test('an explicitly named provider wins outright', () => {
    // 'shared-model' is offered by both nvidia and deepseek.
    const out = resolveModelSelection(providers, 'nvidia', 'shared-model', 'deepseek')
    expect(out).toEqual({
      kind: 'ok',
      providerId: 'deepseek',
      modelId: 'shared-model',
      switchesProvider: true,
      unlisted: false,
    })
  })

  test('an unknown named provider is refused, not silently redirected', () => {
    const out = resolveModelSelection(providers, 'nvidia', 'deepseek-chat', 'not-a-provider')
    expect(out).toEqual({ kind: 'unknown-provider', providerId: 'not-a-provider' })
  })

  test('a bare id with one owner resolves to that owner', () => {
    const out = resolveModelSelection(providers, 'nvidia', 'deepseek-chat')
    expect(out).toEqual({
      kind: 'ok',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      switchesProvider: true,
      unlisted: false,
    })
  })

  test('switchesProvider is false when the owner is already active', () => {
    const out = resolveModelSelection(providers, 'deepseek', 'deepseek-chat')
    expect(out.kind === 'ok' && out.switchesProvider).toBe(false)
  })

  test('a contested id prefers the ACTIVE provider over asking', () => {
    // The user almost certainly means "this model, where I already am".
    const out = resolveModelSelection(providers, 'nvidia', 'shared-model')
    expect(out).toEqual({
      kind: 'ok',
      providerId: 'nvidia',
      modelId: 'shared-model',
      switchesProvider: false,
      unlisted: false,
    })
  })

  test('a contested id with no active candidate asks instead of guessing', () => {
    const out = resolveModelSelection(providers, 'rayu-hosted', 'shared-model')
    expect(out.kind).toBe('ambiguous')
    if (out.kind !== 'ambiguous') throw new Error('unreachable')
    expect(out.modelId).toBe('shared-model')
    expect(new Set(out.providerIds)).toEqual(new Set(['nvidia', 'deepseek']))
  })

  test('an id in no catalog falls back to the active provider, flagged unlisted', () => {
    // Catalogs are frequently incomplete (no /models endpoint, or a model added
    // upstream since the last refresh); refusing would make the chat less
    // capable than the terminal.
    const out = resolveModelSelection(providers, 'nvidia', 'brand-new-model')
    expect(out).toEqual({
      kind: 'ok',
      providerId: 'nvidia',
      modelId: 'brand-new-model',
      switchesProvider: false,
      unlisted: true,
    })
  })

  test('an unlisted id on an explicitly named provider is still accepted', () => {
    const out = resolveModelSelection(providers, 'nvidia', 'brand-new-model', 'deepseek')
    expect(out).toMatchObject({
      kind: 'ok',
      providerId: 'deepseek',
      unlisted: true,
      switchesProvider: true,
    })
  })

  test('falls back to the first provider when none is active', () => {
    const out = resolveModelSelection(providers, undefined, 'brand-new-model')
    expect(out).toMatchObject({ kind: 'ok', providerId: 'rayu-hosted', unlisted: true })
  })

  test('with no providers configured there is nothing to route to', () => {
    const out = resolveModelSelection([], undefined, 'anything')
    expect(out).toEqual({ kind: 'unknown-provider', providerId: '(none)' })
  })

  test('an explicit provider is honoured even when it is the active one', () => {
    const out = resolveModelSelection(providers, 'deepseek', 'deepseek-chat', 'deepseek')
    expect(out).toMatchObject({ switchesProvider: false, unlisted: false })
  })

  test('a rendered catalog line round-trips back to the entry it came from', () => {
    // The contract that makes the copyable listing correct: parse any emitted
    // line and resolve it to exactly the provider/model it was rendered for.
    const entries = collectModelCatalog(providers, 'nvidia')
    const out = formatModelCatalog(entries)
    const spans = [...out.matchAll(/<code>(.*?)<\/code>/g)].map(m => m[1]!)

    expect(spans).toHaveLength(entries.length)
    for (const span of spans) {
      const [, modelId, providerId] = span.split(' ') as [string, string, string]
      const resolved = resolveModelSelection(
        providers,
        'nvidia',
        // Undo the HTML escaping Telegram would have shown the user.
        modelId.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        providerId,
      )
      expect(resolved.kind).toBe('ok')
      if (resolved.kind !== 'ok') throw new Error('unreachable')
      expect(resolved.providerId).toBe(providerId)
      expect(resolved.unlisted).toBe(false)
      expect(
        entries.some(
          e => e.providerId === resolved.providerId && e.modelId === resolved.modelId,
        ),
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// formatAmbiguityHelp
// ---------------------------------------------------------------------------

describe('formatAmbiguityHelp', () => {
  test('offers one copyable disambiguation line per provider', () => {
    const out = formatAmbiguityHelp('shared-model', ['nvidia', 'deepseek'])
    expect(out).toContain('2 providers')
    expect(out).toContain('<code>/model shared-model nvidia</code>')
    expect(out).toContain('<code>/model shared-model deepseek</code>')
  })

  test('the offered lines actually resolve', () => {
    // A help message that suggests something unresolvable is worse than none.
    const providers = [NVIDIA, DEEPSEEK]
    const out = formatAmbiguityHelp('shared-model', ['nvidia', 'deepseek'])
    for (const span of [...out.matchAll(/<code>(.*?)<\/code>/g)].map(m => m[1]!)) {
      const [, modelId, providerId] = span.split(' ') as [string, string, string]
      expect(
        resolveModelSelection(providers, 'nvidia', modelId, providerId).kind,
      ).toBe('ok')
    }
  })

  test('escapes HTML in the model id', () => {
    const out = formatAmbiguityHelp('a&b<c>', ['p1'])
    expect(out).not.toContain('<c>')
    expect(out).toContain('a&amp;b&lt;c&gt;')
  })
})
