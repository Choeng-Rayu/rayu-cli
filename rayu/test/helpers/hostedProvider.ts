/** Auth/catalog fixture served over real HTTP; never uses an actual account. */
export function hostedEntitlements() {
  const models = [
    { code: 'admin-new-model', label: 'New Admin Model', provider: 'fixture', creditMultiplier: 1, contextWindow: 123456, supportsImage: true, supportsReasoning: true, supportsTools: true },
    { code: 'admin-text-only', label: 'Text Only', provider: 'fixture', creditMultiplier: 1, contextWindow: 32123, supportsImage: false, supportsReasoning: false, supportsTools: false },
  ]
  return { plan: { code: 'paid', name: 'Paid', priceCents: 1000, availability: 'active' }, maxDailyTurns: null, features: {}, hostedModels: models, allowedModels: [models[0]!] }
}
