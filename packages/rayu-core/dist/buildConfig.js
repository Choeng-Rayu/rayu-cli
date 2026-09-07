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
/** Every key of {@link BuildConfig}, for drift tests against macroValues.ts. */
export const BUILD_CONFIG_KEYS = [
    'VERSION',
    'BUILD_TIME',
    'PACKAGE_URL',
    'NATIVE_PACKAGE_URL',
    'FEEDBACK_CHANNEL',
    'ISSUES_EXPLAINER',
    'VERSION_CHANGELOG',
    'RAYU_OAUTH_DEFAULT',
    'RAYU_API_URL',
    'RAYU_WEB_URL',
    'RAYU_GATEWAY_URL',
];
/**
 * Literal defaults baked when neither a `RAYU_BUILD_*` nor a plain env var is
 * present at build time. These are the PRODUCTION endpoints.
 */
export const BUILD_TIME_DEFAULTS = {
    PACKAGE_URL: '@rayu-dev/rayu-cli',
    NATIVE_PACKAGE_URL: '@rayu-dev/rayu-cli',
    FEEDBACK_CHANNEL: 'https://github.com/Choeng-Rayu/rayu-cli/issues',
    ISSUES_EXPLAINER: 'report the issue at https://github.com/Choeng-Rayu/rayu-cli/issues',
    /**
     * DEFAULT: on. A fresh build with no RAYU_BUILD_OAUTH / USE_RAYU_OAUTH
     * requires Rayu login and shows the hosted provider.
     */
    RAYU_OAUTH_DEFAULT: 'true',
    RAYU_API_URL: 'https://api.rayucode.com/api',
    RAYU_WEB_URL: 'https://rayucode.com',
    RAYU_GATEWAY_URL: 'https://gateway.rayucode.com',
};
/**
 * Fallbacks used at RUN time when no env var and no baked value exist. Localhost
 * on purpose — see the header. Do not "fix" these to the production URLs.
 */
export const RUNTIME_FALLBACKS = {
    RAYU_API_URL: 'http://localhost:4000/api',
    RAYU_WEB_URL: 'http://localhost:3000',
    RAYU_GATEWAY_URL: 'http://localhost:8080',
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
export function resolveBuildConfig(env, version) {
    return {
        VERSION: version,
        BUILD_TIME: '',
        PACKAGE_URL: BUILD_TIME_DEFAULTS.PACKAGE_URL,
        NATIVE_PACKAGE_URL: BUILD_TIME_DEFAULTS.NATIVE_PACKAGE_URL,
        FEEDBACK_CHANNEL: BUILD_TIME_DEFAULTS.FEEDBACK_CHANNEL,
        ISSUES_EXPLAINER: BUILD_TIME_DEFAULTS.ISSUES_EXPLAINER,
        VERSION_CHANGELOG: '',
        RAYU_OAUTH_DEFAULT: env.RAYU_BUILD_OAUTH ??
            env.USE_RAYU_OAUTH ??
            BUILD_TIME_DEFAULTS.RAYU_OAUTH_DEFAULT,
        RAYU_API_URL: env.RAYU_BUILD_API_URL ?? env.RAYU_API_URL ?? BUILD_TIME_DEFAULTS.RAYU_API_URL,
        RAYU_WEB_URL: env.RAYU_BUILD_WEB_URL ?? env.RAYU_WEB_URL ?? BUILD_TIME_DEFAULTS.RAYU_WEB_URL,
        RAYU_GATEWAY_URL: env.RAYU_BUILD_GATEWAY_URL ??
            env.RAYU_GATEWAY_URL ??
            BUILD_TIME_DEFAULTS.RAYU_GATEWAY_URL,
    };
}
/**
 * Truthiness for env-style flags.
 *
 * Byte-identical to `isEnvTruthy` in rayu/src/utils/envUtils.ts: falsy input is
 * false, booleans pass through, otherwise the value is lowercased and trimmed
 * and compared against an allowlist. Notably `'0'`, `'off'`, `'no'` and any
 * other string are false — this is an allowlist, not a negation.
 */
export function isEnvTruthy(value) {
    if (!value)
        return false;
    if (typeof value === 'boolean')
        return value;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim());
}
/** Drop a single trailing slash, as every getter in rayuSession.ts does. */
function stripTrailingSlash(url) {
    return url.replace(/\/$/, '');
}
/**
 * Layer 2: resolve the endpoints in use right now.
 *
 * Precedence per endpoint: runtime env → baked build value → localhost, using
 * `||` exactly as rayu/src/services/rayuAuth/rayuSession.ts does, then a single
 * trailing slash is stripped. `||` and not `??`: an empty env var falls through
 * to the baked value here, which is the opposite of layer 1's behaviour and is
 * why the two are separate functions.
 */
export function resolveEndpoints(env, baked) {
    return {
        apiBaseUrl: stripTrailingSlash(env.RAYU_API_URL || baked?.RAYU_API_URL || RUNTIME_FALLBACKS.RAYU_API_URL),
        webBaseUrl: stripTrailingSlash(env.RAYU_WEB_URL || baked?.RAYU_WEB_URL || RUNTIME_FALLBACKS.RAYU_WEB_URL),
        gatewayBaseUrl: stripTrailingSlash(env.RAYU_GATEWAY_URL ||
            baked?.RAYU_GATEWAY_URL ||
            RUNTIME_FALLBACKS.RAYU_GATEWAY_URL),
    };
}
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
export function getBakedBuildConfig() {
    // Replaced with an object literal by Bun's --define in the published bundle.
    if (typeof RAYU_BAKED_BUILD_CONFIG !== 'undefined') {
        return RAYU_BAKED_BUILD_CONFIG;
    }
    const fromGlobal = globalThis.MACRO;
    return fromGlobal ?? undefined;
}
//# sourceMappingURL=buildConfig.js.map