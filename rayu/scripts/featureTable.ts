// The feature table used by the two preloads (dev and test).
//
// `--define` only substitutes `FEATURES.*` during `bun run build`, so any
// un-bundled run — `bun run dev`, `bun test` — needs the table installed on the
// global or every rewritten call site throws a ReferenceError.
//
// ALL FLAGS ARE FALSE, deliberately. That is what `feature()` from `bun:bundle`
// evaluated to when the code was run rather than bundled: measured under both
// `bun -e` and `bun test`, it returned false for every flag, including the four
// that `Bun.build({ features })` enables in dist/rayu.js. Reproducing it keeps
// dev and test behaviour byte-identical to before the Task 4 codemod.
//
// Enabling the shipped four here would be defensible — arguably dev should match
// the published binary — but it is a behaviour CHANGE and belongs in its own
// commit with its own test run, not smuggled into a mechanical codemod.
import { buildFeatureTable } from '../src/core/index.js'
import ALL_FLAGS from '../feature-flags.json' with { type: 'json' }

export const DEV_FEATURE_TABLE: Record<string, boolean> = buildFeatureTable(
  ALL_FLAGS,
  /* enabled */ [],
)
