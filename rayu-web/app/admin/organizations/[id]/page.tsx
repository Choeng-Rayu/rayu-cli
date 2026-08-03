'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Panel,
  SectionHeader,
  Skeleton,
  StatCard,
  StatGrid,
  TableScroll,
  fmtDate,
  fmtDateTime,
  statusTone,
  usd,
} from '../../../../components/admin/ui'
import {
  allocatedCredits,
  billingStatusLabel,
  poolUsedPct,
  type Team,
  type TeamInvite,
  type TeamMember,
} from '../../../../lib/team'
import { useAdmin } from '../../AdminProvider'

interface AdminTeamPayment {
  id: number
  planCode: string | null
  provider: string
  amountCents: number
  status: string
  createdAt: string
  paidAt: string | null
}

interface AdminTeamDetail extends Team {
  members: TeamMember[]
  invites: TeamInvite[]
  payments: AdminTeamPayment[]
}

type PendingAction = 'suspend' | 'resume' | 'renew' | null

/**
 * Team detail for a super-admin: roster with per-seat balances, the shared pool,
 * payment history, and the three oversight actions (suspend, resume, force a
 * period renewal). Suspending is reversible by design — it cancels the
 * subscription and deactivates seats, but destroys nothing.
 */
export default function AdminOrganizationDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const { apiFetch, token } = useAdmin()
  const [org, setOrg] = useState<AdminTeamDetail | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<PendingAction>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await apiFetch(`/admin/organizations/${id}`)
    if (res.ok) {
      setOrg((await res.json()) as AdminTeamDetail)
      setError('')
    } else {
      setError(`Could not load the team (${res.status})`)
    }
  }, [apiFetch, id])

  useEffect(() => {
    if (token) void load()
  }, [token, load])

  async function run(action: Exclude<PendingAction, null>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await apiFetch(`/admin/organizations/${id}/${action}`, { method: 'POST' })
      if (!res.ok) {
        setError(`Action failed (${res.status})`)
        return
      }
      setNotice(
        action === 'suspend'
          ? 'Team suspended — every member has lost access until it is resumed.'
          : action === 'resume'
            ? 'Team resumed. The owner’s seat is active again; other members re-join or are re-invited.'
            : 'Period renewed: the pool was re-seeded and every bucket reset to its quota.',
      )
      await load()
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const pool = org?.creditPool ?? null
  const activeMembers = (org?.members ?? []).filter((m) => m.status === 'active')

  return (
    <div>
      <SectionHeader
        title={org?.name ?? `Team ${id}`}
        subtitle={org ? `/${org.slug} · ${billingStatusLabel(org)}` : undefined}
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Link href="/admin/organizations" className="btn-ghost" style={{ padding: '6px 14px' }}>
              All teams
            </Link>
            <button className="btn-ghost" disabled={busy} onClick={() => setPending('renew')}>
              Renew period
            </button>
            {org?.status === 'suspended' ? (
              <button className="btn-ghost" disabled={busy} onClick={() => setPending('resume')}>
                Resume
              </button>
            ) : (
              <button
                className="btn-ghost"
                style={{ color: 'var(--red)' }}
                disabled={busy}
                onClick={() => setPending('suspend')}
              >
                Suspend
              </button>
            )}
          </div>
        }
      />

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', marginBottom: '1rem' }}>
          <p style={{ color: 'var(--red)', margin: 0 }}>{error}</p>
        </div>
      )}
      {notice && (
        <div className="card" style={{ borderColor: 'var(--green)', marginBottom: '1rem' }}>
          <p style={{ color: 'var(--green)', margin: 0 }}>{notice}</p>
        </div>
      )}

      {!org ? (
        <Skeleton height={240} />
      ) : (
        <>
          <StatGrid>
            <StatCard label="Members" value={activeMembers.length.toLocaleString()} />
            <StatCard
              label="Plan"
              value={org.plan?.name ?? '—'}
              hint={org.plan ? `${usd(org.plan.priceCents)}/mo` : undefined}
            />
            <StatCard
              label="Pool used"
              value={`${poolUsedPct(pool).toFixed(0)}%`}
              hint={pool ? `${pool.usedCredits.toLocaleString()} of ${pool.totalCredits.toLocaleString()}` : undefined}
            />
            <StatCard
              label="Allocated"
              value={allocatedCredits(org.members).toLocaleString()}
              hint="sum of member quotas"
            />
          </StatGrid>

          <Panel title="Team" style={{ marginTop: '1.25rem' }}>
            <div style={{ display: 'grid', gap: '0.4rem', fontSize: '0.88rem' }}>
              <Row label="SSO domain" value={org.ssoDomain ?? 'invite only'} />
              <Row label="Owner (user id)" value={String(org.adminId)} />
              <Row label="Status" value={<Badge tone={statusTone(org.status)}>{org.status}</Badge>} />
              <Row
                label="Subscription"
                value={
                  org.subscription
                    ? `${org.subscription.status} · ends ${fmtDate(org.subscription.currentPeriodEnd)}`
                    : 'none'
                }
              />
              <Row label="Pool period end" value={fmtDate(pool?.periodEnd ?? null)} />
              <Row label="Created" value={fmtDateTime(org.createdAt)} />
            </div>
          </Panel>

          <Panel title="Members" style={{ marginTop: '1.25rem' }}>
            {org.members.length === 0 ? (
              <EmptyState>No members.</EmptyState>
            ) : (
              <TableScroll>
                <table>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Role</th>
                      <th>Quota</th>
                      <th>Left</th>
                      <th>Joined</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {org.members.map((m) => (
                      <tr key={m.userId}>
                        <td>
                          <div>{m.displayName || m.email || `User ${m.userId}`}</div>
                          {m.email && <div style={{ opacity: 0.45, fontSize: '0.75rem' }}>{m.email}</div>}
                        </td>
                        <td>
                          <Badge>{m.role}</Badge>
                        </td>
                        <td style={{ fontFamily: 'DM Mono, monospace' }}>{m.bucketQuota.toLocaleString()}</td>
                        <td style={{ fontFamily: 'DM Mono, monospace' }}>{m.bucketCredits.toLocaleString()}</td>
                        <td style={{ fontSize: '0.8rem' }}>{fmtDate(m.joinedAt)}</td>
                        <td>
                          <Badge tone={statusTone(m.status === 'active' ? 'active' : 'warn')}>{m.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Panel>

          <Panel title="Pending invites" style={{ marginTop: '1.25rem' }}>
            {org.invites.filter((i) => i.status === 'pending').length === 0 ? (
              <EmptyState>No pending invites.</EmptyState>
            ) : (
              <TableScroll>
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {org.invites
                      .filter((i) => i.status === 'pending')
                      .map((i) => (
                        <tr key={i.id}>
                          <td>{i.email}</td>
                          <td>
                            <Badge>{i.role}</Badge>
                          </td>
                          <td style={{ fontSize: '0.8rem' }}>{fmtDate(i.expiresAt)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Panel>

          <Panel title="Payments" style={{ marginTop: '1.25rem' }}>
            {org.payments.length === 0 ? (
              <EmptyState>No team payments yet.</EmptyState>
            ) : (
              <TableScroll>
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Plan</th>
                      <th>Provider</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {org.payments.map((p) => (
                      <tr key={p.id}>
                        <td style={{ fontSize: '0.8rem' }}>{fmtDateTime(p.createdAt)}</td>
                        <td>{p.planCode ?? '—'}</td>
                        <td>{p.provider}</td>
                        <td style={{ fontFamily: 'DM Mono, monospace' }}>{usd(p.amountCents)}</td>
                        <td>
                          <Badge tone={statusTone(p.status === 'paid' ? 'active' : p.status)}>{p.status}</Badge>
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>{fmtDateTime(p.paidAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Panel>
        </>
      )}

      <ConfirmDialog
        open={pending === 'suspend'}
        title="Suspend this team?"
        message="Every member loses access immediately: the subscription is canceled and all seats are deactivated. Members with their own individual plan fall back to it. Nothing is deleted — you can resume the team afterwards."
        confirmLabel="Suspend"
        tone="danger"
        onConfirm={() => void run('suspend')}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'resume'}
        title="Resume this team?"
        message="The subscription is re-activated and the owner’s seat is restored. Other members re-join via SSO or a new invite."
        confirmLabel="Resume"
        onConfirm={() => void run('resume')}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'renew'}
        title="Renew the billing period?"
        message="The shared pool is re-seeded to the plan's allowance and every member's bucket is reset to their quota. Use this when a period has lapsed or after changing quotas."
        confirmLabel="Renew"
        onConfirm={() => void run('renew')}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', borderBottom: '1px solid var(--border)', padding: '0.4rem 0' }}>
      <span style={{ opacity: 0.55 }}>{label}</span>
      <span style={{ fontFamily: 'DM Mono, monospace' }}>{value}</span>
    </div>
  )
}
