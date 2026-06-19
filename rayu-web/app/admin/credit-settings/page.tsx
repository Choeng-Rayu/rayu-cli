'use client'

import { useCallback, useEffect, useState } from 'react'
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
import { AppSettings, CreditProjection, HostedModel } from '../types'

export default function CreditSettingsPage() {
  const { apiFetch, token } = useAdmin()
  const [s, setS] = useState<AppSettings | null>(null)
  const [models, setModels] = useState<HostedModel[]>([])
  const [proj, setProj] = useState<CreditProjection | null>(null)
  const [msg, setMsg] = useState('')

  const reload = useCallback(async () => {
    const [sr, mr, pr] = await Promise.all([
      apiFetch('/admin/credit-settings'),
      apiFetch('/admin/models'),
      apiFetch('/admin/credit-projection'),
    ])
    if (sr.ok) setS((await sr.json()) as AppSettings)
    if (mr.ok) setModels((await mr.json()) as HostedModel[])
    if (pr.ok) setProj((await pr.json()) as CreditProjection)
  }, [apiFetch])

  useEffect(() => {
    if (token) void reload()
  }, [token, reload])

  function patch(p: Partial<AppSettings>) {
    setS((prev) => (prev ? { ...prev, ...p } : prev))
  }

  async function save() {
    if (!s) return
    setMsg('')
    const res = await apiFetch('/admin/credit-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        baselineCreditsPer1M: s.baselineCreditsPer1M,
        topupCentsPer1kCredits: s.topupCentsPer1kCredits,
        maxConcurrentStreams: s.maxConcurrentStreams,
        maxTokensPerRequest: s.maxTokensPerRequest,
        maxRequestsPer5h: s.maxRequestsPer5h,
        baselineModelCode: s.baselineModelCode ?? undefined,
        assumedInputRatio: s.assumedInputRatio,
        assumedUsagePercent: s.assumedUsagePercent,
        infraCostCentsPerUser: s.infraCostCentsPerUser,
      }),
    })
    if (res.ok) {
      setMsg('Saved.')
      await reload()
    } else {
      setMsg(`Error ${res.status}`)
    }
  }

  if (!s) return <CardSkeleton rows={4} />

  const numInput = (key: keyof AppSettings, min = 0) => (
    <input
      type="number"
      min={min}
      className="admin-input"
      style={{ width: 160 }}
      value={s[key] as number}
      onChange={(e) => patch({ [key]: Math.max(min, Math.round(Number(e.target.value))) } as Partial<AppSettings>)}
    />
  )

  return (
    <div>
      <SectionHeader title="Credit Settings" subtitle="Credit + abuse config and the profit/cost projection. All money is in USD." />

      <Panel title="Credit model">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem' }}>
          <Field label="Baseline credits / 1M tokens">
            {numInput('baselineCreditsPer1M', 1)}
            <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: 2 }}>
              1 credit = {s.baselineCreditsPer1M > 0 ? Math.round(1_000_000 / s.baselineCreditsPer1M).toLocaleString() : '—'} tokens
              {' '}(e.g. 50 credits = {s.baselineCreditsPer1M > 0 ? (50 * Math.round(1_000_000 / s.baselineCreditsPer1M)).toLocaleString() : '—'} tokens)
            </div>
          </Field>
          <Field label="Baseline model (= 1×)">
            <select className="admin-select" style={{ width: 200 }} value={s.baselineModelCode ?? ''} onChange={(e) => patch({ baselineModelCode: e.target.value || null })}>
              <option value="">(cheapest enabled)</option>
              {models.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Assumed input ratio (%)">
            <input type="number" min={0} max={100} className="admin-input" style={{ width: 160 }}
              value={Math.round((s.assumedInputRatio ?? 0.67) * 100)}
              onChange={(e) => patch({ assumedInputRatio: Math.min(1, Math.max(0, Number(e.target.value) / 100)) })} />
            <div style={{ fontSize: '0.72rem', opacity: 0.45, marginTop: 2 }}>Share of tokens that are input (rest = output) for cost blending.</div>
          </Field>
          <Field label="Assumed usage (% of cap)">
            <input type="number" min={0} max={100} className="admin-input" style={{ width: 160 }}
              value={s.assumedUsagePercent}
              onChange={(e) => patch({ assumedUsagePercent: Math.min(100, Math.max(0, Math.round(Number(e.target.value)))) })} />
            <div style={{ fontSize: '0.72rem', opacity: 0.45, marginTop: 2 }}>Expected average usage as a fraction of the weekly cap.</div>
          </Field>
          <Field label="Infra cost / user ($/mo)">
            <input type="number" min={0} step={0.01} className="admin-input" style={{ width: 160 }}
              value={(s.infraCostCentsPerUser / 100).toString()}
              onChange={(e) => patch({ infraCostCentsPerUser: Math.max(0, Math.round(Number(e.target.value) * 100)) })} />
          </Field>
          <Field label="Top-up price (¢ / 1k credits)">{numInput('topupCentsPer1kCredits')}</Field>
        </div>
      </Panel>

      {/* Profit projection (forward-looking, from current model prices) */}
      <Panel title="Profit projection (from current prices)" style={{ marginTop: '1.25rem' }}>
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
                    <td>{p.name} <span style={{ opacity: 0.4 }}>({p.code})</span></td>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>{usd(p.priceCents)}</td>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>{p.creditsPerPeriod?.toLocaleString() ?? '∞'}</td>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>{p.worstCaseMonthlyCostCents == null ? '—' : usd(p.worstCaseMonthlyCostCents)}</td>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>{p.expectedMonthlyCostCents == null ? '—' : usd(p.expectedMonthlyCostCents)}</td>
                    <td style={{ fontFamily: 'DM Mono, monospace', color: (p.marginCents ?? 0) < 0 ? 'var(--red)' : 'inherit' }}>{p.marginCents == null ? '—' : usd(p.marginCents)}</td>
                    <td>{p.marginNegative ? <Badge tone="danger">LOSS at cap</Badge> : <Badge tone="active">safe</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <p style={{ opacity: 0.5, fontSize: '0.8rem', marginTop: '0.75rem' }}>
          Worst cost = full weekly allowance spent on the priciest allowed model. Expected = worst × assumed usage %. Margin = revenue − expected − infra. Tune the multipliers on the Models page to keep margin positive.
        </p>
      </Panel>

      <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button className="btn-primary" onClick={save}>Save settings</button>
        {msg && <span style={{ fontSize: '0.85rem', color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
      </div>
    </div>
  )
}
