// Single source of truth for MACRO.* values. Consumed by scripts/build.ts
// (as `bun build --define`) and scripts/preload.ts (dev/test global).
//
// The resolution logic now lives in src/core
// (`resolveBuildConfig`), so the CLI and the VS Code extension compute the same
// endpoints from the same code instead of the extension re-deriving them. This
// file keeps its exact public shape — `MACRO_VALUES` and `ENABLED_FEATURES` —
// because scripts/build.ts, scripts/preload.ts and scripts/preload.test.ts all
// depend on it, so nothing downstream changes.
//
// Precedence is unchanged and is asserted against this file by
// test/portability.test.ts:
//   RAYU_BUILD_* → plain env → literal default,  using ?? (not ||), so an env
// var explicitly set to the empty string is honoured.
//
// Set these at BUILD time for a release, e.g.:
//   RAYU_BUILD_OAUTH=true \
//   RAYU_BUILD_API_URL=https://rayu.example.com/api \
//   RAYU_BUILD_WEB_URL=https://rayu.example.com bun run build
// Runtime env vars (USE_RAYU_OAUTH / RAYU_API_URL / RAYU_WEB_URL /
// RAYU_GATEWAY_URL) still override these for local development — that is a
// SEPARATE resolution layer, `resolveEndpoints()` in core, which falls back to
// localhost rather than production. See the header of core's buildConfig.ts.
//
// IMPORTANT (feature-gating correctness): the baked default is what the CLI uses
// when no runtime env var is present. Since loadDotEnv() only reads the .env in
// the user's CURRENT working directory, a binary run from any other folder would
// otherwise fall back to this default. We therefore fall back to the BUILD-TIME
// .env values (Bun auto-loads .env before this runs). This makes `bun run build`
// bake the operator's intended config so entitlement gating is active regardless
// of the directory the CLI is launched from.
//
// DEFAULT: on. With no RAYU_BUILD_OAUTH / USE_RAYU_OAUTH present at build, the
// baked default is 'true' — a fresh build requires Rayu login and shows the
// hosted provider. Set RAYU_BUILD_OAUTH=false (build) or USE_RAYU_OAUTH=false
// (runtime) to opt out.
import { resolveBuildConfig } from '../src/core/index.js'
import pkg from '../package.json' with { type: 'json' }

export const MACRO_VALUES = resolveBuildConfig(process.env, pkg.version)

// The enabled-flag allowlist now lives in src/core, so the CLI build
// and core's own `isFeatureEnabled()` cannot disagree — a drift test would only
// have detected a divergence after the fact; a single definition prevents it.
// Re-exported here because scripts/build.ts has always imported it from this
// module, and Bun.build({ features }) still consumes it verbatim.
export { ENABLED_FEATURES } from '../src/core/index.js'
