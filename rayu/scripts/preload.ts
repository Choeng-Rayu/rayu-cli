// Dev/test preload: inject MACRO global so `bun run`/`bun test` work without a
// full build (bun --define only applies at build time). Registered via bunfig.toml.
import { MACRO_VALUES } from './macroValues.ts'

// Tests must be hermetic: the baked RAYU_OAUTH_DEFAULT now derives from the
// build-time .env (so a real build bakes the operator's USE_RAYU_OAUTH), but in
// dev/test we force the default OFF so behavior depends only on what each test
// sets explicitly via process.env.USE_RAYU_OAUTH — not on the ambient shell.
;(globalThis as { MACRO?: typeof MACRO_VALUES }).MACRO = {
  ...MACRO_VALUES,
  RAYU_OAUTH_DEFAULT: 'false',
}

// Default to the external (non-Anthropic-employee) user type so ant-only code
// paths dead-code-eliminate / no-op.
process.env.USER_TYPE ??= 'external'
