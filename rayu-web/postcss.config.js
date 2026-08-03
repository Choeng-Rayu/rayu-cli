/*
 * Two utility engines share this pipeline:
 *
 *   tailwindcss     -> marketing site, dashboard, admin (app/**, components/**)
 *   @unocss/postcss -> Rayu Studio only (studio/**, app/studio/**)
 *
 * They coexist because bolt.diy's UI depends on UnoCSS features (642 `i-ph:*`
 * icon classes, a custom `bolt-*` theme) that would be a large rewrite to port,
 * while rayu-web's own pages are already Tailwind.
 *
 * Safety rests on two invariants:
 *   1. Mutually exclusive content globs (uno.config.ts / tailwind.config.js).
 *   2. UnoCSS output loads AFTER globals.css — studio/styles/uno.css is imported
 *      only by app/studio/layout.tsx, so Next emits it on studio routes where it
 *      wins on any class name both engines happen to generate.
 *
 * @unocss/postcss runs before autoprefixer so its @unocss directives are
 * expanded into real declarations first.
 */
module.exports = {
  plugins: {
    /*
     * Referenced by PATH, not by package name: Next calls
     * require(plugin)(options) without unwrapping an ESM default export, and
     * @unocss/postcss's CJS build exports { default: fn }. See postcss/unocss.cjs.
     */
    './postcss/unocss.cjs': {
      configOrPath: './uno.config.ts',
    },
    tailwindcss: {},
    autoprefixer: {},
  },
};
