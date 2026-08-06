import { redirect } from 'next/navigation'

// The credits view now lives in the signed-in dashboard.
export default function CreditsPage() {
  redirect('/dashboard')
}
