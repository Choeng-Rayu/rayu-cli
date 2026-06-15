'use client'

import { SignInButton, useAuth } from '@clerk/nextjs'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiUrl } from '../../lib/config'
import { buildLoopbackRedirect, parseCliLoginParams } from '../../lib/cliLogin'

type Phase = 'loading' | 'invalid' | 'signin' | 'exchanging' | 'done' | 'error'

function CliLoginInner() {
  const search = useSearchParams()
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState<string>('')
  const started = useRef(false)

  const params = parseCliLoginParams(search)

  useEffect(() => {
    if (!isLoaded) return
    if (!params) {
      setPhase('invalid')
      return
    }
    if (!isSignedIn) {
      setPhase('signin')
      return
    }
    if (started.current) return
    started.current = true
    setPhase('exchanging')
    void (async () => {
      try {
        const clerkToken = await getToken()
        if (!clerkToken) throw new Error('Could not get a Clerk session token')
        const res = await fetch(apiUrl('/cli/exchange'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${clerkToken}`,
          },
          body: JSON.stringify({ state: params.state }),
        })
        if (!res.ok) {
          throw new Error(`Exchange failed (${res.status})`)
        }
        const { code } = (await res.json()) as { code: string }
        const redirect = buildLoopbackRedirect(params.port, code, params.state)
        setPhase('done')
        // Hand the code back to the waiting CLI on 127.0.0.1.
        window.location.href = redirect
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
  }, [isLoaded, isSignedIn, params, getToken])

  return (
    <main className="container">
      <h1>Connect Rayu CLI</h1>
      <div className="card" style={{ marginTop: '1.5rem' }}>
        {phase === 'loading' && <p>Loading…</p>}
        {phase === 'invalid' && (
          <p style={{ color: 'var(--muted)' }}>
            This page must be opened by the Rayu CLI. Missing or invalid login
            parameters.
          </p>
        )}
        {phase === 'signin' && (
          <>
            <p>Sign in to connect your terminal:</p>
            <SignInButton
              forceRedirectUrl={
                typeof window !== 'undefined'
                  ? window.location.href
                  : undefined
              }
            >
              <button className="btn">Sign in to continue</button>
            </SignInButton>
          </>
        )}
        {phase === 'exchanging' && <p>Authorizing your terminal…</p>}
        {phase === 'done' && (
          <p>
            Success! You can return to your terminal. If it doesn&apos;t
            continue automatically, you may close this tab.
          </p>
        )}
        {phase === 'error' && (
          <p style={{ color: '#ff6b6b' }}>Login failed: {message}</p>
        )}
      </div>
    </main>
  )
}

export default function CliLoginPage() {
  return (
    <Suspense fallback={<main className="container">Loading…</main>}>
      <CliLoginInner />
    </Suspense>
  )
}
