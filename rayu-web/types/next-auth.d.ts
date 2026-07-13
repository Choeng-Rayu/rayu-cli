import '@auth/core/types'

declare module '@auth/core/types' {
  interface Session {
    idToken?: string
    provider?: string
    providerAccountId?: string
  }

  interface JWT {
    idToken?: string
    provider?: string
    providerAccountId?: string
  }
}
