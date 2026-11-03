// Dev/run preload: inject MACRO global so `bun run`/`bun run dev` work without a
// full build (bun --define only applies at build time). Registered via bunfig.toml.
//
// This uses MACRO_VALUES as-is, so `bun run dev` honors the same default as a
// real build: RAYU_OAUTH_DEFAULT resolves from the build-time env
// (RAYU_BUILD_OAUTH / USE_RAYU_OAUTH) and otherwise defaults to 'true' (login
// on). A runtime USE_RAYU_OAUTH=false in your shell/.env still overrides it.
//
// NOTE: the TEST suite uses a separate hermetic preload (scripts/preload.test.ts,
// wired via bunfig `[test] preload`) that forces the default OFF.
import { installFeatureTable } from '../src/core/index.js'
import { MACRO_VALUES } from './macroValues.ts'
import { DEV_FEATURE_TABLE } from './featureTable.ts'

;(globalThis as { MACRO?: typeof MACRO_VALUES }).MACRO = MACRO_VALUES

// Feature flags for the un-bundled runtime. `--define` only applies at build
// time, so without this every `FEATURES.X` in src/ would throw a ReferenceError
// under `bun run dev`.
//
// The table is ALL FALSE, which is not an oversight: it reproduces exactly what
// `feature()` from `bun:bundle` returned when run rather than bundled. Measured
// under both `bun -e` and `bun test` — false for every flag, including the four
// enabled at build time. Turning them on here would silently change dev
// behaviour relative to today.
installFeatureTable(DEV_FEATURE_TABLE)

// Default to the external (non-Anthropic-employee) user type so ant-only code
// paths dead-code-eliminate / no-op.
process.env.USER_TYPE ??= 'external'
