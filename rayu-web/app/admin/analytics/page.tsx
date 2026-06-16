'use client'

import { useCallback, useEffect, useState } from 'react'
import { BarChart, Donut, HBar, LineChart } from '../../../components/Charts'
import {
  CardSkeleton,
  EmptyState,
  Panel,
  StatCard,
  StatGrid,
  usd,
} from '../../../components/admin/ui'
import { useAdmin } from '../AdminProvider'
import { AdminAnalytics } from '../types'

const RANGES = [7, 30, 90]

export default function AnalyticsPage() {
  const { apiFetch, token } = useAdmin()
  const [a, setA] = useState<AdminAnalytics | null>(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  const load = useCallback(
    async (d: number) => {
      setLoading(true)
      const res = await apiFetch(`/admin/analytics?days=${d}`)
      if (res.ok) setA((await res.json()) as AdminAnalytics)
      setLoading(false)
    },
    [apiFetch],
  )

  useEffect(() => {
    if (token) void load(days)
  }, [token, days, load])

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
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <span style={{ marginRight: 'auto', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Time range
        </span>
        <div className="seg" style={{ opacity: loading ? 0.6 : 1 }} role="group" aria-label="Select time range">
          {RANGES.map((r) => (
            <button key={r} className={days === r ? 'active' : ''} aria-pressed={days === r} onClick={() => setDays(r)}>
              {r}d
            </button>
          ))}
        </div>
      </div>

      <StatGrid>
        <StatCard label="Total Users" value={a.totals.totalUsers} />
        <StatCard label={`Active (${days}d)`} value={a.totals.activeUsers30d} />
        <StatCard label="Paid Users" value={a.paidVsFree.paid} />
        <StatCard label="Revenue" value={usd(a.revenue.totalCents)} />
      </StatGrid>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem', minWidth: 0 }}>
        <Panel title={`Signups (last ${days} days)`}>
          <BarChart data={a.signupsByDay.map((d) => ({ label: d.date.slice(5), value: d.count }))} />
        </Panel>
        <Panel title={`Active users (last ${days} days)`}>
          <LineChart data={a.activeByDay.map((d) => ({ label: d.date, value: d.count }))} />
        </Panel>
        <Panel title="Revenue by month">
          {a.revenue.byMonth.length ? (
            <BarChart data={a.revenue.byMonth.map((m) => ({ label: m.month, value: m.cents }))} valueFormat={usd} />
          ) : (
            <EmptyState>No paid payments yet.</EmptyState>
          )}
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
        <Panel title="User status">
          <Donut
            data={[
              { label: 'Active', value: a.statusBreakdown.active, color: '#00FF88' },
              { label: 'Suspended', value: a.statusBreakdown.suspended, color: '#ffbd2e' },
              { label: 'Banned', value: a.statusBreakdown.banned, color: '#FF3366' },
            ]}
          />
        </Panel>
        <Panel title="Usage by provider">
          <HBar data={a.usageByProvider.map((u) => ({ label: u.provider, value: u.count }))} />
        </Panel>
        <Panel title="Top users by usage">
          <HBar
            data={a.topUsers.map((u) => ({ label: u.email ?? u.displayName ?? `#${u.id}`, value: u.count }))}
            color="#9b8cff"
          />
        </Panel>
      </div>
    </div>
  )
}
