/**
 * Content hashing, portable across Bun and plain Node.
 *
 * Migrated from rayu/src/utils/hash.ts, semantics unchanged. The Bun and Node
 * paths deliberately produce DIFFERENT digests — wyhash vs SHA-256 — so callers
 * must only ever compare hashes computed by the same process. Tests therefore
 * assert STABILITY (same input, same output, within a runtime), never equality
 * across runtimes. `djb2Hash` is the exception: it is pure arithmetic and so is
 * identical everywhere, which is why it is the one to use for anything written
 * to disk, such as a cache directory name that must survive a runtime upgrade.
 *
 * The Node fallback statically imports `node:crypto`.
 *
 * It used to go through `createRequire(import.meta.url)`, to keep the fallback
 * lazy. That broke when this module was bundled into the VS Code extension: the
 * extension host bundle is CJS, `import.meta.url` is undefined there, and
 * `createRequire(undefined)` throws
 * `The argument 'filename' must be a file URL object … Received undefined`
 * at module load — taking the whole extension down before any code ran.
 *
 * A static import of a BUILTIN is the right shape here: `node:crypto` costs
 * nothing to resolve, is present in every runtime core targets, and carries no
 * bundler assumptions. Laziness was only ever needed for npm PACKAGES —
 * `utils/semver.ts` and `utils/yaml.ts` fall back to real packages, which is
 * exactly why they must stay in rayu/ where Bun can inline them.
 */
import { createHash } from 'node:crypto';
/**
 * djb2 string hash — fast non-cryptographic hash returning a signed 32-bit int.
 * Deterministic across runtimes (unlike Bun.hash which uses wyhash). Use as a
 * fallback when Bun.hash isn't available, or when you need on-disk-stable
 * output (e.g. cache directory names that must survive runtime upgrades).
 */
export function djb2Hash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
}
/**
 * Hash arbitrary content for change detection. Bun.hash is ~100x faster than
 * sha256 and collision-resistant enough for diff detection (not crypto-safe).
 */
export function hashContent(content) {
    if (typeof Bun !== 'undefined') {
        return Bun.hash(content).toString();
    }
    return createHash('sha256').update(content).digest('hex');
}
/**
 * Hash two strings without allocating a concatenated temp string. Bun path
 * seed-chains wyhash (hash(a) feeds as seed to hash(b)); Node path uses
 * incremental SHA-256 update. Seed-chaining naturally disambiguates
 * ("ts","code") vs ("tsc","ode") so no separator is needed under Bun.
 */
export function hashPair(a, b) {
    if (typeof Bun !== 'undefined') {
        return Bun.hash(b, Bun.hash(a)).toString();
    }
    return createHash('sha256').update(a).update('\0').update(b).digest('hex');
}
//# sourceMappingURL=hash.js.map