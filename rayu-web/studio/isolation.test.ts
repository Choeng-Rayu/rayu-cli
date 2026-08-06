import fs from 'node:fs';
import path from 'node:path';

/**
 * Cross-origin isolation invariants for /studio.
 *
 * WebContainer only boots in a document served with COOP: same-origin and
 * COEP: credentialless. Those are per-DOCUMENT headers, which has a consequence
 * that is easy to reintroduce and silent when broken:
 *
 *   A Next.js client-side (soft) navigation does not fetch a new document. Going
 *   from /dashboard to /studio via <Link> reuses the existing, non-isolated
 *   document, `window.crossOriginIsolated` stays false, and WebContainer.boot()
 *   fails with an error that points nowhere near the <Link> that caused it.
 *
 * So every navigation that ENTERS or LEAVES /studio has to be a full page load.
 * These tests pin that, plus the header scoping itself.
 */

const ROOT = path.join(__dirname, '..');

/** Source files that could contain a navigation, excluding tests. */
function sourceFiles(dirs: string[]): string[] {
  const walk = (d: string): string[] => {
    if (!fs.existsSync(d)) {
      return [];
    }

    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);

      if (e.isDirectory()) {
        return e.name === 'node_modules' ? [] : walk(p);
      }

      if (!/\.(ts|tsx)$/.test(e.name) || /\.(test|spec)\.tsx?$/.test(e.name)) {
        return [];
      }

      return [p];
    });
  };

  return dirs.flatMap((d) => walk(path.join(ROOT, d)));
}

describe('next.config.mjs isolation headers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'next.config.mjs'), 'utf8');

  it('sets COOP and COEP', () => {
    expect(src).toContain('Cross-Origin-Opener-Policy');
    expect(src).toContain('same-origin');
    expect(src).toContain('Cross-Origin-Embedder-Policy');
    // 'credentialless' rather than 'require-corp': it lets cross-origin
    // subresources load without CORP by dropping their credentials, which is what
    // WebContainer's preview iframes rely on.
    expect(src).toContain('credentialless');
  });

  it('scopes them to /studio only', () => {
    /*
     * Applying these origin-wide would isolate /sign-in and /dashboard too. COOP
     * same-origin severs window.opener, and COEP strips credentials from
     * cross-origin subresources — neither is wanted on the marketing site.
     */
    expect(src).toMatch(/source:\s*'\/studio\/:path\*'/);

    // No catch-all header source that would leak isolation to every route.
    expect(src).not.toMatch(/source:\s*'\/\(\.\*\)'/);
    expect(src).not.toMatch(/source:\s*'\/:path\*'/);
  });
});

describe('navigation across the /studio boundary is a full page load', () => {
  const files = sourceFiles(['app', 'components', 'lib', 'studio']);

  it('finds source files to inspect', () => {
    // Guards against a path change silently making the scans below vacuous.
    expect(files.length).toBeGreaterThan(50);
  });

  it('no next/link points at /studio', () => {
    /*
     * The failure this prevents: <Link href="/studio"> renders fine, navigates
     * fine, and leaves WebContainer unable to boot.
     */
    const offenders: string[] = [];

    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');

      if (!/from ['"]next\/link['"]/.test(src)) {
        continue;
      }

      // Any Link whose href is a /studio path.
      for (const m of src.matchAll(/<Link\b[^>]*href=\{?['"`](\/studio[^'"`]*)['"`]/g)) {
        offenders.push(`${path.relative(ROOT, f)}: <Link href="${m[1]}">`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no router.push/replace targets /studio', () => {
    // Same problem as <Link>: the App Router reuses the current document.
    const offenders: string[] = [];

    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');

      for (const m of src.matchAll(/router\.(?:push|replace)\(\s*[`'"](\/studio[^`'"]*)/g)) {
        offenders.push(`${path.relative(ROOT, f)}: router.push("${m[1]}")`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('studio links to non-studio pages use a plain anchor', () => {
    /*
     * Leaving the studio by soft navigation is the mirror image of the problem: the
     * new page would inherit the isolated document, and the studio's global CSS
     * (which hides the marketing chrome) would still be applied.
     */
    const studioFiles = sourceFiles(['studio', 'app/studio']);
    const offenders: string[] = [];

    for (const f of studioFiles) {
      const src = fs.readFileSync(f, 'utf8');

      if (/from ['"]next\/link['"]/.test(src)) {
        offenders.push(`${path.relative(ROOT, f)}: imports next/link`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('session redirects out of the studio use a full page load', () => {
    // redirectToSignIn() must not be a router.push: /sign-in has to be fetched as
    // its own, non-isolated document.
    const session = fs.readFileSync(path.join(ROOT, 'studio/lib/rayu/session.ts'), 'utf8');
    expect(session).toContain('window.location.href');
    expect(session).not.toMatch(/router\.(push|replace)/);
  });
});

describe('studio asset and route references resolve', () => {
  it('references no asset that was left behind in bolt.diy', () => {
    /*
     * bolt's branding was deliberately not copied into public/. A stale reference
     * such as /logo-dark-styled.png renders as a broken image with no build error.
     */
    const missing: string[] = [];

    for (const f of sourceFiles(['studio', 'app/studio'])) {
      const src = fs.readFileSync(f, 'utf8');

      for (const m of src.matchAll(/src="(\/[^"]+\.(?:png|jpg|jpeg|svg|ico|webp))"/g)) {
        const asset = path.join(ROOT, 'public', m[1]);

        if (!fs.existsSync(asset)) {
          missing.push(`${path.relative(ROOT, f)}: ${m[1]}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('routes studio navigation through the route helpers', () => {
    /*
     * bolt was mounted at the origin root, so its UI navigated to '/', '/chat/:id'
     * and '/git'. Those paths belong to rayu-web's marketing site now, and a bare
     * one drops the user out of the studio mid-session — which is what
     * lib/rayu/routes.ts exists to prevent.
     */
    const offenders: string[] = [];
    const studioFiles = sourceFiles(['studio']).filter(
      (f) => !f.endsWith(path.join('lib', 'rayu', 'routes.ts')),
    );

    /*
     * Comments are stripped first: several files explain the old bolt paths in
     * prose, and a doc comment mentioning `/chat/:id` is not a navigation.
     */
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const f of studioFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));

      // href="/" or href='/' — bolt's studio-home link.
      for (const _ of src.matchAll(/href=["']\/["']/g)) {
        offenders.push(`${path.relative(ROOT, f)}: href="/"`);
      }

      // Bare bolt chat/git paths in a string literal.
      for (const m of src.matchAll(/["'`](\/(?:chat\/|git\?|webcontainer\/))/g)) {
        offenders.push(`${path.relative(ROOT, f)}: "${m[1]}..."`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
