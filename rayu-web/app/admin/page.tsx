'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { BarChart, Donut } from '../../components/Charts'
import {
  CardSkeleton,
  EmptyState,
  Panel,
  StatCard,
  StatGrid,
  TableScroll,
  fmtDate,
  usd,
} from '../../components/admin/ui'
import { useAdmin } from './AdminProvider'
import { AdminAnalytics, AdminUser, UserList } from './types'

export default function OverviewPage() {
  const { apiFetch, token } = useAdmin()
  const [a, setA] = useState<AdminAnalytics | null>(null)
  const [recent, setRecent] = useState<AdminUser[]>([])

  useEffect(() => {
    if (!token) return
    void (async () => {
      const [aRes, uRes] = await Promise.all([
        apiFetch('/admin/analytics'),
        apiFetch('/admin/users?pageSize=6'),
      ])
      if (aRes.ok) setA((await aRes.json()) as AdminAnalytics)
      if (uRes.ok) setRecent(((await uRes.json()) as UserList).items)
    })()
  }, [apiFetch, token])

  if (!a) {
    return (
      <div style={{ display: 'grid', gap: '1.25rem' }}>
        <CardSkeleton rows={2} />
        <CardSkeleton rows={4} />
      </div>
    )
  }

  const planSlices = a.planDistribution
    .filter((p) => p.users > 0)
    .map((p, i) => ({ label: p.name, value: p.users, color: ['#00FF88', '#36c5ff', '#ffbd2e', '#FF3366', '#9b8cff', '#00cc6e'][i % 6] }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
      <StatGrid>
        <StatCard label="Total Users" value={a.totals.totalUsers} />
        <StatCard label="Active (30d)" value={a.totals.activeUsers30d} />
        <StatCard label="Paid Users" value={a.paidVsFree.paid} />
        <StatCard label="Total Revenue" value={usd(a.revenue.totalCents)} hint={`${a.revenue.paidCount} payments`} />
        <StatCard label="Canceled Subs" value={a.canceledSubscriptions} />
      </StatGrid>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
        <Panel title="Revenue by month">
          {a.revenue.byMonth.length ? (
            <BarChart data={a.revenue.byMonth.map((m) => ({ label: m.month, value: m.cents }))} valueFormat={usd} />
          ) : (
            <EmptyState>No paid payments yet.</EmptyState>
          )}
        </Panel>
        <Panel title="New signups (30d)">
          <BarChart data={a.signupsByDay.map((d) => ({ label: d.date.slice(5), value: d.count }))} />
        </Panel>
        <Panel title="Plan distribution">
          <Donut data={planSlices} />
        </Panel>
        <Panel title="Paid vs Free">
          <Donut
            data={[
              { label: 'Free', value: a.paidVsFree.free, color: '#36c5ff' },
              { label: 'Paid', value: a.paidVsFree.paid, color: '#00FF88' },
            ]}
          />
        </Panel>
      </div>

      <Panel
        title="Recent signups"
        right={
          <Link href="/admin/users" className="admin-nav-link" style={{ opacity: 0.7, fontSize: '0.85rem' }}>
            View all →
          </Link>
        }
      >
        {recent.length === 0 ? (
          <EmptyState>No users yet.</EmptyState>
        ) : (
          <TableScroll>
            <table style={{ marginTop: 0 }}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link href={`/admin/users/${u.id}`} style={{ color: 'var(--green)' }}>
                        {u.email ?? '—'}
                      </Link>
                    </td>
                    <td>{u.displayName ?? '—'}</td>
                    <td style={{ textTransform: 'uppercase', fontSize: '0.8rem' }}>{u.role}</td>
                    <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>{fmtDate(u.createdAt)}</td>
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
