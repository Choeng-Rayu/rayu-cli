import React from 'react'
import Link from 'next/link'

export interface DocItem {
  slug: string
  filename: string
  title: string
}

export default function DocsLayout({
  children,
  docs,
  activeSlug,
}: {
  children: React.ReactNode
  docs: DocItem[]
  activeSlug: string
}) {
  return (
    <div style={{ display: 'flex', minHeight: 'calc(100vh - 64px)' }}>
      {/* Sidebar */}
      <aside style={{
        width: '300px',
        borderRight: '1px solid var(--border)',
        backgroundColor: 'rgba(3, 5, 7, 0.4)',
        backdropFilter: 'blur(8px)',
        padding: '2.5rem 2rem',
        overflowY: 'auto',
        position: 'sticky',
        top: '64px',
        height: 'calc(100vh - 64px)',
        flexShrink: 0,
      }}>
        <div style={{
          fontFamily: 'Orbitron, sans-serif',
          fontSize: '0.85rem',
          fontWeight: 'bold',
          letterSpacing: '2px',
          color: 'var(--green)',
          marginBottom: '2rem',
          textTransform: 'uppercase',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: 'var(--green)',
            boxShadow: '0 0 6px var(--green)',
          }} />
          Documentation
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {docs.map(doc => {
            const isActive = doc.slug === activeSlug
            return (
              <li key={doc.slug}>
                <Link
                  href={`/docs/${doc.slug}`}
                  style={{
                    display: 'block',
                    color: isActive ? '#ffffff' : 'var(--text)',
                    textDecoration: 'none',
                    fontSize: '0.9rem',
                    fontWeight: isActive ? '600' : '400',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    borderLeft: isActive ? '2px solid var(--green)' : '2px solid transparent',
                    backgroundColor: isActive ? 'rgba(0, 255, 136, 0.06)' : 'transparent',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {doc.title}
                </Link>
              </li>
            )
          })}
        </ul>
      </aside>

      {/* Content Area */}
      <main style={{
        flexGrow: 1,
        padding: '3rem 4rem 5rem 4rem',
        maxWidth: '960px',
        overflowY: 'auto',
      }}>
        <div style={{ position: 'relative', zIndex: 10 }}>
          {children}
        </div>
      </main>
    </div>
  )
}
