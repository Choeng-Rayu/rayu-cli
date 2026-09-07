/**
 * djb2 string hash — fast non-cryptographic hash returning a signed 32-bit int.
 * Deterministic across runtimes (unlike Bun.hash which uses wyhash). Use as a
 * fallback when Bun.hash isn't available, or when you need on-disk-stable
 * output (e.g. cache directory names that must survive runtime upgrades).
 */
export declare function djb2Hash(str: string): number;
/**
 * Hash arbitrary content for change detection. Bun.hash is ~100x faster than
 * sha256 and collision-resistant enough for diff detection (not crypto-safe).
 */
export declare function hashContent(content: string): string;
/**
 * Hash two strings without allocating a concatenated temp string. Bun path
 * seed-chains wyhash (hash(a) feeds as seed to hash(b)); Node path uses
 * incremental SHA-256 update. Seed-chaining naturally disambiguates
 * ("ts","code") vs ("tsc","ode") so no separator is needed under Bun.
 */
export declare function hashPair(a: string, b: string): string;
//# sourceMappingURL=hash.d.ts.map