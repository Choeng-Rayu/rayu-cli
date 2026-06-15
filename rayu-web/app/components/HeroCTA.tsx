'use client'

import { useState } from 'react'

const AVATARS = [
  { initials: 'AK', bg: '#1a2744', color: '#61afef' },
  { initials: 'SR', bg: '#2a1a2e', color: '#c678dd' },
  { initials: 'MJ', bg: '#1a2a1a', color: '#00FF88' },
  { initials: 'TL', bg: '#2a2218', color: '#e5c07b' },
]

export default function HeroCTA() {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText('npm install -g rayu').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <>
      <button
        onClick={copy}
        className="btn-terminal"
        title="Click to copy"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
      >
        {copied ? '✓ Copied!' : '$ npm install -g rayu'}
        <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{copied ? '' : '⎘'}</span>
      </button>

      {/* Social proof */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '3rem' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {AVATARS.map((a, i) => (
            <div key={i} style={{
              width: 32, height: 32, borderRadius: '50%',
              background: a.bg,
              border: '2px solid #030507',
              marginLeft: i === 0 ? 0 : -10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.65rem', fontWeight: 700, color: a.color,
              fontFamily: 'Inter, sans-serif',
              letterSpacing: '0.5px',
            }}>
              {a.initials}
            </div>
          ))}
        </div>
        <span style={{ fontSize: '0.9rem', color: 'var(--text)', opacity: 0.65 }}>
          Used by <strong style={{ color: '#ffffff', fontWeight: 600 }}>2,400+ engineers</strong> shipping agents today
        </span>
      </div>
    </>
  )
}
