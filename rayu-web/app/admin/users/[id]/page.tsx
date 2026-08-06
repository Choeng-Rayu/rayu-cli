'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  EmptyState,
  Field,
  Panel,
  Skeleton,
  TableScroll,
  fmtDate,
  fmtDateTime,
  statusTone,
  usd,
} from '../../../../components/admin/ui'
import { useAdmin } from '../../AdminProvider'
import { PaymentItem, PlanAdminView, UserDetail } from '../../types'

export default function UserDetailPage() {
  const { apiFetch, token } = useAdmin()
  const params = useParams<{ id: string }>()
  const id = params.id
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [payments, setPayments] = useState<PaymentItem[]>([])
  const [planCodes, setPlanCodes] = useState<string[]>([])
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const [d, p, plans] = await Promise.all([
      apiFetch(`/admin/users/${id}`),
      apiFetch(`/admin/users/${id}/payments`),
      apiFetch('/admin/plans'),
    ])
    if (d.ok) setDetail((await d.json()) as UserDetail)
    if (p.ok) setPayments(((await p.json()) as { items: PaymentItem[] }).items)
    if (plans.ok) setPlanCodes(((await plans.json()) as { plans: PlanAdminView[] }).plans.map((x) => x.code))
  }, [apiFetch, id])

  useEffect(() => {
    if (token) void load()
  }, [token, load])

  async function changePlan(code: string) {
    setMsg('')
    const res = await apiFetch(`/admin/users/${id}/plan`, {
      method: 'PATCH',
      body: JSON.stringify({ planCode: code }),
    })
    setMsg(res.ok ? 'Plan updated.' : `Error (${res.status})`)
    if (res.ok) await load()
  }

  async function changeStatus(status: string) {
    setMsg('')
    const res = await apiFetch(`/admin/users/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
    setMsg(res.ok ? 'Status updated.' : `Error (${res.status})`)
    if (res.ok) await load()
  }

  if (!detail) return <Skeleton height={300} />

  const u = detail.user

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <Link href="/admin/users" className="admin-nav-link" style={{ opacity: 0.7, width: 'fit-content' }}>
        ← Back to users
      </Link>

      <Panel title={`User #${u.id}`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.25rem' }}>
          <Field label="Email"><div>{u.email ?? '—'}</div></Field>
          <Field label="Name"><div>{u.displayName ?? '—'}</div></Field>
          <Field label="Role"><div style={{ textTransform: 'uppercase' }}>{u.role}</div></Field>
          <Field label="Status"><Badge tone={statusTone(u.status)}>{u.status}</Badge></Field>
          <Field label="Plan"><div>{detail.plan ? `${detail.plan.name} (${usd(detail.plan.priceCents)})` : '—'}</div></Field>
          <Field label="Joined"><div>{fmtDate(u.createdAt)}</div></Field>
          <Field label="Last active"><div>{fmtDateTime(u.lastActiveAt)}</div></Field>
        </div>
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
        <Panel title="Change plan (admin override)">
          <Field label="Plan">
            <select className="admin-select" defaultValue={detail.plan?.code ?? 'free'} onChange={(e) => changePlan(e.target.value)} style={{ width: '100%' }}>
              {planCodes.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </Panel>

        <Panel title="Moderation">
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn-ghost" onClick={() => changeStatus('active')}>Activate</button>
            <button className="btn-ghost" style={{ color: '#ffbd2e', borderColor: 'rgba(255,189,46,0.3)' }} onClick={() => changeStatus('suspended')}>Suspend</button>
            <button className="btn-ghost" style={{ color: 'var(--red)', borderColor: 'rgba(255,51,102,0.3)' }} onClick={() => changeStatus('banned')}>Ban</button>
          </div>
        </Panel>
      </div>

      {msg && <p style={{ color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)', fontSize: '0.9rem' }}>{msg}</p>}

      <Panel title="Payment history">
        {payments.length === 0 ? (
          <EmptyState>No payments on record.</EmptyState>
        ) : (
          <TableScroll>
            <table style={{ marginTop: 0 }}>
              <thead>
                <tr><th>ID</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>{p.id}</td>
                    <td>{p.planCode ?? '—'}</td>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>{usd(p.amountCents)}</td>
                    <td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                    <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>{fmtDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  )
}
