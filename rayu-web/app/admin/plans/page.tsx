'use client'

import { useCallback, useEffect, useState } from 'react'
import { CardSkeleton, Field, Panel, SectionHeader } from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import { FeatureCatalogItem, FeatureEntitlement, PlanAdminView } from '../types'

export default function PlansPage() {
  const { apiFetch, token } = useAdmin()
  const [catalog, setCatalog] = useState<FeatureCatalogItem[]>([])
  const [plans, setPlans] = useState<PlanAdminView[]>([])
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [savingCode, setSavingCode] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    const res = await apiFetch('/admin/plans')
    if (res.ok) {
      const data = (await res.json()) as { catalog: FeatureCatalogItem[]; plans: PlanAdminView[] }
      setCatalog(data.catalog)
      setPlans(data.plans)
    }
    setLoaded(true)
  }, [apiFetch])

  useEffect(() => {
    if (token) void reload()
  }, [token, reload])

  function patchPlan(code: string, patch: Partial<PlanAdminView>) {
    setPlans((prev) => prev.map((p) => (p.code === code ? { ...p, ...patch } : p)))
  }
  function patchFeature(code: string, key: string, patch: Partial<FeatureEntitlement>) {
    setPlans((prev) =>
      prev.map((p) =>
        p.code === code ? { ...p, features: { ...p.features, [key]: { ...p.features[key], ...patch } } } : p,
      ),
    )
  }

  async function save(plan: PlanAdminView) {
    setSavingCode(plan.code)
    setMsg((m) => ({ ...m, [plan.code]: '' }))
    try {
      const res = await apiFetch(`/admin/plans/${plan.code}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: plan.name,
          priceCents: plan.priceCents,
          availability: plan.availability,
          maxDailyTurns: plan.maxDailyTurns,
          creditsPerPeriod: plan.creditsPerPeriod,
          topUpEnabled: plan.topUpEnabled,
          features: plan.features,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string }
        setMsg((m) => ({ ...m, [plan.code]: `Error: ${err.message ?? res.status}` }))
        return
      }
      const updated = (await res.json()) as PlanAdminView
      patchPlan(plan.code, updated)
      setMsg((m) => ({ ...m, [plan.code]: 'Saved.' }))
    } finally {
      setSavingCode(null)
    }
  }

  if (!loaded) return <CardSkeleton rows={5} />

  return (
    <div>
      <SectionHeader
        title="Plans & Features"
        subtitle="Pricing, availability, feature access and usage limits — all stored in the database, no code/env changes."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {plans.map((plan) => (
          <Panel key={plan.code}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              <strong style={{ fontSize: '1.05rem', fontFamily: 'Orbitron, sans-serif' }}>
                {plan.name} <span style={{ opacity: 0.4, fontWeight: 400 }}>({plan.code})</span>
              </strong>

              <Field label="Price ($/mo)">
                <input
                  type="number"
                  min={0}
                  className="admin-input"
                  style={{ width: 100 }}
                  value={(plan.priceCents / 100).toString()}
                  onChange={(e) => patchPlan(plan.code, { priceCents: Math.max(0, Math.round(Number(e.target.value) * 100)) })}
                />
              </Field>

              <Field label="Availability">
                <select
                  className="admin-select"
                  value={plan.availability}
                  onChange={(e) => patchPlan(plan.code, { availability: e.target.value as PlanAdminView['availability'] })}
                >
                  <option value="active">active</option>
                  <option value="coming_soon">coming_soon</option>
                </select>
              </Field>

              <Field label="Max daily turns">
                <input
                  type="number"
                  min={0}
                  placeholder="∞"
                  className="admin-input"
                  style={{ width: 100 }}
                  value={plan.maxDailyTurns ?? ''}
                  onChange={(e) => patchPlan(plan.code, { maxDailyTurns: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })}
                />
              </Field>

              <Field label="Credits / period (30d)">
                <input
                  type="number"
                  min={0}
                  placeholder="—"
                  className="admin-input"
                  style={{ width: 150 }}
                  value={plan.creditsPerPeriod ?? ''}
                  onChange={(e) => patchPlan(plan.code, { creditsPerPeriod: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })}
                />
              </Field>

              <Field label="Top-up">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', height: 38 }}>
                  <input type="checkbox" checked={plan.topUpEnabled} onChange={(e) => patchPlan(plan.code, { topUpEnabled: e.target.checked })} /> enabled
                </label>
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.5rem' }}>
              {catalog.map((feat) => {
                const ent = plan.features[feat.key] ?? { enabled: false, limit: null }
                return (
                  <div key={feat.key} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.35rem 0' }}>
                    <input type="checkbox" checked={ent.enabled} onChange={(e) => patchFeature(plan.code, feat.key, { enabled: e.target.checked })} />
                    <span style={{ fontSize: '0.9rem' }} title={feat.description}>{feat.label}</span>
                    {feat.supportsLimit && (
                      <input
                        type="number"
                        min={0}
                        placeholder="∞"
                        className="admin-input"
                        style={{ width: 64, marginLeft: 'auto', padding: '4px 6px' }}
                        value={ent.limit ?? ''}
                        onChange={(e) => patchFeature(plan.code, feat.key, { limit: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })}
                        title="usage limit (blank = unlimited)"
                      />
                    )}
                  </div>
                )
              })}
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <button className="btn-primary" disabled={savingCode === plan.code} onClick={() => save(plan)}>
                {savingCode === plan.code ? 'Saving…' : 'Save'}
              </button>
              {msg[plan.code] && (
                <span style={{ fontSize: '0.85rem', color: msg[plan.code].startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>
                  {msg[plan.code]}
                </span>
              )}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  )
}
