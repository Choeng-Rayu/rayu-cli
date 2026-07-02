// Pure content hashing for edit conflict detection (R6.3).
//
// `node:crypto` is permitted in the editor-agnostic core — it is a Node
// builtin, not an editor dependency, so using it does not violate the
// no-`vscode` invariant (R13.1, R13.5). A real SHA-256 hex digest is used: the
// same content always hashes to the same value, and any change to the content
// changes the hash (with cryptographically negligible collision probability) —
// exactly the guarantee conflict detection relies on.

import { createHash } from "node:crypto";

/**
 * Stable SHA-256 hex digest of `content` (R6.3). The proposal model captures
 * this for a file when a proposal is generated; the apply engine recomputes it
 * for the current file and compares the two to detect a stale base.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
