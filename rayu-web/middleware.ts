import { auth } from './auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  // Allow all public traffic; protected pages check auth themselves.
  return NextResponse.next()
})

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$).*)'],
}
