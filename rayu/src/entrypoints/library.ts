/**
 * The library surface — what `rayucode` imports from `rayu/src`.
 *
 * GOAL
 * One source tree, two consumers. The CLI and the VS Code extension run the SAME
 * code from `rayu/src` instead of the extension re-implementing pieces of it.
 * `rayu/src` is not restructured to achieve this: this file is a barrel, and
 * `scripts/build-lib.ts` bundles it into `dist/rayu-lib.js` exactly as
 * `scripts/build.ts` bundles `cli.tsx` into `dist/rayu.js`.
 *
 * WHY A SECOND BUNDLE RATHER THAN IMPORTING `rayu/src` DIRECTLY
 * The extension has no Bun. `rayu/src` depends on Bun-bundler features that only
 * exist at build time: `bun:bundle`'s `feature()` in 62 files, the `MACRO.*` and
 * `RAYU_FEATURES.*` defines, the `@ant/*` stub aliases, and externalised native
 * modules. More importantly, `rayu` is built from PARTIAL source — several
 * `require()`d modules were never present, and they only disappear because a
 * feature gate or a `process.env.USER_TYPE` comparison folds to a constant and
 * Bun eliminates the branch. Point another bundler at `rayu/src` and it stops at
 * `Could not resolve "./tools/REPLTool/REPLTool.js"`. Bundling here, with the
 * CLI's own configuration, is what makes the source consumable at all.
 *
 * WHY THIS IS SMALL DESPITE THE IMPORT GRAPH
 * `services/rayuAuth/rayuSession.ts` has a transitive closure of 2037 files that
 * includes the React UI, because 74% of `rayu/src` sits in one import cycle. Bun
 * tree-shakes at the SYMBOL level, so building from this narrow barrel keeps only
 * what the listed exports actually reach: measured at 18 KB with no `react` and
 * no `jsx-runtime`, against 23.6 MB for the CLI bundle. A cycle prevents MOVING
 * files; it does not prevent exposing a surface.
 *
 * ADDING TO THIS FILE
 * Every export widens the graph. `test/libraryBundle.test.ts` enforces a size
 * budget and asserts the emitted bundle contains no `react` / `jsx-runtime` /
 * `bun:` specifier, so an export that drags the terminal UI in fails CI rather
 * than quietly adding megabytes. Known-expensive today (~20 MB each, they reach
 * the UI at runtime): `commands.ts`, `utils/claudemd.ts`, `services/mcp/config.ts`.
 * Widen those only after cutting the edges the boundary analyzer ranks:
 *   bun run scripts/analyze-boundary.ts --cut-candidates
 *
 * See RAYU_LIBRARY_SURFACE_DESIGN.md.
 */

// ── Rayu account auth ────────────────────────────────────────────────────────
//
// The extension currently duplicates ~40 lines of this module because
// WORKSPACE.md §3 forbade importing rayu/src. These exports retire that copy.
// Both sides then read and write the same ~/.rayu/rayu-auth.json at 0600, with
// one refresh implementation — no second credential store, and no two refresh
// cycles racing to rotate the same refresh token.
export {
  clearRayuSession,
  getRayuApiBaseUrl,
  getRayuGatewayBaseUrl,
  getRayuWebBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
  isUseRayuOAuthEnabled,
  readRayuSession,
  writeRayuSession,
  type RayuSessionStore,
  type RayuSessionUser,
} from '../services/rayuAuth/rayuSession.js'

// ── Build configuration ──────────────────────────────────────────────────────
//
// Re-exported from @rayu-dev/rayu-core so a consumer needs ONE import to get the
// endpoints and the values they were resolved from. This is also what fixes a
// real divergence: the extension's own endpoint helper cannot see the CLI's baked
// `MACRO.RAYU_API_URL`, so a packaged extension falls back to localhost where the
// packaged CLI uses the baked production host.
export {
  getBakedBuildConfig,
  isEnvTruthy,
  resolveEndpoints,
  type BuildConfig,
  type Endpoints,
} from '@rayu-dev/rayu-core'

// ── Provider configuration ───────────────────────────────────────────────────
//
// `utils/rayuConfig.ts` reads and writes ~/.rayu/config.json — the provider list
// the CLI shows in `/connect` and the model picker. The extension needs the same
// view to reach parity on model selection instead of asking the engine over the
// wire for something that is on disk.
//
// Measured cost: ~456 KB, clean (no react, no jsx-runtime).
export {
  getActiveProvider,
  getValidDefaultModel,
  isLikelyChatModel,
  loadRayuConfig,
  removeProvider,
  saveRayuConfig,
  setActiveProvider,
  setActiveProviderModel,
  upsertProvider,
  type ProviderKind,
  type RayuConfig,
  type RayuProvider,
  type WireFormat,
} from '../utils/rayuConfig.js'

export { RAYU_API_PROVIDER_ID } from '../utils/rayuProviders.js'

// ── MCP helpers ──────────────────────────────────────────────────────────────
//
// The two pure pieces of the MCP layer, for the extension's server management
// (plan Task 18). Deliberately NOT `services/mcp/config.ts`: that module reaches
// the React UI at runtime through
//   config.ts → plugins/pluginLoader.ts → marketplaceManager.ts → cacheUtils.ts
//   → utils/attachments.ts → types/textInputTypes.ts
// and costs 20 MB. These two are ~1 KB combined.
export { normalizeNameForMCP } from '../services/mcp/normalization.js'
export { expandEnvVarsInString } from '../services/mcp/envExpansion.js'

// ── Product and OAuth constants ──────────────────────────────────────────────
//
// Shared strings and OAuth parameters, so the extension's sign-in flow and any
// user-facing product naming match the CLI exactly rather than being retyped.
export * from '../constants/product.js'

/**
 * Session transcript discovery, for the VS Code history browser (UI_PARITY flow 15).
 *
 * The control protocol has NO "list sessions" request — its 23 subtypes cover
 * initialize, permissions, MCP, models and interrupts, but not enumeration. The CLI's
 * `/resume` reads transcripts straight from `~/.rayu/projects/<sanitised-cwd>/*.jsonl`,
 * so a browser has to do the same.
 *
 * These come from `sessionStoragePortable.ts`, which is dependency-light by design, so
 * the extension derives the path with the SAME `sanitizePath` the writer uses instead
 * of reimplementing it — a near-miss there would silently read an empty directory.
 */
export {
  extractFirstPromptFromHead,
  getProjectDir,
  getProjectsDir,
  readSessionLite,
  sanitizePath,
  validateUuid,
} from '../utils/sessionStoragePortable.js'
