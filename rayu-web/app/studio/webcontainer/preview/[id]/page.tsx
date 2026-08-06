'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

const PREVIEW_CHANNEL = 'preview-updates';

/**
 * Standalone WebContainer preview, opened in a new tab from the workbench.
 *
 * Ported from bolt.diy's app/routes/webcontainer.preview.$id.tsx. The Remix
 * loader validated `params.id` and passed it through `useLoaderData`; here the
 * segment comes from `useParams` and the missing-id case renders a message rather
 * than throwing a 400 Response.
 *
 * This stays a real studio route rather than linking straight to
 * *.webcontainer-api.io so the document inherits the /studio COOP/COEP headers
 * and remains cross-origin isolated.
 *
 * NOTE: bolt's sibling route `webcontainer.connect.$id.tsx` was NOT ported. It
 * served an HTML document that loaded @webcontainer/api's connect.js from a CDN
 * at `@latest` to attach a StackBlitz-hosted editor. Nothing in bolt's own UI
 * links to it, and it would pull unpinned third-party script into a
 * cross-origin-isolated document.
 */
export default function WebContainerPreviewPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const previewId = params?.id;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState('');

  // Force a clean reload of the preview iframe.
  const handleRefresh = useCallback(() => {
    if (iframeRef.current && previewUrl) {
      iframeRef.current.src = '';
      requestAnimationFrame(() => {
        if (iframeRef.current) {
          iframeRef.current.src = previewUrl;
        }
      });
    }
  }, [previewUrl]);

  // Tell the workbench tab that this preview is live.
  const notifyPreviewReady = useCallback(() => {
    if (broadcastChannelRef.current && previewUrl) {
      broadcastChannelRef.current.postMessage({
        type: 'preview-ready',
        previewId,
        url: previewUrl,
        timestamp: Date.now(),
      });
    }
  }, [previewId, previewUrl]);

  useEffect(() => {
    if (!previewId) {
      return;
    }

    const supportsBroadcastChannel =
      typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function';

    if (supportsBroadcastChannel) {
      broadcastChannelRef.current = new window.BroadcastChannel(PREVIEW_CHANNEL);
      broadcastChannelRef.current.onmessage = (event) => {
        if (event.data.previewId === previewId) {
          if (event.data.type === 'refresh-preview' || event.data.type === 'file-change') {
            handleRefresh();
          }
        }
      };
    } else {
      broadcastChannelRef.current = undefined;
    }

    const url = `https://${previewId}.local-credentialless.webcontainer-api.io`;
    setPreviewUrl(url);

    if (iframeRef.current) {
      iframeRef.current.src = url;
    }

    notifyPreviewReady();

    return () => {
      broadcastChannelRef.current?.close();
    };
  }, [previewId, handleRefresh, notifyPreviewReady]);

  if (!previewId) {
    return (
      <div className="w-full h-full flex items-center justify-center text-bolt-elements-textSecondary">
        Preview id is required.
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <iframe
        ref={iframeRef}
        title="WebContainer Preview"
        className="w-full h-full border-none"
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-same-origin"
        allow="cross-origin-isolated"
        loading="eager"
        onLoad={notifyPreviewReady}
      />
    </div>
  );
}
