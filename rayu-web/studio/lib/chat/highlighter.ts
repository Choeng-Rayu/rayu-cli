import { createHighlighter, type BundledLanguage, type BundledTheme, type HighlighterGeneric } from 'shiki';
import { useEffect, useState } from 'react';

/**
 * Lazily-created Shiki highlighters, shared across components.
 *
 * bolt.diy created these with a TOP-LEVEL await:
 *
 *   const shellHighlighter = import.meta.hot?.data.shellHighlighter
 *     ?? (await createHighlighter(options));
 *
 * Under Vite the `import.meta.hot` branch short-circuited in development. With
 * DefinePlugin substituting `undefined` (see next.config.mjs) the await became
 * unconditional, and webpack warns that the emitted top-level await "may cause
 * runtime errors" on the configured browser targets.
 *
 * Deferring also matters for weight: Shiki carries its grammars and themes, and at
 * module scope it was parsed and executed before the chat could render at all.
 * Here nothing loads until a code block is actually shown.
 */

type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

/** One in-flight promise per language set, so grammars load at most once. */
const cache = new Map<string, Promise<Highlighter>>();

function getHighlighter(langs: BundledLanguage[]): Promise<Highlighter> {
  const key = langs.join(',');
  let pending = cache.get(key);

  if (!pending) {
    pending = createHighlighter({ langs, themes: ['light-plus', 'dark-plus'] });
    cache.set(key, pending);
  }

  return pending;
}

/**
 * Resolve a highlighter for use in render.
 *
 * Returns `null` until the grammars have loaded; callers render unhighlighted text
 * in the meantime rather than blocking, which is what the top-level await used to
 * do implicitly.
 */
export function useHighlighter(...langs: BundledLanguage[]): Highlighter | null {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    let active = true;

    getHighlighter(langs)
      .then((h) => {
        if (active) {
          setHighlighter(h);
        }
      })
      .catch(() => {
        // Syntax highlighting is decoration; failing to load it must not break the
        // message that contains the code.
      });

    return () => {
      active = false;
    };
    // langs is a stable literal list at each call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langs.join(',')]);

  return highlighter;
}

/** Escape code for safe insertion while the highlighter is still loading. */
export function escapeHtml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
