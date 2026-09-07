/**
 * Content hashing. The implementation now lives in @rayu-dev/rayu-core
 * (src/portable/hash.ts) so the VS Code extension runs the same code under plain
 * Node instead of duplicating it.
 *
 * Re-exported from here so no call site changes — see RAYU_CORE_MIGRATION_PLAN.md
 * Task 6. The Bun and Node paths still produce DIFFERENT digests (wyhash vs
 * SHA-256); only `djb2Hash` is stable across runtimes and safe to persist.
 */
export { djb2Hash, hashContent, hashPair } from '@rayu-dev/rayu-core'
