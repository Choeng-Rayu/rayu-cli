'use client';

import { useCallback, useMemo } from 'react';
import {
  useParams as useNextParams,
  usePathname,
  useRouter,
  useSearchParams as useNextSearchParams,
} from 'next/navigation';

/**
 * Compatibility layer for the handful of `@remix-run/react` router hooks the
 * copied bolt.diy UI still uses.
 *
 * Only five files import from Remix's router after the port (the other 36
 * importers were server routes that moved to rayu-backend / rayu-gateway), so a
 * small shim is cheaper and less risky than rewriting call sites — and it keeps
 * those files diffable against upstream bolt.
 *
 * The shapes here deliberately match REMIX's API, not Next's, because that is
 * what the call sites expect. The important difference is useSearchParams:
 * Remix returns a `[params, setParams]` tuple, Next returns a read-only
 * URLSearchParams. Returning Next's value directly would silently break
 * `const [searchParams, setSearchParams] = useSearchParams()` in Chat.client.tsx —
 * destructuring a URLSearchParams yields undefined rather than throwing.
 */

/** Remix's `useParams`. Next's has the same shape, so this is a re-export. */
export function useParams<T extends Record<string, string | string[]>>(): Partial<T> {
  return (useNextParams() ?? {}) as Partial<T>;
}

/**
 * Remix's `useLocation`. Only `search` is read by the port (Messages.client.tsx),
 * but pathname and hash are provided so a future call site is not surprised.
 * `state` and `key` are absent: Next has no equivalent, and returning fake values
 * would be worse than a type error at the point someone tries to use them.
 */
export function useLocation(): { pathname: string; search: string; hash: string } {
  const pathname = usePathname() ?? '';
  const params = useNextSearchParams();
  const query = params?.toString() ?? '';

  return useMemo(
    () => ({
      pathname,
      search: query ? `?${query}` : '',
      // usePathname() excludes the hash; it is only available on the client.
      hash: typeof window === 'undefined' ? '' : window.location.hash,
    }),
    [pathname, query],
  );
}

type SearchParamsInit = URLSearchParams | Record<string, string> | string;

/**
 * Remix's `useSearchParams` — a `[URLSearchParams, setter]` tuple.
 *
 * The setter replaces the entire query string, which is what Remix does and what
 * Chat.client.tsx relies on when it calls `setSearchParams({})` to strip a
 * consumed `?prompt=` from the URL.
 */
export function useSearchParams(): [
  URLSearchParams,
  (init: SearchParamsInit, opts?: { replace?: boolean }) => void,
] {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const current = useNextSearchParams();

  // A fresh instance so callers cannot mutate Next's cached read-only object.
  const params = useMemo(() => new URLSearchParams(current?.toString() ?? ''), [current]);

  const setSearchParams = useCallback(
    (init: SearchParamsInit, opts?: { replace?: boolean }) => {
      const next = new URLSearchParams(
        typeof init === 'string' || init instanceof URLSearchParams
          ? init
          : (init as Record<string, string>),
      ).toString();
      const url = next ? `${pathname}?${next}` : pathname;

      /*
       * Default to replace(): the only current caller is clearing a consumed
       * query parameter, and push() would leave a history entry that navigates
       * back to the same page with the parameter restored.
       */
      if (opts?.replace === false) {
        router.push(url);
      } else {
        router.replace(url);
      }
    },
    [pathname, router],
  );

  return [params, setSearchParams];
}

/**
 * Remix's `useNavigate`. Supports the `{ replace }` option, the only one used
 * (useChatHistory.ts calls `navigate('/studio', { replace: true })` after a
 * chat is deleted).
 */
export function useNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  const router = useRouter();

  return useCallback(
    (to: string, opts?: { replace?: boolean }) => {
      if (opts?.replace) {
        router.replace(to);
      } else {
        router.push(to);
      }
    },
    [router],
  );
}
