'use client'

import React from 'react'

// ---- Section header ----
export function SectionHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: '1rem',
        marginBottom: '1.5rem',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: '1.5rem' }}>{title}</h2>
        {subtitle && (
          <p style={{ margin: '0.35rem 0 0', opacity: 0.55, fontSize: '0.9rem' }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div style={{ display: 'flex', gap: '0.5rem' }}>{actions}</div>}
    </div>
  )
}

// ---- Stat card ----
export function StatCard({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div className="stat-cell">
      <div className="stat-num" style={{ fontSize: '2rem' }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
      {hint && (
        <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', opacity: 0.45 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '1.25rem',
      }}
    >
      {children}
    </div>
  )
}

// ---- Panel (titled card, e.g. for charts) ----
export function Panel({
  title,
  right,
  children,
  style,
}: {
  title?: string
  right?: React.ReactNode
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div className="card" style={{ padding: '1.25rem', ...style }}>
      {(title || right) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '0.9rem',
          }}
        >
          {title && (
            <p
              style={{
                margin: 0,
                opacity: 0.55,
                fontSize: '0.8rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {title}
            </p>
          )}
          {right}
        </div>
      )}
      {children}
    </div>
  )
}
export type BadgeTone = 'default' | 'active' | 'warn' | 'danger'

export function Badge({ children, tone = 'default' }: { children: React.ReactNode; tone?: BadgeTone }) {
  const cls = tone === 'active' ? 'badge active' : tone === 'warn' ? 'badge warn' : tone === 'danger' ? 'badge danger' : 'badge'
  return <span className={cls}>{children}</span>
}

export function statusTone(status: string): BadgeTone {
  if (status === 'active' || status === 'paid') return 'active'
  if (status === 'suspended' || status === 'pending') return 'warn'
  if (status === 'banned' || status === 'failed') return 'danger'
  return 'default'
}

// ---- Table scroll wrapper (keeps wide tables responsive) ----
export function TableScroll({ children }: { children: React.ReactNode }) {
  return <div className="table-scroll">{children}</div>
}

// ---- Pagination ----
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (p: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
      <span style={{ opacity: 0.55, fontSize: '0.85rem', fontFamily: 'DM Mono, monospace' }}>
        {total} total · page {page}/{pages}
      </span>
      <button className="btn-ghost" style={{ padding: '6px 14px' }} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Prev
      </button>
      <button className="btn-ghost" style={{ padding: '6px 14px' }} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  )
}

// ---- Empty state ----
export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>
}

// ---- Skeleton ----
export function Skeleton({ height = 16, width = '100%', style }: { height?: number | string; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height, width, ...style }} />
}

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card">
      <Skeleton height={22} width="40%" />
      <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} height={14} />
        ))}
      </div>
    </div>
  )
}

// ---- Field wrapper ----
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="admin-field-label">{label}</span>
      {children}
    </label>
  )
}

// ---- Confirm dialog ----
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'default',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  tone?: BadgeTone
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p style={{ opacity: 0.75, fontSize: '0.92rem' }}>{message}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginTop: '1.25rem' }}>
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            style={tone === 'danger' ? { background: 'var(--red)', boxShadow: 'none', color: '#fff' } : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- formatting helpers ----
export const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
export const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
export const fmtDateTime = (d: string | null) => (d ? new Date(d).toLocaleString() : '—')
