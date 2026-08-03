'use client';

import { useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { cssTransition, ToastContainer } from 'react-toastify';
import { themeStore } from '~/lib/stores/theme';
import { logStore } from '~/lib/stores/logs';
import { ClientOnly } from '~/shims/client-only';

/**
 * Client-side provider tree for Rayu Studio.
 *
 * This is bolt.diy's `root.tsx` Layout + App merged into one client component.
 * The pieces that were Remix document concerns (`<Links>`, `<Meta>`, `<Scripts>`,
 * `remix-island`'s `createHead`) are gone: in Next the document is owned by
 * app/layout.tsx and stylesheets are plain imports in the server layout.
 *
 * Everything here needs the browser — drag-and-drop backends, the theme store,
 * toast portals — so the whole tree is client-only.
 */

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

export function StudioProviders({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useStore(themeStore);

  /*
   * bolt set data-theme from an inline <script> in the document head to avoid a
   * flash of the wrong theme. Next's equivalent lives in app/studio/layout.tsx as
   * a beforeInteractive script; this effect keeps the attribute in sync when the
   * user toggles the theme afterwards.
   */
  useEffect(() => {
    document.querySelector('html')?.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    logStore.logSystem('Rayu Studio initialized', {
      theme,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });

    // Lazily loaded: the debug logger is inert until enableDebugMode() is called,
    // so it should not sit in the initial bundle.
    import('~/utils/debugLogger')
      .then(({ debugLogger }) => {
        const status = debugLogger.getStatus();
        logStore.logSystem('Debug logging ready', {
          initialized: status.initialized,
          capturing: status.capturing,
          enabled: status.enabled,
        });
      })
      .catch((error) => {
        logStore.logError('Failed to initialize debug logging', error);
      });
    // Runs once on mount; `theme` is only read for the initial log line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <ClientOnly>{() => <DndProvider backend={HTML5Backend}>{children}</DndProvider>}</ClientOnly>
      <ToastContainer
        closeButton={({ closeToast }) => (
          <button className="Toastify__close-button" onClick={closeToast}>
            <div className="i-ph:x text-lg" />
          </button>
        )}
        icon={({ type }) => {
          switch (type) {
            case 'success':
              return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
            case 'error':
              return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
            default:
              return undefined;
          }
        }}
        position="bottom-right"
        pauseOnFocusLoss
        transition={toastAnimation}
        autoClose={3000}
      />
    </>
  );
}
