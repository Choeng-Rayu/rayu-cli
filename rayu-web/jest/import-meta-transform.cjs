/*
 * Jest transformer that substitutes Vite's `import.meta` globals, mirroring what
 * webpack's DefinePlugin does for the real build (see next.config.mjs).
 *
 * WHY IT IS NEEDED
 *
 * The copied bolt.diy sources read `import.meta.env` and `import.meta.hot`. ts-jest
 * compiles to CommonJS, where `import.meta` is a syntax error:
 *
 *   SyntaxError: Cannot use 'import.meta' outside a module
 *
 * Rather than edit ~69 call sites purely to make tests run — or move the whole
 * suite to ESM with --experimental-vm-modules — the same textual substitution is
 * applied here, so tests exercise the same code the browser gets.
 *
 * Values are the TEST equivalents of the build-time ones. Third-party access
 * tokens are `undefined`, exactly as in production: nothing should behave
 * differently under test because a credential appeared.
 */
const tsJest = require('ts-jest').default ?? require('ts-jest');

const IMPORT_META_ENV = JSON.stringify({
  DEV: true,
  PROD: false,
  SSR: false,
  VITE_LOG_LEVEL: 'none',
  VITE_DISABLE_PERSISTENCE: 'true',
  VITE_APP_VERSION: '0.0.0-test',
  VITE_GIT_BRANCH: '',
  VITE_GIT_COMMIT: '',
});

/** Order matters: replace `.hot` before the bare `import.meta`. */
function substitute(code) {
  return code
    .replace(/import\.meta\.hot/g, 'undefined')
    .replace(/import\.meta\.env/g, IMPORT_META_ENV);
}

const base = tsJest.createTransformer({
  // Studio sources use modern syntax; isolatedModules keeps per-file compilation
  // fast and matches how the bundler treats them.
  isolatedModules: true,
  tsconfig: {
    /*
     * rayu-web's tsconfig sets "jsx": "preserve" because Next does the JSX
     * transform itself. Jest has no such step, so leaving JSX in place fails with
     * `SyntaxError: Unexpected token '<'` as soon as a test imports a .tsx file.
     * react-jsx emits the automatic runtime, so no React import is required.
     */
    jsx: 'react-jsx',
    // CommonJS is what the Jest runtime executes.
    module: 'commonjs',
    esModuleInterop: true,
  },
});

module.exports = {
  ...base,
  process(sourceText, sourcePath, options) {
    return base.process(substitute(sourceText), sourcePath, options);
  },
  processAsync(sourceText, sourcePath, options) {
    return base.processAsync(substitute(sourceText), sourcePath, options);
  },
  getCacheKey(sourceText, sourcePath, options) {
    // Fold the substituted values into the cache key so changing them invalidates.
    return `${base.getCacheKey(sourceText, sourcePath, options)}-${IMPORT_META_ENV}`;
  },
};
