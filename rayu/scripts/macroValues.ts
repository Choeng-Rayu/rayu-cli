// Single source of truth for MACRO.* values. Consumed by scripts/build.ts
// (as `bun build --define`) and scripts/preload.ts (dev/test global).
import pkg from '../package.json' with { type: 'json' }

export const MACRO_VALUES = {
  VERSION: pkg.version,
  BUILD_TIME: '',
  PACKAGE_URL: '@rayu-dev/rayu-cli',
  NATIVE_PACKAGE_URL: '@rayu-dev/rayu-cli',
  FEEDBACK_CHANNEL: 'https://github.com/Choeng-Rayu/rayu-cli/issues',
  ISSUES_EXPLAINER: 'report the issue at https://github.com/Choeng-Rayu/rayu-cli/issues',
  VERSION_CHANGELOG: '',
}
