// Dev/test preload: inject MACRO global so `bun run`/`bun test` work without a
// full build (bun --define only applies at build time). Registered via bunfig.toml.
import { MACRO_VALUES } from './macroValues.ts'

;(globalThis as { MACRO?: typeof MACRO_VALUES }).MACRO = MACRO_VALUES

// Default to the external (non-Anthropic-employee) user type so ant-only code
// paths dead-code-eliminate / no-op.
process.env.USER_TYPE ??= 'external'
