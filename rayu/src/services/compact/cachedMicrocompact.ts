// Stub: cached-microcompact helpers absent from the leaked tree. This is a
// prompt-cache optimization; no-op state keeps microCompact functional without it.
export type CacheEditsBlock = { type: string; [k: string]: unknown }
export type PinnedCacheEdits = { block: CacheEditsBlock; [k: string]: unknown }
export type CachedMCState = {
  pinnedCacheEdits: PinnedCacheEdits[]
  toolsSentToAPI: boolean
}

export function createCachedMCState(): CachedMCState {
  return { pinnedCacheEdits: [], toolsSentToAPI: false }
}

export function markToolsSentToAPI(state: CachedMCState): void {
  state.toolsSentToAPI = true
}

export function resetCachedMCState(state: CachedMCState): void {
  state.pinnedCacheEdits = []
  state.toolsSentToAPI = false
}
