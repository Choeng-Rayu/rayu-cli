/**
 * Warn when a model's customer-facing NAME mentions the upstream provider.
 *
 * The Name is what end users see in the CLI's model picker, while the provider is
 * an internal commercial detail — which reseller serves a model is nobody's
 * business but the operator's. Admins reasonably annotate names for themselves
 * ("GLM-5.2 (Ollama Cloud)"), not realising the annotation ships to users.
 *
 * This is deliberately ADVISORY, not a silent rewrite: the admin types a name and
 * must see exactly that name stored. A heuristic belongs in advice, never in data.
 */
export function nameLeaksProvider(name: string, providerSlug: string): boolean {
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  // "rayu" appears in the operator's own slugs (rayu-ollama), so it identifies
  // nothing and would flag every name.
  const slugWords = words(providerSlug).filter((w) => w.length >= 4 && w !== 'rayu')
  const nameWords = new Set(words(name))
  return slugWords.some((w) => nameWords.has(w))
}
