/**
 * Model catalog rendering + selection for the Telegram bot.
 *
 * WHY TEXT, NOT BUTTONS. The previous `/model` opened a paginated inline
 * keyboard. That works for a dozen models and falls apart for a real catalog:
 * button labels are truncated (`…-instruct-v0.3`), a tap is not quotable or
 * searchable, and the user can never see the exact id a request will carry.
 * Telegram renders a <code> span as tap-to-copy, so a plain text listing is both
 * complete and one tap from being usable.
 *
 * Every line is a COMPLETE, SENDABLE COMMAND — `/model <id> <provider>` — so
 * copying any line and sending it selects exactly that model on exactly that
 * provider, with no ambiguity to resolve.
 *
 * Pure functions only: no network, no config writes. The orchestration (live
 * fetch, persisting the choice, notifying the REPL) stays in telegramConnect.ts,
 * which keeps this module assertable without a filesystem or a bot token.
 */

import { escapeHtml } from './telegramApi.js'
import { sanitizeRemoteModelId, type RayuProvider } from '../utils/rayuConfig.js'
import { RAYU_HOSTED_PROVIDER_ID } from '../utils/rayuProviders.js'

/** One selectable (provider, model) pair. */
export interface CatalogEntry {
  providerId: string
  modelId: string
  /** Admin/preset display name, when it adds something the id doesn't. */
  label?: string
  /** True for the model the next request would actually use. */
  isActive: boolean
}

/** Models a provider offers, de-duplicated, preserving declaration order. */
function providerModels(provider: RayuProvider): string[] {
  return [
    ...new Set([...(provider.fetchedModels ?? []), ...(provider.models ?? [])]),
  ].filter(Boolean)
}

/**
 * Order providers for display: Rayu-hosted first (it needs no API key, so it is
 * what most users want), then the active provider, then the rest alphabetically
 * for a stable listing that doesn't reshuffle between calls.
 */
function orderProviders(
  providers: readonly RayuProvider[],
  activeProviderId: string | undefined,
): RayuProvider[] {
  const rank = (p: RayuProvider): number => {
    if (p.id === RAYU_HOSTED_PROVIDER_ID) return 0
    if (p.id === activeProviderId) return 1
    return 2
  }
  return [...providers].sort(
    (a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id),
  )
}

/**
 * Every selectable model across ALL configured providers — not just the active
 * one. A user reading the catalog on their phone should be able to switch
 * provider and model in a single message, which is why each entry carries its
 * provider and why resolveModelSelection accepts a provider argument.
 */
export function collectModelCatalog(
  providers: readonly RayuProvider[],
  activeProviderId: string | undefined,
): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const provider of orderProviders(providers, activeProviderId)) {
    for (const modelId of providerModels(provider)) {
      const label = provider.modelLabels?.[modelId]
      entries.push({
        providerId: provider.id,
        modelId,
        ...(label && label !== modelId ? { label } : {}),
        isActive:
          provider.id === activeProviderId && provider.defaultModel === modelId,
      })
    }
  }
  return entries
}

/**
 * Render the catalog as Telegram HTML.
 *
 * Returns ONE string; the caller chunks it with telegramApi.chunkText, which
 * splits on newline boundaries and therefore never severs a <code> span (an
 * unclosed tag would make Telegram reject the whole message).
 */
export function formatModelCatalog(entries: CatalogEntry[]): string {
  if (entries.length === 0) {
    return [
      '🤖 <b>No models available</b>',
      '',
      'Use /connect to add a provider, or /model &lt;id&gt; to set one directly.',
    ].join('\n')
  }

  const lines = [
    `🤖 <b>${entries.length} model${entries.length === 1 ? '' : 's'} available</b>`,
    '',
    '<i>Tap a line to copy it, then send it to switch.</i>',
  ]

  let currentProvider: string | null = null
  for (const entry of entries) {
    if (entry.providerId !== currentProvider) {
      currentProvider = entry.providerId
      const count = entries.filter(e => e.providerId === currentProvider).length
      lines.push('', `<b>${escapeHtml(entry.providerId)}</b> (${count})`)
    }
    // The whole command goes inside <code> so one tap copies something that can
    // be sent verbatim — including the provider, so it is never ambiguous.
    const command = `/model ${entry.modelId} ${entry.providerId}`
    const suffix = [
      entry.label ? ` — ${escapeHtml(entry.label)}` : '',
      entry.isActive ? ' ✅' : '',
    ].join('')
    lines.push(`<code>${escapeHtml(command)}</code>${suffix}`)
  }

  return lines.join('\n')
}

/** Outcome of resolving a user-supplied `/model <id> [provider]`. */
export type ModelResolution =
  | {
      kind: 'ok'
      providerId: string
      modelId: string
      /** True when applying this also changes the active provider. */
      switchesProvider: boolean
      /** True when the id is not in the provider's known catalog. */
      unlisted: boolean
    }
  | { kind: 'ambiguous'; modelId: string; providerIds: string[] }
  | { kind: 'unknown-provider'; providerId: string }
  | { kind: 'invalid'; modelId: string }

/**
 * Resolve `/model <id> [provider]` against the whole configured set.
 *
 * SECURITY. The id is validated with sanitizeRemoteModelId before anything else.
 * That rejects control characters — critically `\u0000`, which
 * rayuConfig.encodeModelWithProvider uses as its `providerId\u0000model` routing
 * separator. An unvalidated id containing one could name a different provider
 * than the one the user picked and send the request (and the credential attached
 * to it) somewhere unintended.
 *
 * An id that is not in any catalog is still accepted when a provider is named:
 * catalogs are frequently incomplete (a provider with no /models endpoint, or a
 * model added upstream since the last refresh), so refusing would make the
 * command less capable than the terminal's. It is flagged `unlisted` so the
 * caller can say so.
 */
export function resolveModelSelection(
  providers: readonly RayuProvider[],
  activeProviderId: string | undefined,
  rawModelId: string,
  rawProviderId?: string,
): ModelResolution {
  const modelId = sanitizeRemoteModelId(rawModelId)
  if (!modelId) return { kind: 'invalid', modelId: rawModelId }

  const requestedProvider = rawProviderId?.trim()
  if (requestedProvider) {
    const provider = providers.find(p => p.id === requestedProvider)
    if (!provider) {
      return { kind: 'unknown-provider', providerId: requestedProvider }
    }
    return {
      kind: 'ok',
      providerId: provider.id,
      modelId,
      switchesProvider: provider.id !== activeProviderId,
      unlisted: !providerModels(provider).includes(modelId),
    }
  }

  // No provider named: find which providers actually offer this id.
  const owners = providers.filter(p => providerModels(p).includes(modelId))

  if (owners.length > 1) {
    // Prefer the active provider when it is one of the candidates — the user
    // almost certainly means "this model, where I already am".
    const active = owners.find(p => p.id === activeProviderId)
    if (active) {
      return {
        kind: 'ok',
        providerId: active.id,
        modelId,
        switchesProvider: false,
        unlisted: false,
      }
    }
    return {
      kind: 'ambiguous',
      modelId,
      providerIds: owners.map(p => p.id),
    }
  }

  if (owners.length === 1) {
    const owner = owners[0]!
    return {
      kind: 'ok',
      providerId: owner.id,
      modelId,
      switchesProvider: owner.id !== activeProviderId,
      unlisted: false,
    }
  }

  // Unknown to every catalog — fall back to the active provider, matching the
  // terminal's behaviour of trusting a hand-typed id.
  const active = providers.find(p => p.id === activeProviderId) ?? providers[0]
  if (!active) return { kind: 'unknown-provider', providerId: '(none)' }
  return {
    kind: 'ok',
    providerId: active.id,
    modelId,
    switchesProvider: false,
    unlisted: true,
  }
}

/** Message for an ambiguous id, telling the user exactly what to send instead. */
export function formatAmbiguityHelp(
  modelId: string,
  providerIds: readonly string[],
): string {
  const lines = [
    `⚠️ <b>${escapeHtml(modelId)}</b> is offered by ${providerIds.length} providers.`,
    '',
    'Tap the one you want:',
    '',
  ]
  for (const providerId of providerIds) {
    lines.push(`<code>${escapeHtml(`/model ${modelId} ${providerId}`)}</code>`)
  }
  return lines.join('\n')
}
