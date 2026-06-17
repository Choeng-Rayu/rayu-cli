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
} from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import { FeedbackItem } from '../types'

const TYPES = ['all', 'bug', 'idea', 'other'] as const

interface FeedbackList {
  items: FeedbackItem[]
  total: number
  page: number
  pageSize: number
}

export default function FeedbackPage() {
  const { apiFetch, token } = useAdmin()
  const [data, setData] = useState<FeedbackList | null>(null)
  const [page, setPage] = useState(1)
  const [type, setType] = useState<(typeof TYPES)[number]>('all')

  const load = useCallback(async () => {
    const q = type === 'all' ? '' : `&type=${type}`
    const res = await apiFetch(`/admin/feedback?page=${page}&pageSize=20${q}`)
    if (res.ok) setData((await res.json()) as FeedbackList)
  }, [apiFetch, page, type])

  useEffect(() => {
    if (token) void load()
  }, [token, load])

  // Reset to page 1 when the filter changes.
  useEffect(() => {
    setPage(1)
  }, [type])

  return (
    <div>
      <SectionHeader
        title="Feedback"
        subtitle="Reports and ideas submitted by users."
        actions={
          <div className="seg">
            {TYPES.map((t) => (
              <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
                {t}
              </button>
            ))}
          </div>
        }
      />

      {!data ? (
        <Skeleton height={240} />
      ) : data.items.length === 0 ? (
        <EmptyState>No feedback yet.</EmptyState>
      ) : (
        <TableScroll>
          <table style={{ marginTop: 0 }}>
            <thead>
              <tr><th>Type</th><th>Message</th><th>Rating</th><th>User</th><th>Date</th></tr>
            </thead>
            <tbody>
              {data.items.map((f) => (
                <tr key={f.id}>
                  <td><Badge tone={f.type === 'bug' ? 'danger' : f.type === 'idea' ? 'active' : 'default'}>{f.type}</Badge></td>
                  <td style={{ maxWidth: 380, whiteSpace: 'pre-wrap' }}>{f.message}</td>
                  <td style={{ fontFamily: 'DM Mono, monospace' }}>{f.rating ?? '—'}</td>
                  <td>{f.userEmail ?? f.userName ?? `#${f.userId}`}</td>
                  <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>{fmtDate(f.createdAt)}</td>
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
