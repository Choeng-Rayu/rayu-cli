/**
 * `@`-mentions for files — UI_PARITY flow 20.
 *
 * The CLI offers file suggestions as you type `@` (`ContextSuggestions.tsx`). The
 * panel already had selection capture and file staging via `insertPrompt`, but no
 * way to REFERENCE a file while composing — you had to know and type the whole path.
 *
 * The matching is pure and lives here so the rules are testable without a webview or
 * a workspace; the host supplies the actual file search, because only it can read the
 * workspace.
 */

/** How many suggestions to show. Matches the command palette so the UI is consistent. */
export const MENTION_LIMIT = 8;

/** An in-progress `@` mention found at the caret. */
export type MentionQuery = {
  /** The text typed after `@`, possibly empty when `@` was just pressed. */
  readonly query: string;
  /** Offset of the `@` itself, so a replacement knows what to overwrite. */
  readonly start: number;
  /** Offset just past the query, normally the caret. */
  readonly end: number;
};

/**
 * Find the `@` mention the caret is inside, or null.
 *
 * Scans back from the caret to the nearest `@`, and refuses if anything between
 * them cannot be part of a path. That is what stops an email address or a decorator
 * from opening a file picker mid-sentence.
 */
export function parseMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;

  let start = -1;
  for (let i = caret - 1; i >= 0; i -= 1) {
    const char = text[i] as string;
    if (char === "@") {
      start = i;
      break;
    }
    // Whitespace ends the search: a mention cannot contain one, so an `@` further
    // back belongs to an earlier word.
    if (/\s/.test(char)) return null;
  }
  if (start === -1) return null;

  // `@` must begin a word. In "user@example.com" or "@decorator" inside code the
  // preceding character is not a boundary, and offering files there is noise.
  if (start > 0) {
    const before = text[start - 1] as string;
    if (!/[\s(['"`]/.test(before)) return null;
  }

  return { query: text.slice(start + 1, caret), start, end: caret };
}

/**
 * Rank file paths against a mention query.
 *
 * Ordering rules, in priority order:
 *   1. a match on the FILE NAME beats a match elsewhere in the path — when someone
 *      types `@app` they mean `app.ts`, not `src/app/legacy/other.ts`;
 *   2. a prefix match beats a substring match;
 *   3. a shorter path beats a longer one, which favours the top of the tree;
 *   4. alphabetical, so the list is stable rather than arbitrary.
 *
 * An empty query returns the input order, capped — the host has already chosen a
 * sensible default set (recently opened files) and second-guessing it here would
 * discard that.
 */
export function rankMentionCandidates(
  query: string,
  paths: readonly string[],
  limit = MENTION_LIMIT,
): string[] {
  if (query.length === 0) return paths.slice(0, limit);
  const needle = query.toLowerCase();

  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);

    let score: number;
    if (name.startsWith(needle)) score = 0;
    else if (name.includes(needle)) score = 1;
    else if (lower.startsWith(needle)) score = 2;
    else if (lower.includes(needle)) score = 3;
    else continue; // no match at all — omit rather than rank last

    scored.push({ path, score });
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  );
  return scored.slice(0, limit).map((entry) => entry.path);
}

/**
 * Replace the mention under the caret with a chosen path.
 *
 * Returns the new text and where the caret should land. A trailing space is added
 * because a mention is virtually always followed by more typing, and it also stops
 * the picker immediately re-matching the text just inserted.
 */
export function applyMention(
  text: string,
  mention: MentionQuery,
  path: string,
): { text: string; caret: number } {
  const inserted = `@${path} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length,
  };
}
