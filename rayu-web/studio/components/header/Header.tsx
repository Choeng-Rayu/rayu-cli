import { studioHome } from '~/lib/rayu/routes';
import { useStore } from '@nanostores/react';
import { ClientOnly } from '~/shims/client-only';
import { chatStore } from '~/lib/stores/chat';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';

export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames('flex items-center px-4 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <div className="i-ph:sidebar-simple-duotone text-xl" />
        {/*
          * A plain <a>, not next/link: /studio is cross-origin isolated, and a
          * soft navigation would reuse the current document rather than fetching
          * one with the COOP/COEP headers WebContainer needs.
          *
          * bolt pointed this at "/" because it owned the origin root; here that is
          * rayu-web's marketing page, so it would drop the user out of the studio.
          */}
        <a href={studioHome()} className="text-2xl font-semibold text-accent flex items-center">
          {/* bolt's logo-{light,dark}-styled.png were not copied; Rayu branding is used. */}
          <img src="/rayucode-logo-horizontal.png" alt="Rayu Studio" className="w-[110px] inline-block" />
        </a>
      </div>
      {chat.started && ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="">
                <HeaderActionButtons chatStarted={chat.started} />
              </div>
            )}
          </ClientOnly>
        </>
      )}
    </header>
  );
}
