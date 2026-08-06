'use client';

import { BaseChat } from '~/components/chat/BaseChat';
import { GitUrlImport } from '~/components/git/GitUrlImport.client';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { ClientOnly } from '~/shims/client-only';

/**
 * Clone a repository into the studio: /studio/git?url=<repo>
 *
 * Ported from bolt.diy's app/routes/git.tsx. Its loader read `params.url`, which
 * was always undefined — the URL actually arrives as a query parameter and
 * GitUrlImport reads it with useSearchParams. Dropping the loader loses nothing.
 */
export default function StudioGitPage(): React.JSX.Element {
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <ClientOnly fallback={<BaseChat />}>{() => <GitUrlImport />}</ClientOnly>
    </div>
  );
}
