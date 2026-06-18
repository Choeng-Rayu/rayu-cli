'use client'

import { useAuth } from '@clerk/nextjs'
import { useEffect, useState } from 'react'
import { apiUrl } from './config'

/**
 * Exchanges the signed-in Clerk session for a Rayu access token via
 * POST /web/session. Shared by the billing + credits dashboard pages.
 */
export function useRayuToken() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return
    void (async () => {
      try {
        const clerkToken = await getToken()
        const res = await fetch(apiUrl('/web/session'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${clerkToken}` },
        })
        if (!res.ok) throw new Error(`Session failed (${res.status})`)
        const data = (await res.json()) as { accessToken: string }
        setToken(data.accessToken)
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [isLoaded, isSignedIn, getToken])

  return { token, authError, isLoaded, isSignedIn }
}
