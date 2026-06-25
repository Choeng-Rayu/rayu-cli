// Test preload (registered via bunfig.toml `[test] preload`). Injects the MACRO
// global like the dev preload, but FORCES the Rayu OAuth default OFF so the test
// suite is hermetic: feature/login behavior depends only on what each test sets
// explicitly via process.env.USE_RAYU_OAUTH, never on the shipped default (which
// is now 'true') or the ambient shell.
import { MACRO_VALUES } from './macroValues.ts'

;(globalThis as { MACRO?: typeof MACRO_VALUES }).MACRO = {
  ...MACRO_VALUES,
  RAYU_OAUTH_DEFAULT: 'false',
}

// Default to the external (non-Anthropic-employee) user type so ant-only code
// paths dead-code-eliminate / no-op.
process.env.USER_TYPE ??= 'external'
