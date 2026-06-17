import Link from 'next/link'
import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'
import NavAuth from './components/NavAuth'

export const metadata: Metadata = {
  title: 'Rayu — terminal AI coding agent',
  description:
    'Rayu CLI: a multi-provider terminal AI coding agent. Sign in to get started.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <div className="site">
            <header className="nav">
              <Link href="/" className="nav-logo">
                <div className="nav-logo-mark" />
                RAYU
              </Link>
              <ul className="nav-links" style={{ marginLeft: '2.5rem', marginRight: 'auto' }}>
                <li><Link href="/plans">Plans</Link></li>
                <li><Link href="/docs">Docs</Link></li>
                <li><Link href="/changelog">Changelog</Link></li>
              </ul>
              <div className="nav-actions">
                <NavAuth />
              </div>
            </header>
            {children}
          </div>
        </body>
      </html>
    </ClerkProvider>
  )
}
