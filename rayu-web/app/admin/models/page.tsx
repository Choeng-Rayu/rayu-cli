'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  CardSkeleton,
  ConfirmDialog,
  Field,
  Panel,
  SectionHeader,
} from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import { CreditProjection, HostedModel, PlanAdminView, ProjectionModel } from '../types'

type Draft = Omit<HostedModel, 'id'>

const BLANK: Draft = {
  code: '',
  label: '',
  provider: 'deepseek',
  upstreamBaseUrl: '',
  upstreamModelId: '',
  inputPricePer1MCents: 0,
  outputPricePer1MCents: 0,
  creditMultiplier: 1,
  allowedPlanCodes: [],
  enabled: true,
}

export default function ModelsPage() {
  const { apiFetch, token } = useAdmin()
  const [models, setModels] = useState<HostedModel[]>([])
  const [planCodes, setPlanCodes] = useState<string[]>([])
  const [proj, setProj] = useState<Record<string, ProjectionModel>>({})
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [del, setDel] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [m, p, pr] = await Promise.all([
      apiFetch('/admin/models'),
      apiFetch('/admin/plans'),
      apiFetch('/admin/credit-projection'),
    ])
    if (m.ok) setModels((await m.json()) as HostedModel[])
    if (p.ok) setPlanCodes(((await p.json()) as { plans: PlanAdminView[] }).plans.map((x) => x.code))
    if (pr.ok) {
      const data = (await pr.json()) as CreditProjection
      setProj(Object.fromEntries(data.models.map((x) => [x.code, x])))
    }
    setLoaded(true)
  }, [apiFetch])

  useEffect(() => {
    if (token) void reload()
  }, [token, reload])

  function patchModel(code: string, patch: Partial<HostedModel>) {
    setModels((prev) => prev.map((m) => (m.code === code ? { ...m, ...patch } : m)))
  }
  function toggleAllowed(codes: string[] | null, plan: string): string[] {
    const set = new Set(codes ?? [])
    set.has(plan) ? set.delete(plan) : set.add(plan)
    return [...set]
  }

  async function save(m: HostedModel) {
    setMsg((x) => ({ ...x, [m.code]: '' }))
    const res = await apiFetch(`/admin/models/${m.code}`, {
      method: 'PATCH',
      body: JSON.stringify({
        label: m.label,
        provider: m.provider,
        upstreamBaseUrl: m.upstreamBaseUrl,
        upstreamModelId: m.upstreamModelId,
        inputPricePer1MCents: m.inputPricePer1MCents,
        outputPricePer1MCents: m.outputPricePer1MCents,
        creditMultiplier: m.creditMultiplier,
        allowedPlanCodes: m.allowedPlanCodes ?? [],
        enabled: m.enabled,
      }),
    })
    setMsg((x) => ({ ...x, [m.code]: res.ok ? 'Saved.' : `Error ${res.status}` }))
  }

  async function create() {
    setMsg((x) => ({ ...x, __new: '' }))
    const res = await apiFetch('/admin/models', { method: 'POST', body: JSON.stringify(draft) })
    if (res.ok) {
      setDraft(BLANK)
      await reload()
    } else {
      const e = (await res.json().catch(() => ({}))) as { message?: string | string[] }
      setMsg((x) => ({ ...x, __new: `Error: ${Array.isArray(e.message) ? e.message.join(', ') : e.message ?? res.status}` }))
    }
  }

  async function remove(code: string) {
    await apiFetch(`/admin/models/${code}`, { method: 'DELETE' })
    setDel(null)
    await reload()
  }

  if (!loaded) return <CardSkeleton rows={5} />

  const allowedCheckboxes = (codes: string[] | null, onToggle: (plan: string) => void) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      {planCodes.map((pc) => (
        <label key={pc} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem' }}>
          <input type="checkbox" checked={(codes ?? []).includes(pc)} onChange={() => onToggle(pc)} />
          {pc}
        </label>
      ))}
    </div>
  )

  return (
    <div>
      <SectionHeader
        title="Hosted Models"
        subtitle="The upstream models Rayu resells. Prices, credit multiplier, and plan access are all editable here — never hardcoded."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {models.map((m) => (
          <Panel key={m.code}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <strong style={{ fontFamily: 'Orbitron, sans-serif' }}>{m.label} <span style={{ opacity: 0.4 }}>({m.code})</span></strong>
              <label style={{ marginLeft: 'auto', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={m.enabled} onChange={(e) => patchModel(m.code, { enabled: e.target.checked })} /> enabled
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
              <Field label="Label"><input className="admin-input" style={{ width: '100%' }} value={m.label} onChange={(e) => patchModel(m.code, { label: e.target.value })} /></Field>
              <Field label="Provider"><input className="admin-input" style={{ width: '100%' }} value={m.provider} onChange={(e) => patchModel(m.code, { provider: e.target.value })} /></Field>
              <Field label="Upstream base URL"><input className="admin-input" style={{ width: '100%' }} value={m.upstreamBaseUrl} onChange={(e) => patchModel(m.code, { upstreamBaseUrl: e.target.value })} /></Field>
              <Field label="Upstream model id"><input className="admin-input" style={{ width: '100%' }} value={m.upstreamModelId} onChange={(e) => patchModel(m.code, { upstreamModelId: e.target.value })} /></Field>
              <Field label="Input ¢/1M"><input type="number" min={0} className="admin-input" style={{ width: '100%' }} value={m.inputPricePer1MCents} onChange={(e) => patchModel(m.code, { inputPricePer1MCents: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
              <Field label="Output ¢/1M"><input type="number" min={0} className="admin-input" style={{ width: '100%' }} value={m.outputPricePer1MCents} onChange={(e) => patchModel(m.code, { outputPricePer1MCents: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
              <Field label="Credit multiplier"><input type="number" min={0} step={0.1} className="admin-input" style={{ width: '100%' }} value={m.creditMultiplier} onChange={(e) => patchModel(m.code, { creditMultiplier: Math.max(0, Number(e.target.value)) })} /></Field>
            </div>
            {proj[m.code] && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <span>
                  Suggested ×{proj[m.code].suggestedMultiplier} · ${(proj[m.code].blendedCentsPer1M / 100).toFixed(2)}/1M · {proj[m.code].costPerCreditCents.toFixed(5)}¢/credit
                </span>
                {Math.abs(proj[m.code].suggestedMultiplier - m.creditMultiplier) > 0.01 && (
                  <button
                    className="btn-ghost"
                    style={{ padding: '2px 10px', fontSize: '0.78rem', color: 'var(--green)', borderColor: 'var(--border-bright)' }}
                    onClick={() => patchModel(m.code, { creditMultiplier: proj[m.code].suggestedMultiplier })}
                  >
                    Apply ×{proj[m.code].suggestedMultiplier}
                  </button>
                )}
              </div>
            )}
            <div style={{ marginTop: '0.75rem' }}>
              <span className="admin-field-label">Allowed plans</span>
              {allowedCheckboxes(m.allowedPlanCodes, (plan) => patchModel(m.code, { allowedPlanCodes: toggleAllowed(m.allowedPlanCodes, plan) }))}
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              <button className="btn-primary" onClick={() => save(m)}>Save</button>
              <button className="btn-ghost" style={{ color: 'var(--red)', borderColor: 'rgba(255,51,102,0.3)' }} onClick={() => setDel(m.code)}>Delete</button>
              {msg[m.code] && <span style={{ fontSize: '0.85rem', color: msg[m.code].startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg[m.code]}</span>}
            </div>
          </Panel>
        ))}

        <Panel title="Add a model">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
            <Field label="Code"><input className="admin-input" style={{ width: '100%' }} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} /></Field>
            <Field label="Label"><input className="admin-input" style={{ width: '100%' }} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Field>
            <Field label="Provider"><input className="admin-input" style={{ width: '100%' }} value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })} /></Field>
            <Field label="Upstream base URL"><input className="admin-input" style={{ width: '100%' }} value={draft.upstreamBaseUrl} onChange={(e) => setDraft({ ...draft, upstreamBaseUrl: e.target.value })} /></Field>
            <Field label="Upstream model id"><input className="admin-input" style={{ width: '100%' }} value={draft.upstreamModelId} onChange={(e) => setDraft({ ...draft, upstreamModelId: e.target.value })} /></Field>
            <Field label="Input ¢/1M"><input type="number" min={0} className="admin-input" style={{ width: '100%' }} value={draft.inputPricePer1MCents} onChange={(e) => setDraft({ ...draft, inputPricePer1MCents: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
            <Field label="Output ¢/1M"><input type="number" min={0} className="admin-input" style={{ width: '100%' }} value={draft.outputPricePer1MCents} onChange={(e) => setDraft({ ...draft, outputPricePer1MCents: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
            <Field label="Credit multiplier"><input type="number" min={0} step={0.1} className="admin-input" style={{ width: '100%' }} value={draft.creditMultiplier} onChange={(e) => setDraft({ ...draft, creditMultiplier: Math.max(0, Number(e.target.value)) })} /></Field>
          </div>
          <div style={{ marginTop: '0.75rem' }}>
            <span className="admin-field-label">Allowed plans</span>
            {allowedCheckboxes(draft.allowedPlanCodes, (plan) => setDraft({ ...draft, allowedPlanCodes: toggleAllowed(draft.allowedPlanCodes, plan) }))}
          </div>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
            <button className="btn-primary" disabled={!draft.code} onClick={create}>Create model</button>
            {msg.__new && <span style={{ fontSize: '0.85rem', color: 'var(--red)' }}>{msg.__new}</span>}
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        open={!!del}
        title="Delete model?"
        message={`Remove "${del}" from the catalog. This does not affect past usage.`}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => del && remove(del)}
        onCancel={() => setDel(null)}
      />
    </div>
  )
}
