/**
 * zod's locale table, reduced to English — for the VS Code extension host bundle ONLY.
 *
 * `zod/v4` exposes every locale through `export * as locales from "../locales/index.js"`.
 * A namespace re-export cannot be tree-shaken once the `z` namespace itself is used as a
 * value, so all ~50 translations (~211 KB) were bundled into `extension.js`, parsed on
 * every activation and never used: the host only validates engine frames and never calls
 * `z.config(z.locales.*())`. zod's default error map stays English — `classic/external.js`
 * imports `en.js` directly — so messages are unchanged.
 *
 * Applied by `zodEnglishLocalesOnlyPlugin()` in scripts/bundleConfig.ts, from the host
 * build in scripts/build-vscode.ts. The engine and CLI bundles keep every locale.
 *
 * The trade-off: in the host, `z.locales.<anything but en>` is undefined. Code that needs
 * a translated zod error map belongs in the engine child, not the extension host.
 */
export { default as en } from 'zod/v4/locales/en.js'
