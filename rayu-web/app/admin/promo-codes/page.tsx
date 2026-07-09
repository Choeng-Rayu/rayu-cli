'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  CardSkeleton,
  ConfirmDialog,
  Field,
  Panel,
  SectionHeader,
  fmtDateTime,
} from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import { PromoCode } from '../types'

// Plans a code can be scoped to (empty selection = ALL plans). Mirrors the
// backend PLAN_CODES; free is included for completeness though codes normally
// target paid plans.
const PLAN_OPTIONS = ['basic', 'pro', 'pro_plus', 'max', 'enterprise', 'free']

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'inherit',
  fontSize: '0.9rem',
  width: '100%',
}

/** ISO string → value for <input type="datetime-local"> (YYYY-MM-DDTHH:mm). */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** datetime-local value → ISO string (or null when empty). */
function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

type Editable = Pick<
  PromoCode,
  | 'code'
  | 'description'
  | 'discountType'
  | 'discountValue'
  | 'appliesToPlans'
  | 'maxRedemptions'
  | 'startsAt'
  | 'endsAt'
  | 'active'
>

const EMPTY_DRAFT: Editable = {
  code: '',
  description: '',
  discountType: 'percent',
  discountValue: 10,
  appliesToPlans: [],
  maxRedemptions: null,
  startsAt: null,
  endsAt: null,
  active: true,
}

// A shared editor (used by both create + edit). Renders the promo fields.
function PromoFields({
  draft,
  onChange,
}: {
  draft: Editable
  onChange: (patch: Partial<Editable>) => void
}) {
  const plans = draft.appliesToPlans ?? []
  const togglePlan = (p: string) => {
    const next = plans.includes(p) ? plans.filter((x) => x !== p) : [...plans, p]
    onChange({ appliesToPlans: next })
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.9rem' }}>
      <Field label="Code">
        <input
          className="admin-input"
          style={inputStyle}
          value={draft.code}
          placeholder="rayu-cli"
          onChange={(e) => onChange({ code: e.target.value })}
        />
      </Field>
      <Field label="Description (optional)">
        <input
          className="admin-input"
          style={inputStyle}
          value={draft.description ?? ''}
          placeholder="Launch discount"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>
      <Field label="Discount type">
        <select
          className="admin-select"
          style={inputStyle}
          value={draft.discountType}
          onChange={(e) => onChange({ discountType: e.target.value as Editable['discountType'] })}
        >
          <option value="percent">Percent (%)</option>
          <option value="fixed">Fixed ($ off)</option>
        </select>
      </Field>
      <Field label={draft.discountType === 'percent' ? 'Percent (0-100)' : 'Amount off ($)'}>
        <input
          type="number"
          min={0}
          className="admin-input"
          style={inputStyle}
          value={
            draft.discountType === 'percent'
              ? draft.discountValue
              : (draft.discountValue / 100).toString()
          }
          onChange={(e) => {
            const raw = Number(e.target.value)
            const val =
              draft.discountType === 'percent'
                ? Math.max(0, Math.min(100, Math.round(raw)))
                : Math.max(0, Math.round(raw * 100)) // dollars → cents
            onChange({ discountValue: val })
          }}
        />
      </Field>
      <Field label="Max redemptions (blank = unlimited)">
        <input
          type="number"
          min={1}
          className="admin-input"
          style={inputStyle}
          placeholder="∞"
          value={draft.maxRedemptions ?? ''}
          onChange={(e) =>
            onChange({ maxRedemptions: e.target.value === '' ? null : Math.max(1, Math.round(Number(e.target.value))) })
          }
        />
      </Field>
      <Field label="Starts at (optional)">
        <input
          type="datetime-local"
          className="admin-input"
          style={inputStyle}
          value={toLocalInput(draft.startsAt)}
          onChange={(e) => onChange({ startsAt: fromLocalInput(e.target.value) })}
        />
      </Field>
      <Field label="Ends at (optional)">
        <input
          type="datetime-local"
          className="admin-input"
          style={inputStyle}
          value={toLocalInput(draft.endsAt)}
          onChange={(e) => onChange({ endsAt: fromLocalInput(e.target.value) })}
        />
      </Field>
      <Field label="Applies to plans (none = all plans)">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', paddingTop: 4 }}>
          {PLAN_OPTIONS.map((p) => (
            <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.82rem' }}>
              <input type="checkbox" checked={plans.includes(p)} onChange={() => togglePlan(p)} />
              {p}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Active (applied)">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', height: 38 }}>
          <input type="checkbox" checked={draft.active} onChange={(e) => onChange({ active: e.target.checked })} />
          {draft.active ? 'Applied — usable now' : 'Ended — not usable'}
        </label>
      </Field>
    </div>
  )
}

export default function PromoCodesPage() {
  const { apiFetch, token } = useAdmin()
  const [promos, setPromos] = useState<PromoCode[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<Editable>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<PromoCode | null>(null)

  const reload = useCallback(async () => {
    const res = await apiFetch('/admin/promo-codes')
    if (res.ok) setPromos((await res.json()) as PromoCode[])
    setLoaded(true)
  }, [apiFetch])

  useEffect(() => {
    if (token) void reload()
  }, [token, reload])

  function bodyFromDraft(d: Editable) {
    return {
      code: d.code.trim(),
      description: d.description?.trim() || null,
      discountType: d.discountType,
      discountValue: d.discountValue,
      appliesToPlans: (d.appliesToPlans ?? []).length ? d.appliesToPlans : null,
      maxRedemptions: d.maxRedemptions,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      active: d.active,
    }
  }

  async function create() {
    setCreating(true)
    setMsg((m) => ({ ...m, new: '' }))
    try {
      const res = await apiFetch('/admin/promo-codes', {
        method: 'POST',
        body: JSON.stringify(bodyFromDraft(draft)),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string }
        setMsg((m) => ({ ...m, new: `Error: ${err.message ?? res.status}` }))
        return
      }
      setDraft(EMPTY_DRAFT)
      await reload()
      setMsg((m) => ({ ...m, new: 'Created.' }))
    } finally {
      setCreating(false)
    }
  }

  function patchLocal(id: number, patch: Partial<PromoCode>) {
    setPromos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  async function save(promo: PromoCode) {
    setSavingId(promo.id)
    setMsg((m) => ({ ...m, [promo.id]: '' }))
    try {
      const res = await apiFetch(`/admin/promo-codes/${promo.id}`, {
        method: 'PATCH',
        body: JSON.stringify(bodyFromDraft(promo)),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string }
        setMsg((m) => ({ ...m, [promo.id]: `Error: ${err.message ?? res.status}` }))
        return
      }
      const updated = (await res.json()) as PromoCode
      patchLocal(promo.id, updated)
      setMsg((m) => ({ ...m, [promo.id]: 'Saved.' }))
    } finally {
      setSavingId(null)
    }
  }

  // Quick apply/end without opening the full editor.
  async function setActive(promo: PromoCode, active: boolean) {
    const res = await apiFetch(`/admin/promo-codes/${promo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active }),
    })
    if (res.ok) patchLocal(promo.id, (await res.json()) as PromoCode)
  }

  async function remove(promo: PromoCode) {
    setConfirmDelete(null)
    const res = await apiFetch(`/admin/promo-codes/${promo.id}`, { method: 'DELETE' })
    if (res.ok) setPromos((prev) => prev.filter((p) => p.id !== promo.id))
  }

  if (!loaded) return <CardSkeleton rows={6} />

  return (
    <div>
      <SectionHeader
        title="Promo Codes"
        subtitle="Create discount codes (percent or fixed $), scope them to plans, cap redemptions (first N accounts) or leave unlimited, set an active window, and apply/end them — all stored in the database."
      />

      {/* Create */}
      <Panel title="New promo code" style={{ marginBottom: '1.5rem' }}>
        <PromoFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn-primary" disabled={creating || !draft.code.trim()} onClick={create}>
            {creating ? 'Creating…' : 'Create promo code'}
          </button>
          {msg.new && (
            <span style={{ fontSize: '0.85rem', color: msg.new.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>
              {msg.new}
            </span>
          )}
        </div>
      </Panel>

      {/* List / edit */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {promos.length === 0 && <p style={{ opacity: 0.55 }}>No promo codes yet.</p>}
        {promos.map((promo) => (
          <Panel key={promo.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
              <strong style={{ fontSize: '1.05rem', fontFamily: 'Orbitron, sans-serif' }}>{promo.code}</strong>
              <span className={promo.active ? 'badge active' : 'badge'}>{promo.active ? 'Applied' : 'Ended'}</span>
              <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>
                {promo.discountType === 'percent'
                  ? `${promo.discountValue}% off`
                  : `$${(promo.discountValue / 100).toFixed(2)} off`}
                {' · '}
                {promo.maxRedemptions == null
                  ? `${promo.usedCount} used · unlimited`
                  : `${promo.usedCount}/${promo.maxRedemptions} used`}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                <button className="btn-ghost" style={{ padding: '4px 12px' }} onClick={() => setActive(promo, !promo.active)}>
                  {promo.active ? 'End' : 'Apply'}
                </button>
              </span>
            </div>

            <PromoFields draft={promo} onChange={(patch) => patchLocal(promo.id, patch)} />

            <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', opacity: 0.45 }}>
              Window: {fmtDateTime(promo.startsAt)} → {fmtDateTime(promo.endsAt)}
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <button className="btn-primary" disabled={savingId === promo.id} onClick={() => save(promo)}>
                {savingId === promo.id ? 'Saving…' : 'Save'}
              </button>
              <button
                className="btn-ghost"
                style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
                onClick={() => setConfirmDelete(promo)}
              >
                Delete
              </button>
              {msg[promo.id] && (
                <span style={{ fontSize: '0.85rem', color: msg[promo.id].startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>
                  {msg[promo.id]}
                </span>
              )}
            </div>
          </Panel>
        ))}
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete promo code"
        message={`Delete "${confirmDelete?.code}"? This cannot be undone. Existing redemptions are removed too.`}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
