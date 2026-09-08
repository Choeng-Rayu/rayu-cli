/**
 * `src/core` — the shared Rayu engine core.
 *
 * Build configuration, the feature-flag table, and portable hashing: the pieces
 * every consumer needs with no terminal UI attached.
 *
 * ## History
 *
 * This was `@rayu-dev/rayu-core`, a separate npm workspace package under
 * `rayu-cli/packages/`, consumed by `rayu/` as a `file:` devDependency. That
 * split existed to serve a second consumer — the previous VS Code extension —
 * which lived in its own package and imported core over a package boundary.
 *
 * That extension is gone, and so is the boundary. `rayu/src` is now the single
 * shared source: the CLI and the Rayucode extension are both built from it by
 * `scripts/build.ts` and `scripts/build-vscode.ts` respectively. Keeping core
 * outside `rayu/` bought nothing and cost a workspace root, a `file:` link that
 * broke the build the moment the directory moved, and a published surface with
 * no npm consumer.
 *
 * ## Boundary rule (unchanged, and still enforced)
 *
 * No `react`, no `ink`, no `bun:*` import, no unguarded `Bun.*`. This module is
 * reachable from the VS Code extension host, where none of those exist. Guard
 * every `Bun.*` access with `typeof Bun !== 'undefined'` so the plain-Node path
 * stays correct.
 */

export {
  BUILD_CONFIG_KEYS,
  BUILD_TIME_DEFAULTS,
  RUNTIME_FALLBACKS,
  getBakedBuildConfig,
  isEnvTruthy,
  resolveBuildConfig,
  resolveEndpoints,
  type BuildConfig,
  type EnvLike,
  type Endpoints,
} from './buildConfig.js'

export {
  ENABLED_FEATURES,
  buildFeatureTable,
  installFeatureTable,
  type EnabledFeature,
  type FeatureTable,
} from './features.js'

export { djb2Hash, hashContent, hashPair } from './portable/hash.js'
