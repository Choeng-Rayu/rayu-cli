'use client';

import { useEffect, useState } from 'react';

/**
 * Replacement for `remix-utils/client-only`.
 *
 * Used by 7 files / 31 call sites in the copied bolt.diy UI. The children-as-a-
 * function API is kept exactly as upstream so no call site changes:
 *
 *   <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>
 *
 * That signature is the point of the component: the children closure is not
 * invoked until after mount, so browser-only modules inside it are never
 * evaluated during server rendering. Rendering `{children}` directly instead
 * would defeat it.
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: () => React.ReactNode;
  fallback?: React.ReactNode;
}): React.JSX.Element {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return <>{mounted ? children() : fallback}</>;
}

export default ClientOnly;
