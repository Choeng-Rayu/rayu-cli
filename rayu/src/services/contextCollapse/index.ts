// Stub: context-collapse service absent from the leaked tree. Gated behind
// feature('CONTEXT_COLLAPSE') (default off); callers check isContextCollapseEnabled()
// first, so these inert defaults keep the feature disabled and the tree compiling.
export function isContextCollapseEnabled(): boolean {
  return false
}

export function getStats(): { collapsedSpans: unknown[] } {
  return { collapsedSpans: [] }
}

export function subscribe(_listener: () => void): () => void {
  return () => {}
}

export function resetContextCollapse(): void {}
