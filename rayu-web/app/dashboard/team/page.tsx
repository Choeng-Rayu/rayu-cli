'use client'
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../../../lib/config'
import {
  billingStatusLabel,
  poolUsedPct,
  type TeamMembership,
} from '../../../lib/team'
import { useRayuToken } from '../../../lib/useRayuToken'

/**
 * "Your team" landing page: the memberships this account holds (0 or 1 in this
 * version) plus the create-a-team call to action.
 *
 * It talks to the backend DIRECTLY with the Rayu bearer token, which is the
 * pattern every other authenticated page here uses (see useRayuToken). There is
 * deliberately no Next.js API pass-through: adding one would mean a second place
 * that has to know about auth, and the browser already holds a token scoped to
 * exactly these endpoints.
 */
export default function TeamPage() {
  const { token, authError, status } = useRayuToken()
  const [teams, setTeams] = useState<TeamMembership[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(apiUrl('/organizations/mine'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setError(`Could not load your teams (${res.status})`)
        return
      }
      setTeams((await res.json()) as TeamMembership[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  if (status === 'unauthenticated') {
    return (
      <main className="container">
        <span className="section-eyebrow">TEAM</span>
        <h1 style={{ marginTop: '0.5rem' }}>Teams</h1>
        <p style={{ opacity: 0.6 }}>Please sign in to manage a team.</p>
      </main>
    )
  }

  return (
    <main className="container">
      <div style={{ marginBottom: '1.5rem' }}>
        <span className="section-eyebrow">TEAM</span>
        <h1 style={{ marginTop: '0.5rem', marginBottom: '0.35rem' }}>Teams</h1>
        <p style={{ opacity: 0.6, margin: 0 }}>
          One payment, many people: a team buys a single plan and shares its credit pool.
          Members sign in with their company Google account and join automatically.
        </p>
      </div>

      {(error || authError) && (
        <div
          className="card"
          style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '1.5rem' }}
        >
          <p style={{ color: 'var(--red)', margin: 0 }}>{error || authError}</p>
        </div>
      )}

      {teams == null ? (
        <p style={{ opacity: 0.5 }}>Loading…</p>
      ) : teams.length === 0 ? (
        <div className="card" style={{ borderColor: 'var(--border-bright)' }}>
          <h2 style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '1.1rem', marginTop: 0 }}>
            Create a team
          </h2>
          <ul style={{ opacity: 0.7, fontSize: '0.9rem', lineHeight: 1.9, paddingLeft: '1.2rem' }}>
            <li>You pay once for a team plan and become its admin</li>
            <li>Invite as many people as you like — the credit pool is the only limit</li>
            <li>Set a per-person credit quota, or let the pool split equally</li>
            <li>
              With Google Workspace, anyone signing in with your company domain joins
              automatically — no invite needed
            </li>
          </ul>
          <Link
            href="/dashboard/team/new"
            className="btn-primary"
            style={{ display: 'inline-block', padding: '10px 22px' }}
          >
            Create a team
          </Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {teams.map((m) => {
            const org = m.organization
            const pool = org.creditPool
            const pct = poolUsedPct(pool)
            return (
              <Link
                key={org.id}
                href={`/dashboard/team/${org.slug}`}
                className="card"
                style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '1.2rem', fontWeight: 700 }}>
                        {org.name}
                      </span>
                      <span className="badge">{m.role}</span>
                    </div>
                    <div style={{ opacity: 0.55, fontSize: '0.82rem', marginTop: 5 }}>
                      /{org.slug}
                      {org.ssoDomain ? ` · auto-join ${org.ssoDomain}` : ' · invite only'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.95rem' }}>
                      {pool ? `${pool.remainingCredits.toLocaleString()} / ${pool.totalCredits.toLocaleString()}` : '—'}
                    </div>
                    <div style={{ opacity: 0.5, fontSize: '0.75rem' }}>team credits left</div>
                  </div>
                </div>
                {pool && pool.totalCredits > 0 && (
                  <div style={{ marginTop: '0.9rem', height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: pct >= 90 ? 'var(--red)' : pct >= 75 ? '#f5a623' : 'var(--green)',
                      }}
                    />
                  </div>
                )}
                <div style={{ fontSize: '0.78rem', opacity: 0.55, marginTop: 8 }}>
                  {billingStatusLabel(org)}
                </div>
              </Link>
            )
          })}
          <p style={{ opacity: 0.45, fontSize: '0.78rem', margin: 0 }}>
            One team per account in this version. Leave your current team before creating another.
          </p>
        </div>
      )}
    </main>
  )
}
