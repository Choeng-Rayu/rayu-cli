import { clerkMiddleware } from '@clerk/nextjs/server'

// NOTE: Clerk's latest docs use `proxy.ts`, which is the Next.js 16 file
// convention. On Next.js 15.5 the supported file is `middleware.ts`, so we use
// that here with the identical clerkMiddleware(). When this project upgrades to
// Next 16, rename this file to `proxy.ts` (contents unchanged).
export default clerkMiddleware()

export const config = {
  matcher: [
    // Skip Next internals and static files unless found in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for Clerk's auto-proxy path.
    '/__clerk/:path*',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
}
