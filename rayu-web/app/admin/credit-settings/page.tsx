import { redirect } from 'next/navigation'

/**
 * Credit Settings merged into Plans & Credits.
 *
 * The route is kept as a permanent redirect rather than deleted: this URL is in
 * admins' bookmarks and browser history, and a 404 on a page that used to hold
 * the credit rate is a worse answer than sending them where the settings now
 * live.
 */
export default function CreditSettingsRedirect() {
  redirect('/admin/plans')
}
