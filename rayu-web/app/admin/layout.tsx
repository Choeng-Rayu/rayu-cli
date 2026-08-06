import { AdminProvider } from './AdminProvider'
import { AdminShell } from './AdminShell'

// Admin is fully auth-gated + client-driven; never statically prerender.
export const dynamic = 'force-dynamic'

// Shared shell for every /admin/* route: one Rayu-session exchange, role gate,
// sidebar + topbar. Individual pages just render content via useAdmin().
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AdminProvider>
      <AdminShell>{children}</AdminShell>
    </AdminProvider>
  )
}
