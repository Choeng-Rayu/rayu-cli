// Pure, editor-agnostic glob matching for the workspace ignore configuration.
//
// `VSCodeAdapter.isPathIgnored` (R9.6) decides whether a path is excluded by the
// workspace ignore configuration — in VS Code that is the `files.exclude` /
// `search.exclude` settings, each a map of glob → enabled. The glob → RegExp
// conversion and the actual matching are pure string logic with NO `vscode`
// import, so they live here and are exercised directly by unit tests (the
// adapter itself is only reachable inside a running extension host).
//
// Supported glob syntax (the practical subset VS Code exclude globs use):
//   **/   zero or more leading/intermediate path segments
//   **    (trailing, or not before '/') any characters, including '/'
//   *     any run of characters within a single path segment (no '/')
//   ?     a single character within a segment (no '/')
//   {a,b} brace alternation (no nesting)
// Everything else is matched literally. Character classes (`[...]`) are treated
// literally — a documented, pragmatic limitation; exclude globs rarely use them.

// Regex metacharacters that must be escaped when emitted literally. '/' is
// intentionally NOT included: patterns are compiled with `new RegExp(...)` (not
// a regex literal), where '/' needs no escaping, and leaving it bare keeps the
// emitted source readable.
const REGEX_SPECIALS = new Set([
  ".",
  "+",
  "^",
  "$",
  "(",
  ")",
  "|",
  "[",
  "]",
  "{",
  "}",
  "\\",
]);

function escapeLiteral(char: string): string {
  return REGEX_SPECIALS.has(char) ? `\\${char}` : char;
}

/**
 * Convert a glob pattern to a RegExp source string (without anchors). Exported
 * for testing; most callers want {@link matchGlob} or {@link isIgnoredByGlobs}.
 */
export function globToRegExpSource(glob: string): string {
  const chars = [...glob];
  let source = "";

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];

    if (char === "*") {
      if (chars[i + 1] === "*") {
        // Globstar. Consume the second '*'.
        i++;
        if (chars[i + 1] === "/") {
          // "**/" → zero or more complete path segments.
          i++; // consume the '/'
          source += "(?:[^/]+/)*";
        } else {
          // Trailing "**" (or "**" not followed by '/') → anything, incl. '/'.
          source += ".*";
        }
      } else {
        // Single '*' → any run of characters within one segment.
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "{") {
      // Brace alternation up to the next '}' (no nesting support).
      let j = i + 1;
      let body = "";
      while (j < chars.length && chars[j] !== "}") {
        body += chars[j];
        j++;
      }
      const alternatives = body.split(",").map(globToRegExpSource);
      source += `(?:${alternatives.join("|")})`;
      i = j; // position at '}' (or end); the loop's i++ moves past it
      continue;
    }

    source += escapeLiteral(char);
  }

  return source;
}

const regExpCache = new Map<string, RegExp>();

/** Whether a workspace-relative, '/'-separated path matches a single glob. */
export function matchGlob(relativePath: string, glob: string): boolean {
  let regExp = regExpCache.get(glob);
  if (!regExp) {
    regExp = new RegExp(`^${globToRegExpSource(glob)}$`);
    regExpCache.set(glob, regExp);
  }
  return regExp.test(relativePath);
}

/** Normalize a path to the '/'-separated, root-relative form globs match. */
export function normalizeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, "/") // Windows separators → POSIX
    .replace(/^\.\//, "") // drop a leading "./"
    .replace(/^\/+/, ""); // drop leading slashes (treat as root-relative)
}

/**
 * Whether `relativePath` is excluded by any of `globs`. A directory glob (e.g.
 * `**\/node_modules`) is also treated as excluding everything beneath it, so a
 * file inside an excluded directory is reported as ignored too.
 */
export function isIgnoredByGlobs(relativePath: string, globs: string[]): boolean {
  const normalized = normalizeRelativePath(relativePath);
  for (const glob of globs) {
    if (!glob) continue;
    if (matchGlob(normalized, glob)) return true;
    // Match contents of an excluded directory: "<glob>/**".
    const dirGlob = `${glob.replace(/\/+$/, "")}/**`;
    if (matchGlob(normalized, dirGlob)) return true;
  }
  return false;
}

/**
 * Flatten one or more VS Code exclude maps (the value of `files.exclude` /
 * `search.exclude`) into the list of enabled glob patterns. Each source is an
 * untyped settings value: a record of glob → `true` | `false` | `{ when }`. A
 * glob counts as enabled unless explicitly disabled with `false`/`null`. The
 * `when` sibling-condition form cannot be evaluated here, so such globs are
 * treated as enabled (pragmatic — favors excluding over leaking).
 */
export function collectExcludeGlobs(...sources: unknown[]): string[] {
  const globs = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [glob, value] of Object.entries(source as Record<string, unknown>)) {
      if (!glob) continue;
      if (value === false || value === null || value === undefined) continue;
      globs.add(glob);
    }
  }
  return [...globs];
}
