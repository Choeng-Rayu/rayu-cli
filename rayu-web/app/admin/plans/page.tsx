'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  CardSkeleton,
  EmptyState,
  Field,
  Panel,
  SectionHeader,
  TableScroll,
  usd,
} from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import {
  AppSettings,
  CreditProjection,
  FeatureCatalogItem,
  FeatureEntitlement,
  PlanAdminView,
  PlanModelOption,
  PlansResponse,
} from '../types'

/**
 * Plans & Credits — one page for everything that decides what a customer gets
 * for their money: the subscription plans, what each plan may use, and the price
 * of a credit top-up.
 *
 * This replaces the old split between "Plans & Features" and "Credit Settings".
 * Those two pages described the same commercial decision from opposite ends: a
 * plan's credit allowance was meaningless without the credit↔token rate, and the
 * top-up price was meaningless without the plans it applies to. Editing them on
 * separate screens meant an admin could not see whether a change was coherent.
 *
 * Layout follows how a pricing decision is actually made:
 *   1. Plans        — price, allowance, limits, features, model access
 *   2. Credit top-up — what $1 buys when the allowance runs out
 *   3. Global limits & projection (collapsed) — the levers that are set once
 */
export default function PlansAndCreditsPage() {
  const { apiFetch, token } = useAdmin()
  const [catalog, setCatalog] = useState<FeatureCatalogItem[]>([])
  const [models, setModels] = useState<PlanModelOption[]>([])
  const [plans, setPlans] = useState<PlanAdminView[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [proj, setProj] = useState<CreditProjection | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [savingCode, setSavingCode] = useState<string | null>(null)
  const [showGlobals, setShowGlobals] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    const [pr, sr, cp] = await Promise.all([
      apiFetch('/admin/plans'),
      apiFetch('/admin/credit-settings'),
      apiFetch('/admin/credit-projection'),
    ])
    if (pr.ok) {
      const data = (await pr.json()) as PlansResponse
      setCatalog(data.catalog)
      setModels(data.models)
      setPlans(data.plans)
    }
    if (sr.ok) setSettings((await sr.json()) as AppSettings)
    if (cp.ok) setProj((await cp.json()) as CreditProjection)
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
  function toggleModel(code: string, modelCode: string, on: boolean) {
    setPlans((prev) =>
      prev.map((p) =>
        p.code !== code
          ? p
          : {
              ...p,
              allowedModelCodes: on
                ? [...p.allowedModelCodes, modelCode]
                : p.allowedModelCodes.filter((c) => c !== modelCode),
            },
      ),
    )
  }
  function patchSettings(patch: Partial<AppSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  /**
   * Save a plan. Two calls, because the two things live in different tables: the
   * plan row, then the per-model access list. Model access is written second so a
   * rejected plan patch never grants access to models the plan cannot bill for.
   */
  async function savePlan(plan: PlanAdminView) {
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
        const detail = await errorText(res)
        setMsg((m) => ({ ...m, [plan.code]: `Error: ${detail}` }))
        return
      }
      const access = await apiFetch(`/admin/plans/${plan.code}/models`, {
        method: 'PUT',
        body: JSON.stringify({ modelCodes: plan.allowedModelCodes }),
      })
      if (!access.ok) {
        const detail = await errorText(access)
        setMsg((m) => ({
          ...m,
          [plan.code]: `Plan saved, but model access failed: ${detail}`,
        }))
        await reload()
        return
      }
      setMsg((m) => ({ ...m, [plan.code]: 'Saved.' }))
      await reload()
    } finally {
      setSavingCode(null)
    }
  }

  async function saveSettings() {
    if (!settings) return
    setMsg((m) => ({ ...m, __settings: '' }))
    const res = await apiFetch('/admin/credit-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        baselineCreditsPer1M: settings.baselineCreditsPer1M,
        creditsPerDollar: settings.creditsPerDollar,
        minTopupCents: settings.minTopupCents,
        maxConcurrentStreams: settings.maxConcurrentStreams,
        maxTokensPerRequest: settings.maxTokensPerRequest,
        maxRequestsPer5h: settings.maxRequestsPer5h,
        baselineModelCode: settings.baselineModelCode ?? undefined,
        assumedInputRatio: settings.assumedInputRatio,
        assumedUsagePercent: settings.assumedUsagePercent,
        infraCostCentsPerUser: settings.infraCostCentsPerUser,
      }),
    })
    const detail = res.ok ? '' : await errorText(res)
    setMsg((m) => ({ ...m, __settings: res.ok ? 'Saved.' : `Error: ${detail}` }))
    if (res.ok) await reload()
  }

  // Models are grouped by provider so a long catalog stays scannable and it is
  // obvious when a whole provider is switched off for a plan.
  const modelsByProvider = useMemo(() => {
    const out = new Map<string, PlanModelOption[]>()
    for (const m of models) {
      const list = out.get(m.provider) ?? []
      list.push(m)
      out.set(m.provider, list)
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [models])

  if (!loaded || !settings) return <CardSkeleton rows={6} />

  const numInput = (key: keyof AppSettings, min = 0) => (
    <input
      type="number"
      min={min}
      className="admin-input"
      style={{ width: 160 }}
      value={settings[key] as number}
      onChange={(e) =>
        patchSettings({ [key]: Math.max(min, Math.round(Number(e.target.value))) } as Partial<AppSettings>)
      }
    />
  )

  const tokensPerCredit =
    settings.baselineCreditsPer1M > 0 ? Math.round(1_000_000 / settings.baselineCreditsPer1M) : 0
  const topupEnabled = settings.creditsPerDollar > 0
  const minCredits = topupEnabled
    ? Math.ceil((settings.minTopupCents / 100) * settings.creditsPerDollar)
    : 0

  return (
    <div>
      <SectionHeader
        title="Plans & Credits"
        subtitle="What a customer gets for their money: subscription plans, the models each plan may use, and the credit top-up price. All stored in the database — no code or env changes."
      />

      {/* 1. PLANS ------------------------------------------------------------ */}
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
                  onChange={(e) =>
                    patchPlan(plan.code, { priceCents: Math.max(0, Math.round(Number(e.target.value) * 100)) })
                  }
                />
              </Field>

              <Field label="Availability">
                <select
                  className="admin-select"
                  value={plan.availability}
                  onChange={(e) =>
                    patchPlan(plan.code, { availability: e.target.value as PlanAdminView['availability'] })
                  }
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
                  onChange={(e) =>
                    patchPlan(plan.code, {
                      maxDailyTurns: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))),
                    })
                  }
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
                  onChange={(e) =>
                    patchPlan(plan.code, {
                      creditsPerPeriod:
                        e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))),
                    })
                  }
                />
                {plan.creditsPerPeriod != null && tokensPerCredit > 0 && (
                  <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: 2 }}>
                    ≈ {(plan.creditsPerPeriod * tokensPerCredit).toLocaleString()} tokens at the baseline model
                  </div>
                )}
              </Field>

              <Field label="Top-up">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', height: 38 }}>
                  <input
                    type="checkbox"
                    checked={plan.topUpEnabled}
                    onChange={(e) => patchPlan(plan.code, { topUpEnabled: e.target.checked })}
                  />{' '}
                  can buy credits
                </label>
              </Field>
            </div>

            {/* Features */}
            <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.45, marginBottom: '0.4rem' }}>
              Features
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.5rem' }}>
              {catalog.map((feat) => {
                const ent = plan.features[feat.key] ?? { enabled: false, limit: null }
                return (
                  <div key={feat.key} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.35rem 0' }}>
                    <input
                      type="checkbox"
                      checked={ent.enabled}
                      onChange={(e) => patchFeature(plan.code, feat.key, { enabled: e.target.checked })}
                    />
                    <span style={{ fontSize: '0.9rem' }} title={feat.description}>
                      {feat.label}
                    </span>
                    {feat.supportsLimit && (
                      <input
                        type="number"
                        min={0}
                        placeholder="∞"
                        className="admin-input"
                        style={{ width: 64, marginLeft: 'auto', padding: '4px 6px' }}
                        value={ent.limit ?? ''}
                        onChange={(e) =>
                          patchFeature(plan.code, feat.key, {
                            limit: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))),
                          })
                        }
                        title="usage limit (blank = unlimited)"
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {/* Model access — the checklist that writes hosted_models.allowedPlanCodes */}
            <div
              style={{
                fontSize: '0.78rem',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                opacity: 0.45,
                margin: '1rem 0 0.4rem',
              }}
            >
              Model access <span style={{ textTransform: 'none', letterSpacing: 0 }}>({plan.allowedModelCodes.length} of {models.length})</span>
            </div>
            {models.length === 0 ? (
              <EmptyState>
                No hosted models yet — add a provider and its models on the Providers page first.
              </EmptyState>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
                {modelsByProvider.map(([provider, list]) => {
                  const allOn = list.every((m) => plan.allowedModelCodes.includes(m.code))
                  return (
                    <div
                      key={provider}
                      style={{
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 8,
                        padding: '0.6rem 0.7rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                        <strong style={{ fontSize: '0.82rem', opacity: 0.75 }}>{provider}</strong>
                        <button
                          className="btn-ghost"
                          style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                          onClick={() => {
                            for (const m of list) toggleModel(plan.code, m.code, !allOn)
                          }}
                        >
                          {allOn ? 'none' : 'all'}
                        </button>
                      </div>
                      {list.map((m) => (
                        <label
                          key={m.code}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', padding: '2px 0' }}
                          title={m.code}
                        >
                          <input
                            type="checkbox"
                            checked={plan.allowedModelCodes.includes(m.code)}
                            onChange={(e) => toggleModel(plan.code, m.code, e.target.checked)}
                          />
                          <span style={{ opacity: m.enabled ? 1 : 0.45 }}>{m.label}</span>
                          {!m.enabled && (
                            <span style={{ fontSize: '0.68rem', opacity: 0.5 }}>(disabled)</span>
                          )}
                        </label>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}

            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <button className="btn-primary" disabled={savingCode === plan.code} onClick={() => savePlan(plan)}>
                {savingCode === plan.code ? 'Saving…' : 'Save plan'}
              </button>
              {msg[plan.code] && (
                <span
                  style={{
                    fontSize: '0.85rem',
                    color: msg[plan.code].startsWith('Error') ? 'var(--red)' : 'var(--green)',
                  }}
                >
                  {msg[plan.code]}
                </span>
              )}
            </div>
          </Panel>
        ))}
      </div>

      {/* 2. CREDIT TOP-UP ---------------------------------------------------- */}
      <Panel title="Credit top-up" style={{ marginTop: '1.25rem' }}>
        <p style={{ opacity: 0.55, fontSize: '0.8rem', marginTop: 0 }}>
          What a customer pays when their plan allowance runs out. Only plans with “can buy credits” enabled can
          purchase. Set the rate to 0 to switch top-ups off everywhere.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem' }}>
          <Field label="Credits per $1">
            {numInput('creditsPerDollar')}
            <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: 2 }}>
              {topupEnabled ? `$1 = ${settings.creditsPerDollar.toLocaleString()} credits` : 'Top-up disabled'}
            </div>
          </Field>
          <Field label="Minimum purchase ($)">
            <input
              type="number"
              min={0.01}
              step={0.01}
              className="admin-input"
              style={{ width: 160 }}
              value={(settings.minTopupCents / 100).toString()}
              onChange={(e) =>
                patchSettings({ minTopupCents: Math.max(1, Math.round(Number(e.target.value) * 100)) })
              }
            />
            <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: 2 }}>
              {topupEnabled
                ? `Smallest purchase: ${usd(settings.minTopupCents)} = ${minCredits.toLocaleString()} credits`
                : '—'}
            </div>
          </Field>
          <Field label="What a top-up buys">
            <div style={{ fontSize: '0.85rem', opacity: 0.75, lineHeight: 1.6, paddingTop: 6 }}>
              {topupEnabled && tokensPerCredit > 0 ? (
                <>
                  $1 → {settings.creditsPerDollar.toLocaleString()} credits →{' '}
                  {(settings.creditsPerDollar * tokensPerCredit).toLocaleString()} tokens
                  <div style={{ fontSize: '0.72rem', opacity: 0.6 }}>at the baseline model (1× multiplier)</div>
                </>
              ) : (
                '—'
              )}
            </div>
          </Field>
        </div>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn-primary" onClick={saveSettings}>
            Save credit settings
          </button>
          {msg.__settings && (
            <span
              style={{ fontSize: '0.85rem', color: msg.__settings.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}
            >
              {msg.__settings}
            </span>
          )}
        </div>
      </Panel>

      {/* 3. GLOBAL LIMITS + PROJECTION (collapsed: set once, rarely touched) -- */}
      <Panel
        title="Global limits & projection"
        style={{ marginTop: '1.25rem' }}
        right={
          <button className="btn-ghost" style={{ fontSize: '0.8rem' }} onClick={() => setShowGlobals((v) => !v)}>
            {showGlobals ? 'Hide' : 'Show'}
          </button>
        }
      >
        {!showGlobals ? (
          <p style={{ opacity: 0.5, fontSize: '0.82rem', margin: 0 }}>
            Credit↔token baseline ({settings.baselineCreditsPer1M} credits / 1M tokens), abuse limits, and the
            profit projection.
          </p>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem' }}>
              <Field label="Baseline credits / 1M tokens">
                {numInput('baselineCreditsPer1M', 1)}
                <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: 2 }}>
                  1 credit = {tokensPerCredit ? tokensPerCredit.toLocaleString() : '—'} tokens
                </div>
              </Field>
              <Field label="Baseline model (= 1×)">
                <select
                  className="admin-select"
                  style={{ width: 200 }}
                  value={settings.baselineModelCode ?? ''}
                  onChange={(e) => patchSettings({ baselineModelCode: e.target.value || null })}
                >
                  <option value="">(cheapest enabled)</option>
                  {models.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Assumed input ratio (%)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="admin-input"
                  style={{ width: 160 }}
                  value={Math.round((settings.assumedInputRatio ?? 0.67) * 100)}
                  onChange={(e) =>
                    patchSettings({ assumedInputRatio: Math.min(1, Math.max(0, Number(e.target.value) / 100)) })
                  }
                />
                <div style={{ fontSize: '0.72rem', opacity: 0.45, marginTop: 2 }}>
                  Share of tokens that are input (rest = output) for cost blending.
                </div>
              </Field>
              <Field label="Assumed usage (% of cap)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="admin-input"
                  style={{ width: 160 }}
                  value={settings.assumedUsagePercent}
                  onChange={(e) =>
                    patchSettings({
                      assumedUsagePercent: Math.min(100, Math.max(0, Math.round(Number(e.target.value)))),
                    })
                  }
                />
              </Field>
              <Field label="Infra cost / user ($/mo)">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  className="admin-input"
                  style={{ width: 160 }}
                  value={(settings.infraCostCentsPerUser / 100).toString()}
                  onChange={(e) =>
                    patchSettings({ infraCostCentsPerUser: Math.max(0, Math.round(Number(e.target.value) * 100)) })
                  }
                />
              </Field>
            </div>

            <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.45, margin: '1.25rem 0 0.4rem' }}>
              Abuse limits (enforced by the hosted gateway · 0 = unlimited)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem' }}>
              <Field label="Max concurrent streams">{numInput('maxConcurrentStreams')}</Field>
              <Field label="Max tokens / request">{numInput('maxTokensPerRequest')}</Field>
              <Field label="Max requests / 5h">{numInput('maxRequestsPer5h')}</Field>
            </div>

            <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.45, margin: '1.25rem 0 0.4rem' }}>
              Profit projection (from current model prices)
            </div>
            {!proj || proj.plans.length === 0 ? (
              <EmptyState>No credit plans configured yet.</EmptyState>
            ) : (
              <TableScroll>
                <table style={{ marginTop: 0 }}>
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th>Revenue</th>
                      <th>Credits/mo</th>
                      <th>Worst cost/mo</th>
                      <th>Expected cost/mo</th>
                      <th>Margin (exp.)</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proj.plans.map((p) => (
                      <tr key={p.code}>
                        <td>
                          {p.name} <span style={{ opacity: 0.4 }}>({p.code})</span>
                        </td>
                        <td style={{ fontFamily: 'DM Mono, monospace' }}>{usd(p.priceCents)}</td>
                        <td style={{ fontFamily: 'DM Mono, monospace' }}>
                          {p.creditsPerPeriod?.toLocaleString() ?? '∞'}
                        </td>
                        <td style={{ fontFamily: 'DM Mono, monospace' }}>
                          {p.worstCaseMonthlyCostCents == null ? '—' : usd(p.worstCaseMonthlyCostCents)}
                        </td>
                        <td style={{ fontFamily: 'DM Mono, monospace' }}>
                          {p.expectedMonthlyCostCents == null ? '—' : usd(p.expectedMonthlyCostCents)}
                        </td>
                        <td
                          style={{
                            fontFamily: 'DM Mono, monospace',
                            color: (p.marginCents ?? 0) < 0 ? 'var(--red)' : 'inherit',
                          }}
                        >
                          {p.marginCents == null ? '—' : usd(p.marginCents)}
                        </td>
                        <td>
                          {p.marginNegative ? <Badge tone="danger">LOSS at cap</Badge> : <Badge tone="active">safe</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
            <p style={{ opacity: 0.5, fontSize: '0.8rem', marginTop: '0.75rem' }}>
              Worst cost = full allowance spent on the priciest allowed model. Expected = worst × assumed usage %.
              Margin = revenue − expected − infra. Tune the per-model credit charges on the Providers page to keep
              margin positive.
            </p>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <button className="btn-primary" onClick={saveSettings}>
                Save global settings
              </button>
              {msg.__settings && (
                <span
                  style={{
                    fontSize: '0.85rem',
                    color: msg.__settings.startsWith('Error') ? 'var(--red)' : 'var(--green)',
                  }}
                >
                  {msg.__settings}
                </span>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  )
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] }
  const message = Array.isArray(body.message) ? body.message.join(', ') : body.message
  return message ?? `${res.status}`
}
