/**
 * Route helpers for Rayu Studio.
 *
 * bolt.diy was mounted at the origin root, so its UI navigated to `/`,
 * `/chat/:id`, `/git` and `/webcontainer/preview/:id`. In rayu-web those paths
 * belong to the marketing site, the docs, and nothing at all — a bare `/chat/x`
 * would 404 and `/` would drop the user on the landing page mid-session.
 *
 * Every studio navigation goes through this module so the mount point is defined
 * once. If the studio ever moves, this is the only file that changes.
 */

/** Mount point for the studio. Must match the app/studio directory. */
export const STUDIO_BASE = '/studio';

/** The studio home (new chat). */
export const studioHome = (): string => STUDIO_BASE;

/** An existing chat by its url id. */
export const studioChat = (id: string): string => `${STUDIO_BASE}/chat/${id}`;

/** The git-import landing page, optionally pre-filled with a repo URL. */
export const studioGit = (url?: string): string =>
  url ? `${STUDIO_BASE}/git?url=${encodeURIComponent(url)}` : `${STUDIO_BASE}/git`;

/**
 * The standalone WebContainer preview document, opened in a new tab from the
 * workbench. Kept as a real route (not the raw *.webcontainer-api.io URL) so the
 * page inherits the studio's COOP/COEP headers and stays cross-origin isolated.
 */
export const studioPreview = (previewId: string): string =>
  `${STUDIO_BASE}/webcontainer/preview/${previewId}`;
