import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'

/**
 * Refresh a Google OAuth token using the stored refresh_token.
 * Returns a new id_token + expiry, or null if the refresh fails.
 */
async function refreshGoogleIdToken(
  refreshToken: string,
): Promise<{ idToken: string; expiresAt: number } | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      id_token?: string
      expires_in?: number
      refresh_token?: string
    }
    if (!data.id_token) return null
    return {
      idToken: data.id_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
  } catch {
    return null
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      authorization: {
        params: {
          prompt: 'consent',
          access_type: 'offline',
          response_type: 'code',
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        // Initial sign-in: store the id_token + refresh_token + expiry.
        ;(token as any).idToken = (account as any).id_token
        ;(token as any).refreshToken = (account as any).refresh_token
        // account.expires_at is the ACCESS token expiry (seconds since epoch).
        // Google's id_token has the same ~1h lifetime, so we use it as a proxy.
        ;(token as any).tokenExpiresAt =
          ((account as any).expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000
        ;(token as any).provider = account.provider
        ;(token as any).providerAccountId = account.providerAccountId
        token.picture = (profile as any).image ?? (profile as any).picture ?? token.picture
      }

      // On subsequent JWT reads (no account), check if the id_token is expired
      // and refresh it using the stored refresh_token. This prevents the backend
      // from rejecting an expired Google ID token with 401 on /auth/oauth/google.
      const expiresAt = (token as any).tokenExpiresAt as number | undefined
      const refreshToken = (token as any).refreshToken as string | undefined
      if (expiresAt && refreshToken && Date.now() > expiresAt - 60_000) {
        const refreshed = await refreshGoogleIdToken(refreshToken)
        if (refreshed) {
          ;(token as any).idToken = refreshed.idToken
          ;(token as any).tokenExpiresAt = refreshed.expiresAt
        }
        // If refresh fails, the stale id_token stays — the backend will reject
        // it and the user will need to re-sign-in.
      }

      return token
    },
    async session({ session, token }) {
      if ((token as any).idToken) {
        session.idToken = (token as any).idToken as string
      }
      if ((token as any).provider) {
        session.provider = (token as any).provider as string
      }
      if ((token as any).providerAccountId) {
        session.providerAccountId = (token as any).providerAccountId as string
      }
      return session
    },
  },
  pages: {
    signIn: '/sign-in',
  },
  trustHost: true,
})