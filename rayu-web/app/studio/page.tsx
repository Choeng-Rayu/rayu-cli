'use client';

import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { ClientOnly } from '~/shims/client-only';

/**
 * Studio home — a new chat.
 *
 * Ported from bolt.diy's app/routes/_index.tsx. The Remix `meta` export and its
 * no-op `loader` are gone: metadata lives in app/studio/layout.tsx and there is
 * no server data to load.
 *
 * Settings are reached only through the sidebar menu; deliberately no settings
 * button here, matching upstream.
 */
export default function StudioPage(): React.JSX.Element {
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>
    </div>
  );
}
