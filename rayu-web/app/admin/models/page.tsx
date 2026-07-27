import { redirect } from 'next/navigation'

/**
 * The Models page is gone: models are managed on the Providers page, nested under
 * the provider that serves them.
 *
 * A flat cross-provider catalog was a second place to edit the same rows, and the
 * fields that matter (upstream model id, credit charges, capabilities) only make
 * sense next to the provider's base URL, wire format, and keys — a model id is
 * meaningless without knowing whose catalog it comes from.
 *
 * The route is kept as a redirect rather than deleted so admins' bookmarks and
 * browser history land somewhere useful instead of on a 404.
 */
export default function ModelsRedirect() {
  redirect('/admin/providers')
}
