'use client'
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiUrl } from '../../../../lib/config'
import { isValidSlug, normalizeDomainInput, slugify } from '../../../../lib/team'
import { useRayuToken } from '../../../../lib/useRayuToken'

/**
 * Create-a-team form. The slug is derived from the name but stays editable, and
 * both the slug and the SSO domain are validated with the SAME rules the backend
 * enforces (lib/team) so a mistake is caught before a round trip.
 */
export default function NewTeamPage() {
  const router = useRouter()
  const { token, status } = useRayuToken()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [domain, setDomain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const effectiveSlug = slugEdited ? slug : slugify(name)
  const slugOk = effectiveSlug === '' || isValidSlug(effectiveSlug)
  const canSubmit = !!token && name.trim().length > 0 && isValidSlug(effectiveSlug) && !busy

  async function submit() {
    if (!token) return
    setBusy(true)
    setError('')
    try {
      const body: Record<string, string> = { name: name.trim(), slug: effectiveSlug }
      const normalized = normalizeDomainInput(domain)
      if (normalized) body.ssoDomain = normalized
      const res = await fetch(apiUrl('/organizations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { message?: string | string[] }
        const msg = Array.isArray(e.message) ? e.message.join(', ') : e.message
        setError(msg ?? `Could not create the team (${res.status})`)
        return
      }
      const team = (await res.json()) as { slug: string }
      // Straight to the team page, where the next step (buy a team plan) is.
      router.push(`/dashboard/team/${team.slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (status === 'unauthenticated') {
    return (
      <main className="container">
        <span className="section-eyebrow">TEAM</span>
        <h1 style={{ marginTop: '0.5rem' }}>Create a team</h1>
        <p style={{ opacity: 0.6 }}>Please sign in first.</p>
      </main>
    )
  }

  return (
    <main className="container" style={{ maxWidth: 680 }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <span className="section-eyebrow">TEAM</span>
        <h1 style={{ marginTop: '0.5rem', marginBottom: '0.35rem' }}>Create a team</h1>
        <p style={{ opacity: 0.6, margin: 0 }}>
          You become the team admin. Nothing is charged yet — you pick a team plan on the
          next screen.
        </p>
      </div>

      {error && (
        <div
          className="card"
          style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '1.25rem' }}
        >
          <p style={{ color: 'var(--red)', margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="card" style={{ display: 'grid', gap: '1.1rem' }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>Team name</span>
          <input
            className="admin-input"
            placeholder="Acme Corp"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>Team address</span>
          <input
            className="admin-input"
            placeholder="acme-corp"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugEdited(true)
              setSlug(e.target.value)
            }}
          />
          <span style={{ fontSize: '0.75rem', opacity: slugOk ? 0.45 : 1, color: slugOk ? undefined : 'var(--red)' }}>
            {slugOk
              ? `rayucode.com/dashboard/team/${effectiveSlug || '…'}`
              : '3–64 characters: lowercase letters, digits and dashes, not starting or ending with a dash'}
          </span>
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
            Google Workspace domain <span style={{ opacity: 0.6 }}>(optional)</span>
          </span>
          <input
            className="admin-input"
            placeholder="company.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <span style={{ fontSize: '0.75rem', opacity: 0.45 }}>
            Anyone who signs in with a <strong>{normalizeDomainInput(domain) || '@company.com'}</strong> Google
            Workspace account joins this team automatically. Leave empty to invite people by
            email instead. Consumer domains (gmail.com and similar) cannot be used.
          </span>
        </label>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            className="btn-primary"
            style={{ padding: '10px 22px' }}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : 'Create team'}
          </button>
          <Link href="/dashboard/team" className="btn-ghost" style={{ padding: '9px 18px' }}>
            Cancel
          </Link>
        </div>
      </div>
    </main>
  )
}
