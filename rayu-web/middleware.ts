import { auth } from './auth'
import { NextResponse } from 'next/server'

/** Studio mount point; keep in sync with studio/lib/rayu/routes.ts. */
const STUDIO_PREFIX = '/studio'

/**
 * Rayu Studio depends on a StackBlitz WebContainer commercial licence for this
 * origin. Until that is in place the routes must not be reachable, so the flag
 * defaults to off and the segment 404s rather than showing a teaser.
 */
const studioEnabled = process.env.NEXT_PUBLIC_STUDIO_ENABLED === 'true'

export default auth((req) => {
  const { pathname } = req.nextUrl

  if (pathname === STUDIO_PREFIX || pathname.startsWith(`${STUDIO_PREFIX}/`)) {
    if (!studioEnabled) {
      // Rewrite, not redirect: an unlicensed sandbox should look absent, and a
      // redirect would advertise that the route exists.
      return NextResponse.rewrite(new URL('/404', req.url))
    }

    if (!req.auth?.user) {
      /*
       * app/studio/layout.tsx performs the authoritative check; this is here so an
       * unauthenticated request never reaches the studio bundle at all. `next`
       * carries the user back after signing in.
       */
      const signIn = new URL('/sign-in', req.url)
      signIn.searchParams.set('next', pathname)

      return NextResponse.redirect(signIn)
    }
  }

  // Allow all other public traffic; protected pages check auth themselves.
  return NextResponse.next()
})

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots\\.txt|sitemap\\.xml|.*\\.png$).*)'],
}
