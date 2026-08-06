import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Script from 'next/script';
import { auth } from '@/auth';

// Order matters: uno.css last so UnoCSS wins over app/globals.css inside the
// studio on any utility both engines generate. See uno.config.ts.
import '~/styles/index.scss';
import '@xterm/xterm/css/xterm.css';
import 'react-toastify/dist/ReactToastify.css';
import '~/styles/studio-shell.css';
import '~/styles/uno.css';

import { StudioProviders } from './StudioProviders';

export const metadata: Metadata = {
  title: 'Rayu Studio',
  description: 'Build, run and deploy full-stack apps in your browser with Rayu.',
  // The studio is behind auth and has nothing to index.
  robots: { index: false, follow: false },
};

/*
 * WebContainer needs a real document per boot and the chat shell reads
 * per-request state, so this segment is never statically rendered.
 */
export const dynamic = 'force-dynamic';

/**
 * Applies the theme before first paint.
 *
 * bolt.diy did this with an inline <script> in its Remix document head. Without
 * it the studio renders light, then flips to dark once the theme store hydrates.
 * `beforeInteractive` is the Next equivalent placement.
 */
const themeBootstrap = `
(function () {
  try {
    var t = localStorage.getItem('bolt_theme');
    if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.querySelector('html').setAttribute('data-theme', t);
  } catch (e) {}
})();
`;

export default async function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  /*
   * Feature gate. The studio depends on a StackBlitz WebContainer commercial
   * licence for the origin; until that is in place it must not be reachable.
   * 404 rather than a friendly page: an unlicensed sandbox should look absent.
   */
  if (process.env.NEXT_PUBLIC_STUDIO_ENABLED !== 'true') {
    notFound();
  }

  /*
   * Auth gate. middleware.ts also redirects unauthenticated traffic, but this is
   * the authoritative check — middleware can be bypassed by configuration
   * mistakes, a layout cannot.
   */
  const session = await auth();

  if (!session?.user) {
    redirect(`/sign-in?next=${encodeURIComponent('/studio')}`);
  }

  return (
    <>
      <Script id="studio-theme" strategy="beforeInteractive">
        {themeBootstrap}
      </Script>
      <div className="studio-root">
        <StudioProviders>{children}</StudioProviders>
      </div>
    </>
  );
}
