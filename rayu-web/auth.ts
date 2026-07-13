import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'

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
        ;(token as any).idToken = (account as any).id_token
        ;(token as any).provider = account.provider
        ;(token as any).providerAccountId = account.providerAccountId
        token.picture = (profile as any).image ?? (profile as any).picture ?? token.picture
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
