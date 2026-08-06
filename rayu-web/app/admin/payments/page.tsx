'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  EmptyState,
  Pagination,
  SectionHeader,
  Skeleton,
  TableScroll,
  fmtDate,
  statusTone,
  usd,
} from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import { PaymentItem } from '../types'

const STATUSES = ['all', 'paid', 'pending', 'failed'] as const

interface PaymentList {
  items: PaymentItem[]
  total: number
  page: number
  pageSize: number
}

export default function PaymentsPage() {
  const { apiFetch, token } = useAdmin()
  const [data, setData] = useState<PaymentList | null>(null)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all')

  const load = useCallback(async () => {
    const res = await apiFetch(`/admin/payments?page=${page}&pageSize=20`)
    if (res.ok) setData((await res.json()) as PaymentList)
  }, [apiFetch, page])

  useEffect(() => {
    if (token) void load()
  }, [token, load])

  const visible = (data?.items ?? []).filter((p) => status === 'all' || p.status === status)

  return (
    <div>
      <SectionHeader
        title="Payments"
        subtitle="All payment records across users."
        actions={
          <div className="seg">
            {STATUSES.map((s) => (
              <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
                {s}
              </button>
            ))}
          </div>
        }
      />

      {!data ? (
        <Skeleton height={240} />
      ) : visible.length === 0 ? (
        <EmptyState>No payments found.</EmptyState>
      ) : (
        <TableScroll>
          <table style={{ marginTop: 0 }}>
            <thead>
              <tr><th>ID</th><th>User</th><th>Plan</th><th>Provider</th><th>Amount</th><th>Status</th><th>Date</th></tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontFamily: 'DM Mono, monospace' }}>{p.id}</td>
                  <td>{p.userEmail ?? '—'}</td>
                  <td>{p.planCode ?? '—'}</td>
                  <td>{p.provider}</td>
                  <td style={{ fontFamily: 'DM Mono, monospace' }}>{usd(p.amountCents)}</td>
                  <td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                  <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>{fmtDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  )
}
