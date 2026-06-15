import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from '@clerk/nextjs'
import Link from 'next/link'
import type { Metadata } from 'next'
import './globals.css'

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
    <html lang="en">
      <body>
        <ClerkProvider>
          <div className="site">
            <header className="nav">
              <Link href="/" className="nav-logo">
                <div className="nav-logo-mark" />
                RAYU
              </Link>
              <ul className="nav-links">
                <li><Link href="/plans">Plans</Link></li>
                <li><Link href="/chatbot">Terminal</Link></li>
                <li><a href="#">Docs</a></li>
              </ul>
              <div className="nav-actions">
                <Show when="signed-out">
                  <SignInButton><button className="btn-ghost">Sign in</button></SignInButton>
                  <SignUpButton><button className="btn-primary">Get Access →</button></SignUpButton>
                </Show>
                <Show when="signed-in">
                  <Link href="/admin" className="btn-ghost" style={{ marginRight: '8px' }}>Admin</Link>
                  <UserButton />
                </Show>
              </div>
            </header>
            {children}
          </div>
        </ClerkProvider>
      </body>
    </html>
  )
}
