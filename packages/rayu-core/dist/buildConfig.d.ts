/**
 * Build configuration — the 11 `MACRO.*` values, and the endpoint resolution
 * that reads them.
 *
 * WHY THIS IS TWO LAYERS AND NOT ONE
 * The CLI resolves these values twice, with DIFFERENT operators and DIFFERENT
 * final fallbacks, and conflating them would silently change which server the
 * CLI talks to:
 *
 *   1. BUILD time — `rayu/scripts/macroValues.ts`, evaluated once when
 *      `bun run build` bakes literals into dist/rayu.js via `--define`.
 *      Uses `??`, so an env var set to the empty string IS honoured.
 *      Falls back to the PRODUCTION endpoints (api.rayucode.com, etc.).
 *
 *   2. RUN time — `rayu/src/services/rayuAuth/rayuSession.ts`, evaluated on
 *      every call. Uses `||`, so an empty string falls through.
 *      Falls back to LOCALHOST (:4000, :3000, :8080), never to production —
 *      production only ever arrives through the baked value from layer 1.
 *
 * That asymmetry is deliberate: a developer running from source with no baked
 * MACRO and no env talks to their own localhost stack, while a published binary
 * talks to production because the value was baked at build time. Collapsing the
 * two layers into a single default would point every from-source run at
 * production.
 *
 * Both layers are reproduced here as pure functions of an env record, so they
 * are testable without mutating `process.env` and usable from the VS Code
 * extension, which has no `MACRO` at all.
 */
/**
 * The 11 build-time values. Mirrors the ambient `MACRO` declared in
 * rayu/globals.d.ts; every field is a string because `--define` inlines them as
 * JSON string literals.
 */
export type BuildConfig = {
    VERSION: string;
    BUILD_TIME: string;
    PACKAGE_URL: string;
    NATIVE_PACKAGE_URL: string;
    FEEDBACK_CHANNEL: string;
    ISSUES_EXPLAINER: string;
    VERSION_CHANGELOG: string;
    RAYU_OAUTH_DEFAULT: string;
    RAYU_API_URL: string;
    RAYU_WEB_URL: string;
    RAYU_GATEWAY_URL: string;
};
/** Every key of {@link BuildConfig}, for drift tests against macroValues.ts. */
export declare const BUILD_CONFIG_KEYS: readonly ["VERSION", "BUILD_TIME", "PACKAGE_URL", "NATIVE_PACKAGE_URL", "FEEDBACK_CHANNEL", "ISSUES_EXPLAINER", "VERSION_CHANGELOG", "RAYU_OAUTH_DEFAULT", "RAYU_API_URL", "RAYU_WEB_URL", "RAYU_GATEWAY_URL"];
/** A `process.env`-shaped record, passed in rather than read, so this is pure. */
export type EnvLike = Readonly<Record<string, string | undefined>>;
/**
 * Literal defaults baked when neither a `RAYU_BUILD_*` nor a plain env var is
 * present at build time. These are the PRODUCTION endpoints.
 */
export declare const BUILD_TIME_DEFAULTS: {
    readonly PACKAGE_URL: "@rayu-dev/rayu-cli";
    readonly NATIVE_PACKAGE_URL: "@rayu-dev/rayu-cli";
    readonly FEEDBACK_CHANNEL: "https://github.com/Choeng-Rayu/rayu-cli/issues";
    readonly ISSUES_EXPLAINER: "report the issue at https://github.com/Choeng-Rayu/rayu-cli/issues";
    /**
     * DEFAULT: on. A fresh build with no RAYU_BUILD_OAUTH / USE_RAYU_OAUTH
     * requires Rayu login and shows the hosted provider.
     */
    readonly RAYU_OAUTH_DEFAULT: "true";
    readonly RAYU_API_URL: "https://api.rayucode.com/api";
    readonly RAYU_WEB_URL: "https://rayucode.com";
    readonly RAYU_GATEWAY_URL: "https://gateway.rayucode.com";
};
/**
 * Fallbacks used at RUN time when no env var and no baked value exist. Localhost
 * on purpose — see the header. Do not "fix" these to the production URLs.
 */
export declare const RUNTIME_FALLBACKS: {
    readonly RAYU_API_URL: "http://localhost:4000/api";
    readonly RAYU_WEB_URL: "http://localhost:3000";
    readonly RAYU_GATEWAY_URL: "http://localhost:8080";
};
/**
 * Layer 1: resolve the values a build would bake in.
 *
 * Precedence per value: `RAYU_BUILD_*` → plain env → literal default, using `??`
 * exactly as rayu/scripts/macroValues.ts does. `??` and not `||`: an operator
 * who sets `RAYU_BUILD_WEB_URL=""` gets the empty string, not the default.
 *
 * `version` is passed in because it comes from rayu/package.json, which core
 * must not reach into — core is a sibling package, not a child of the CLI.
 */
export declare function resolveBuildConfig(env: EnvLike, version: string): BuildConfig;
/**
 * Truthiness for env-style flags.
 *
 * Byte-identical to `isEnvTruthy` in rayu/src/utils/envUtils.ts: falsy input is
 * false, booleans pass through, otherwise the value is lowercased and trimmed
 * and compared against an allowlist. Notably `'0'`, `'off'`, `'no'` and any
 * other string are false — this is an allowlist, not a negation.
 */
export declare function isEnvTruthy(value: string | boolean | undefined): boolean;
/** Endpoints as the running process should use them. No trailing slashes. */
export type Endpoints = {
    apiBaseUrl: string;
    webBaseUrl: string;
    gatewayBaseUrl: string;
};
/**
 * Layer 2: resolve the endpoints in use right now.
 *
 * Precedence per endpoint: runtime env → baked build value → localhost, using
 * `||` exactly as rayu/src/services/rayuAuth/rayuSession.ts does, then a single
 * trailing slash is stripped. `||` and not `??`: an empty env var falls through
 * to the baked value here, which is the opposite of layer 1's behaviour and is
 * why the two are separate functions.
 */
export declare function resolveEndpoints(env: EnvLike, baked?: Partial<BuildConfig>): Endpoints;
/**
 * The values baked into this bundle, if any.
 *
 * Three runtimes have to be satisfied by one expression:
 *
 *   - the built CLI, where `rayu/scripts/build.ts` replaces the identifier
 *     `RAYU_BAKED_BUILD_CONFIG` with a JSON object literal via `--define`;
 *   - `bun run dev` and `bun test`, where no `--define` runs but
 *     `scripts/preload.ts` sets `globalThis.MACRO`;
 *   - the VS Code extension under plain Node, where neither exists.
 *
 * `typeof X !== 'undefined'` on an undeclared identifier is safe in JavaScript —
 * the same guarded-global pattern rayu already uses for `Bun`. Returns undefined
 * rather than throwing, so callers fall through to env and their own defaults.
 */
export declare function getBakedBuildConfig(): Partial<BuildConfig> | undefined;
//# sourceMappingURL=buildConfig.d.ts.map