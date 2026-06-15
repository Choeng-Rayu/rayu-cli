'use client'
import { ClerkProvider } from '@clerk/nextjs'
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>
}
