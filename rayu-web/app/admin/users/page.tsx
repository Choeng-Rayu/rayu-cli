'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Pagination,
  SectionHeader,
  Skeleton,
  TableScroll,
  fmtDate,
  statusTone,
} from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import { AdminUser, UserList } from '../types'

const STATUSES = ['all', 'active', 'suspended', 'banned'] as const
const ACTIVITY = ['all', 'active', 'inactive'] as const

export default function UsersPage() {
  const { apiFetch, token } = useAdmin()
  const [data, setData] = useState<UserList | null>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all')
  const [activity, setActivity] = useState<(typeof ACTIVITY)[number]>('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulk, setBulk] = useState<{ status: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const actParam = activity === 'all' ? '' : `&activity=${activity}`
    const res = await apiFetch(
      `/admin/users?page=${page}&pageSize=20&search=${encodeURIComponent(query)}${actParam}`,
    )
    if (res.ok) setData((await res.json()) as UserList)
  }, [apiFetch, page, query, activity])

  useEffect(() => {
    if (token) void load()
  }, [token, load])

  const visible: AdminUser[] = (data?.items ?? []).filter(
    (u) => status === 'all' || u.status === status,
  )

  function toggle(id: number) {
    setSelected((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected((s) =>
      s.size === visible.length ? new Set() : new Set(visible.map((u) => u.id)),
    )
  }

  async function applyBulk(newStatus: string) {
    setBusy(true)
    try {
      await apiFetch('/admin/users/bulk-status', {
        method: 'PATCH',
        body: JSON.stringify({ ids: [...selected], status: newStatus }),
      })
      setSelected(new Set())
      setBulk(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <SectionHeader
        title="Users"
        subtitle="Search, moderate, and inspect accounts."
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div className="seg">
              {STATUSES.map((s) => (
                <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
                  {s}
                </button>
              ))}
            </div>
            <div className="seg" title="Activity in the last 30 days (from last-active time)">
              {ACTIVITY.map((a) => (
                <button
                  key={a}
                  className={activity === a ? 'active' : ''}
                  onClick={() => {
                    setPage(1)
                    setActivity(a)
                  }}
                >
                  {a === 'inactive' ? 'non-active' : a}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem' }}>
        <input
          className="admin-input"
          style={{ flex: 1 }}
          placeholder="Search by email or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(1)
              setQuery(search)
            }
          }}
        />
        <button className="btn-primary" onClick={() => { setPage(1); setQuery(search) }}>
          Search
        </button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="card" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>{selected.size} selected</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
            <button className="btn-ghost" style={{ padding: '6px 14px' }} onClick={() => setBulk({ status: 'active' })}>Activate</button>
            <button className="btn-ghost" style={{ padding: '6px 14px', color: '#ffbd2e', borderColor: 'rgba(255,189,46,0.3)' }} onClick={() => setBulk({ status: 'suspended' })}>Suspend</button>
            <button className="btn-ghost" style={{ padding: '6px 14px', color: 'var(--red)', borderColor: 'rgba(255,51,102,0.3)' }} onClick={() => setBulk({ status: 'banned' })}>Ban</button>
          </div>
        </div>
      )}

      {!data ? (
        <Skeleton height={240} />
      ) : visible.length === 0 ? (
        <EmptyState>No users match.</EmptyState>
      ) : (
        <TableScroll>
          <table style={{ marginTop: 0 }}>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={selected.size === visible.length && visible.length > 0} onChange={toggleAll} />
                </th>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Last active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <tr key={u.id}>
                  <td><input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} /></td>
                  <td>
                    <Link href={`/admin/users/${u.id}`} style={{ color: 'var(--green)' }}>{u.email ?? '—'}</Link>
                  </td>
                  <td>{u.displayName ?? '—'}</td>
                  <td style={{ textTransform: 'uppercase', fontSize: '0.8rem' }}>{u.role}</td>
                  <td><Badge tone={statusTone(u.status)}>{u.status}</Badge></td>
                  <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>{fmtDate(u.createdAt)}</td>
                  <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>
                    {u.lastActiveAt ? (
                      fmtDate(u.lastActiveAt)
                    ) : (
                      <span style={{ opacity: 0.5 }}>Never</span>
                    )}
                  </td>
                  <td><Link href={`/admin/users/${u.id}`} className="btn-ghost" style={{ padding: '4px 12px', fontSize: '0.8rem' }}>View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {data && (
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
      )}

      <ConfirmDialog
        open={!!bulk}
        title="Apply to selected users?"
        message={`Set ${selected.size} user(s) to "${bulk?.status}".`}
        confirmLabel={busy ? 'Working…' : 'Apply'}
        tone={bulk?.status === 'banned' ? 'danger' : 'default'}
        onConfirm={() => bulk && applyBulk(bulk.status)}
        onCancel={() => setBulk(null)}
      />
    </div>
  )
}
