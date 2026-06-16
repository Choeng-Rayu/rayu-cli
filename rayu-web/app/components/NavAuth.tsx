'use client'
import { SignInButton, UserButton, useAuth } from '@clerk/nextjs'
import Link from 'next/link'

export default function NavAuth() {
  const { isSignedIn, isLoaded } = useAuth()
  if (!isLoaded) return null
  if (isSignedIn) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link href="/billing" className="btn-primary">Billing</Link>
        <UserButton />
      </div>
    )
  }
  return (
    <SignInButton mode="modal">
      <button className="btn-primary">Sign in</button>
    </SignInButton>
  )
}
