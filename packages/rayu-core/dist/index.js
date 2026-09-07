/**
 * `@rayu-dev/rayu-core` — the shared Rayu engine core.
 *
 * Everything both consumers need with no terminal UI attached: build
 * configuration, portability shims, config, auth, tools, commands, context, MCP
 * and the query engine. The Ink/React terminal UI stays in `@rayu-dev/rayu-cli`;
 * the webview UI stays in the Rayucode extension.
 *
 * ## Consumption
 *
 *   - `rayu/` takes this as a `file:` **devDependency** and lets Bun bundle it,
 *     because `@rayu-dev/rayu-cli` must keep zero runtime `dependencies` —
 *     declaring them made `npm install -g` resolve and compile ~80 packages and
 *     fail differently on every machine.
 *   - the extension takes it as a real npm **dependency** under plain Node, with
 *     no bundler, so nothing here may require a Bun-only API unguarded.
 *
 * ## Boundary rule
 *
 * No `react`, no `ink`, no `bun:*` import, no unguarded `Bun.*`. That is not a
 * convention, it is enforced: `rayu/scripts/analyze-boundary.ts` computes the
 * import closure and `bun run boundary` fails when it regresses.
 *
 * See RAYU_CORE_MIGRATION_PLAN.md and WORKSPACE.md.
 */
export { BUILD_CONFIG_KEYS, BUILD_TIME_DEFAULTS, RUNTIME_FALLBACKS, getBakedBuildConfig, isEnvTruthy, resolveBuildConfig, resolveEndpoints, } from './buildConfig.js';
export { ENABLED_FEATURES, buildFeatureTable, installFeatureTable, } from './features.js';
export { djb2Hash, hashContent, hashPair } from './portable/hash.js';
//# sourceMappingURL=index.js.map