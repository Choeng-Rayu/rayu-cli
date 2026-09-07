/**
 * The slice of Bun's global that core's portable modules touch.
 *
 * Core is compiled by `tsc` as a standalone package and must run under plain
 * Node, so it cannot depend on `bun-types` the way rayu/ does. Declaring only
 * what is used keeps the fast paths typed without pretending Bun is present.
 *
 * EVERY access must be guarded with `typeof Bun !== 'undefined'`. That is not
 * style: `rayu/scripts/analyze-boundary.ts` classifies unguarded `Bun.*` as an
 * impurity and `bun run boundary` fails on it.
 */
declare global {
  // eslint-disable-next-line no-var
  var Bun:
    | {
        /** wyhash. Fast, non-cryptographic, and NOT stable across versions. */
        hash: ((input: string) => bigint | number) & {
          (input: string, seed: bigint | number): bigint | number
        }
        YAML: { parse(input: string): unknown }
        semver: {
          order(a: string, b: string): -1 | 0 | 1
          satisfies(version: string, range: string): boolean
        }
      }
    | undefined
}

export {}
