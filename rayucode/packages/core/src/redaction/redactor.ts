// Credential redaction filter (R8.4, R15.5).
//
// Pure, editor-agnostic. Given a configured set of secret values, it removes
// every occurrence of every secret from arbitrary text, replacing each with a
// fixed placeholder so no secret survives in ANY form — not even a masked or
// partial rendering such as `sk-…1234` (R15.5). This is the reusable filter the
// SessionManager/host later place in front of both the Agent_Panel sink and the
// log channel (Property 11); that wiring is a later task — here we expose the
// pure filter only.
//
// Algorithm:
//   1. Normalize secrets: drop empty/blank values (a blank needle would
//      otherwise "match" everywhere), dedupe, and sort longest-first so a
//      longer secret is always matched before a shorter secret that is its
//      substring — preventing a remnant of the longer secret from surviving.
//   2. Redact in a single left-to-right scan over the input: at each position,
//      replace the longest matching secret with the placeholder and advance
//      past it; otherwise copy one character. Matches are taken only against
//      the original text and the inserted placeholder is never re-scanned, so
//      the pass terminates and no full secret can remain inside any surviving
//      literal run.
//
// The placeholder is an obvious non-credential token. (A configured secret that
// is literally a fragment of the placeholder token is not a real provider
// credential; real credentials are opaque, high-entropy strings.)

/** The fixed redaction placeholder. Replaces every secret occurrence (R15.5). */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/** Options for {@link Redactor} / {@link redactSecrets}. */
export interface RedactorOptions {
  /** Token substituted for each secret occurrence. Defaults to {@link REDACTION_PLACEHOLDER}. */
  placeholder?: string;
}

/**
 * Normalize a secret set: keep only non-blank values, dedupe, and sort
 * longest-first (lexicographic tiebreak for deterministic output).
 */
function normalizeSecrets(secrets: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const secret of secrets) {
    // Ignore empty/whitespace-only secrets — they carry no credential value and
    // an empty needle would otherwise match at every position (R15.5 guard).
    if (typeof secret === "string" && secret.trim().length > 0) {
      unique.add(secret);
    }
  }
  return [...unique].sort((a, b) => {
    if (a.length !== b.length) {
      return b.length - a.length;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Redacts a configured set of secrets from arbitrary text. Construct once with
 * the secret set, then call {@link redact} (or {@link redactLine}) for each
 * piece of text routed to a user-visible surface.
 */
export class Redactor {
  /** Secrets, normalized and sorted longest-first. */
  private readonly secrets: readonly string[];
  private readonly placeholder: string;

  constructor(secrets: Iterable<string>, options: RedactorOptions = {}) {
    this.secrets = normalizeSecrets(secrets);
    this.placeholder = options.placeholder ?? REDACTION_PLACEHOLDER;
  }

  /** Whether any secret is configured after dropping empty/blank values. */
  get hasSecrets(): boolean {
    return this.secrets.length > 0;
  }

  /**
   * Return `text` with every configured secret replaced by the placeholder. The
   * result contains no configured secret as a substring, in any form (R8.4,
   * R15.5).
   */
  redact(text: string): string {
    if (this.secrets.length === 0 || text.length === 0) {
      return text;
    }
    let out = "";
    let i = 0;
    const n = text.length;
    while (i < n) {
      const matchedLength = this.matchLengthAt(text, i);
      if (matchedLength > 0) {
        out += this.placeholder;
        i += matchedLength;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  }

  /**
   * Convenience for redacting a single protocol/stderr line before it is
   * surfaced to the panel or written to the log channel (R8.4, R15.5).
   */
  redactLine(line: string): string {
    return this.redact(line);
  }

  /**
   * Length of the longest secret matching `text` at `index`, or 0 if none.
   * Because `secrets` is sorted longest-first, the first match is the longest.
   */
  private matchLengthAt(text: string, index: number): number {
    for (const secret of this.secrets) {
      if (text.startsWith(secret, index)) {
        return secret.length;
      }
    }
    return 0;
  }
}

/**
 * Functional convenience: redact `secrets` from `text` in one call. Equivalent
 * to `new Redactor(secrets, options).redact(text)`.
 */
export function redactSecrets(
  text: string,
  secrets: Iterable<string>,
  options?: RedactorOptions,
): string {
  return new Redactor(secrets, options).redact(text);
}
