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
          <header className="nav">
            <Link href="/" className="brand">
              Rayu
            </Link>
            <Link href="/plans">Plans</Link>
            <Link href="/chatbot">Chatbot</Link>
            <span className="spacer" />
            <Show when="signed-out">
              <SignInButton />
              <SignUpButton />
            </Show>
            <Show when="signed-in">
              <Link href="/admin">Admin</Link>
              <UserButton />
            </Show>
          </header>
          {children}
        </ClerkProvider>
      </body>
    </html>
  )
}
