'use client'

import Link from 'next/link'
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
} from '../../../components/admin/ui'
import { poolUsedPct, type Team } from '../../../lib/team'
import { useAdmin } from '../AdminProvider'

interface AdminTeam extends Team {
  memberCount: number
}

interface TeamList {
  items: AdminTeam[]
  total: number
  page: number
  pageSize: number
}

/** Super-admin oversight of teams: who exists, what they bought, how much is left. */
export default function AdminOrganizationsPage() {
  const { apiFetch, token } = useAdmin()
  const [data, setData] = useState<TeamList | null>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    const res = await apiFetch(
      `/admin/organizations?page=${page}&pageSize=20&search=${encodeURIComponent(query)}`,
    )
    if (res.ok) setData((await res.json()) as TeamList)
  }, [apiFetch, page, query])

  useEffect(() => {
    if (token) void load()
  }, [token, load])

  const items = data?.items ?? []

  return (
    <div>
      <SectionHeader
        title="Teams"
        subtitle="Organizations, their team plan, and their shared credit pool."
      />

      <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem' }}>
        <input
          className="admin-input"
          style={{ flex: 1 }}
          placeholder="Search by name, address, or SSO domain"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(1)
              setQuery(search)
            }
          }}
        />
        <button
          className="btn-ghost"
          onClick={() => {
            setPage(1)
            setQuery(search)
          }}
        >
          Search
        </button>
      </div>

      {!data ? (
        <Skeleton height={200} />
      ) : items.length === 0 ? (
        <EmptyState>No teams yet.</EmptyState>
      ) : (
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>SSO domain</th>
                <th>Members</th>
                <th>Plan</th>
                <th>Pool</th>
                <th>Created</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/admin/organizations/${o.id}`}>{o.name}</Link>
                    <div style={{ opacity: 0.45, fontSize: '0.75rem' }}>/{o.slug}</div>
                  </td>
                  <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>
                    {o.ssoDomain ?? '—'}
                  </td>
                  <td style={{ fontFamily: 'DM Mono, monospace' }}>{o.memberCount}</td>
                  <td>{o.plan ? o.plan.name : '—'}</td>
                  <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.82rem' }}>
                    {o.creditPool
                      ? `${o.creditPool.usedCredits.toLocaleString()} / ${o.creditPool.totalCredits.toLocaleString()} (${poolUsedPct(o.creditPool).toFixed(0)}%)`
                      : '—'}
                  </td>
                  <td style={{ fontSize: '0.8rem' }}>{fmtDate(o.createdAt)}</td>
                  <td>
                    <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {data && data.total > data.pageSize && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onPage={setPage}
        />
      )}
    </div>
  )
}
