/**
 * Provider adapter lookup.
 *
 * Registration is explicit rather than module-side-effect based: adapters are
 * behind `feature('EXTERNAL_AGENTS')` and reached via gated `require()`, so a
 * self-registering module would be pulled into the bundle by the import itself
 * and defeat dead-code elimination. `AgentManager` registers the adapters it
 * needs, and Task 17's ACP adapter registers one entry per user-configured
 * binary — which is what lets an arbitrary ACP agent work with no new code.
 */

import { logForDebugging } from '../../utils/debug.js'
import type { AgentAdapter } from './adapter.js'
import { UnknownProviderError } from './errors.js'
import type { ProviderId } from './types.js'

const adapters = new Map<ProviderId, AgentAdapter>()

/**
 * Register (or replace) the adapter for a provider.
 *
 * Replacement is allowed so a user can re-register an ACP binary under the same
 * id after editing its config without restarting RAYU.
 */
export function registerAdapter(adapter: AgentAdapter): void {
  if (adapters.has(adapter.provider)) {
    logForDebugging(
      `[adapterRegistry] replacing existing adapter for '${adapter.provider}'`,
    )
  }
  adapters.set(adapter.provider, adapter)
}

export function unregisterAdapter(provider: ProviderId): boolean {
  return adapters.delete(provider)
}

/** Look up an adapter, or throw naming every provider that is registered. */
export function getAdapter(provider: ProviderId): AgentAdapter {
  const adapter = adapters.get(provider)
  if (!adapter) {
    throw new UnknownProviderError(provider, listProviderIds())
  }
  return adapter
}

/** Look up an adapter without throwing. */
export function findAdapter(provider: ProviderId): AgentAdapter | undefined {
  return adapters.get(provider)
}

export function listProviderIds(): ProviderId[] {
  return [...adapters.keys()]
}

export function listAdapters(): AgentAdapter[] {
  return [...adapters.values()]
}

/**
 * Adapters whose CLI is actually usable on this machine.
 *
 * Availability probes touch the filesystem and PATH, so they run concurrently —
 * with several providers registered, serial probing is a visible startup delay.
 * A probe that throws counts as unavailable rather than failing the whole list.
 */
export async function listAvailableAdapters(): Promise<AgentAdapter[]> {
  const results = await Promise.all(
    listAdapters().map(async adapter => {
      try {
        return (await adapter.isAvailable()) ? adapter : null
      } catch {
        return null
      }
    }),
  )
  return results.filter((adapter): adapter is AgentAdapter => adapter !== null)
}

/** Clear the registry. Test/reset helper. */
export function resetAdapterRegistry(): void {
  adapters.clear()
}
