'use client'

// Dependency-free SVG charts for the admin dashboard. No chart library — pure
// SVG so there are no peer-dependency/build concerns. Styling uses the site's
// CSS variables; each chart scales to its container width via a viewBox.

import React from 'react'

const ACCENT = 'var(--accent, #6d7cff)'
const ACCENT2 = 'var(--accent-2, #00d4aa)'
const GRID = 'var(--border, #232838)'
const MUTED = 'var(--text, #e6e9ef)'

function niceMax(max: number): number {
  if (max <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const n = max / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

export interface Point {
  label: string
  value: number
}

export function BarChart({
  data,
  height = 180,
  color = ACCENT,
  valueFormat = (n: number) => String(n),
}: {
  data: Point[]
  height?: number
  color?: string
  valueFormat?: (n: number) => string
}) {
  const W = 600
  const H = height
  const padL = 36
  const padB = 22
  const padT = 10
  const innerW = W - padL - 8
  const innerH = H - padB - padT
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)))
  const n = data.length || 1
  const slot = innerW / n
  const barW = Math.max(1, slot * 0.62)
  const tickEvery = Math.ceil(n / 8)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="bar chart" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((t) => {
        const y = padT + innerH * (1 - t)
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={W - 8} y2={y} stroke={GRID} strokeWidth={1} />
            <text x={4} y={y + 3} fill={MUTED} opacity={0.45} fontSize={9}>
              {valueFormat(Math.round(max * t))}
            </text>
          </g>
        )
      })}
      {data.map((d, i) => {
        const h = (d.value / max) * innerH
        const x = padL + i * slot + (slot - barW) / 2
        const y = padT + innerH - h
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={h} rx={2} fill={color}>
              <title>{`${d.label}: ${valueFormat(d.value)}`}</title>
            </rect>
            {i % tickEvery === 0 && (
              <text x={x + barW / 2} y={H - 8} fill={MUTED} opacity={0.5} fontSize={8} textAnchor="middle">
                {d.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function LineChart({
  data,
  height = 180,
  color = ACCENT2,
}: {
  data: Point[]
  height?: number
  color?: string
}) {
  const W = 600
  const H = height
  const padL = 36
  const padB = 22
  const padT = 10
  const innerW = W - padL - 8
  const innerH = H - padB - padT
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)))
  const n = data.length
  const x = (i: number) => padL + (n <= 1 ? 0 : (innerW * i) / (n - 1))
  const y = (v: number) => padT + innerH * (1 - v / max)
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.value)}`).join(' ')
  const area = `${line} L${x(n - 1)},${padT + innerH} L${x(0)},${padT + innerH} Z`
  const tickEvery = Math.ceil(n / 7)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="line chart" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((t) => {
        const yy = padT + innerH * (1 - t)
        return (
          <g key={t}>
            <line x1={padL} y1={yy} x2={W - 8} y2={yy} stroke={GRID} strokeWidth={1} />
            <text x={4} y={yy + 3} fill={MUTED} opacity={0.45} fontSize={9}>
              {Math.round(max * t)}
            </text>
          </g>
        )
      })}
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} />
      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.value)} r={2.4} fill={color}>
          <title>{`${d.label}: ${d.value}`}</title>
        </circle>
      ))}
      {data.map((d, i) =>
        i % tickEvery === 0 ? (
          <text key={`t${i}`} x={x(i)} y={H - 8} fill={MUTED} opacity={0.5} fontSize={8} textAnchor="middle">
            {d.label.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  )
}

export interface Slice {
  label: string
  value: number
  color: string
}

export function Donut({ data, size = 170 }: { data: Slice[]; size?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const r = size / 2
  const inner = r * 0.62
  const cx = r
  const cy = r
  let angle = -Math.PI / 2
  const arcs = data
    .filter((d) => d.value > 0)
    .map((d) => {
      const frac = d.value / total
      const a0 = angle
      const a1 = angle + frac * Math.PI * 2
      angle = a1
      const large = a1 - a0 > Math.PI ? 1 : 0
      const x0 = cx + r * Math.cos(a0)
      const y0 = cy + r * Math.sin(a0)
      const x1 = cx + r * Math.cos(a1)
      const y1 = cy + r * Math.sin(a1)
      const xi1 = cx + inner * Math.cos(a1)
      const yi1 = cy + inner * Math.sin(a1)
      const xi0 = cx + inner * Math.cos(a0)
      const yi0 = cy + inner * Math.sin(a0)
      return {
        path: `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${inner},${inner} 0 ${large} 0 ${xi0},${yi0} Z`,
        label: d.label,
        value: d.value,
        color: d.color,
      }
    })

  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="donut chart">
        {total === 0 ? (
          <circle cx={cx} cy={cy} r={(r + inner) / 2} fill="none" stroke={GRID} strokeWidth={r - inner} />
        ) : (
          arcs.map((a, i) => (
            <path key={i} d={a.path} fill={a.color}>
              <title>{`${a.label}: ${a.value}`}</title>
            </path>
          ))
        )}
        <text x={cx} y={cy + 4} textAnchor="middle" fill={MUTED} fontSize={16} fontWeight={700}>
          {total}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {data.map((d) => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, display: 'inline-block' }} />
            <span style={{ opacity: 0.8 }}>{d.label}</span>
            <span style={{ marginLeft: 'auto', fontFamily: 'DM Mono, monospace', opacity: 0.6 }}>{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function HBar({
  data,
  color = ACCENT,
  valueFormat = (n: number) => String(n),
}: {
  data: Point[]
  color?: string
  valueFormat?: (n: number) => string
}) {
  const max = Math.max(1, ...data.map((d) => d.value))
  if (data.length === 0) {
    return <p style={{ opacity: 0.4, fontSize: '0.9rem' }}>No data yet.</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {data.map((d) => (
        <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem' }}>
          <span style={{ width: 120, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.label}>
            {d.label}
          </span>
          <div style={{ flex: 1, background: GRID, borderRadius: 4, height: 14, overflow: 'hidden' }}>
            <div style={{ width: `${(d.value / max) * 100}%`, background: color, height: '100%' }} />
          </div>
          <span style={{ width: 64, textAlign: 'right', fontFamily: 'DM Mono, monospace', opacity: 0.7 }}>
            {valueFormat(d.value)}
          </span>
        </div>
      ))}
    </div>
  )
}
