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
import { MACRO_VALUES } from './macroValues.ts'

;(globalThis as { MACRO?: typeof MACRO_VALUES }).MACRO = MACRO_VALUES

// Default to the external (non-Anthropic-employee) user type so ant-only code
// paths dead-code-eliminate / no-op.
process.env.USER_TYPE ??= 'external'
