import { createRequire } from 'node:module'

/*
 * next.config.mjs is an ES module, so require.resolve is not in scope. The
 * binding is deliberately NOT called `require`: shadowing that name inside a
 * module Next itself loads breaks its config loader.
 */
const resolveModule = createRequire(import.meta.url).resolve

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained server bundle for the Docker image.
  output: 'standalone',

  /*
   * `webpack` comes from the options object rather than a top-level import: Next
   * bundles its own copy and does not expose the package for direct require, so
   * importing it would fail to resolve.
   */
  webpack: (config, { isServer, dev, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,

        /*
         * Suppress warnings about Node.js APIs in Edge Runtime during build.
         * The jose library (used by next-auth) uses CompressionStream which
         * is not supported in Edge Runtime, but works fine in Node.js runtime.
         */
        fs: false,
        net: false,
        tls: false,
        child_process: false,

        /*
         * Rayu Studio's browser-side git/archive stack needs Node built-ins that
         * bolt.diy supplied with vite-plugin-node-polyfills. isomorphic-git,
         * jszip, jspdf and istextorbinary all reach for these.
         */
        buffer: resolveModule('buffer/'),
        stream: resolveModule('stream-browserify'),
        util: resolveModule('util/'),
        path: resolveModule('path-browserify'),
        crypto: resolveModule('crypto-browserify'),
        process: resolveModule('process/browser'),
      }

      // The same libraries expect these as globals, not imports.
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        }),
      )

      /*
       * Strip the `node:` scheme so the fallbacks above apply.
       *
       * `resolve.fallback` keys are bare specifiers ('crypto'), so a
       * `node:`-prefixed import is not matched and webpack fails with
       * "UnhandledSchemeError: Reading from node:crypto is not handled by
       * plugins". bolt.diy got this for free from vite-plugin-node-polyfills'
       * `protocolImports: true`.
       *
       * Affects studio/lib/modules/llm/providers/z-ai.ts (node:crypto, for its
       * request signature) and studio/lib/stores/files.ts (node:buffer).
       */
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '')
        }),
      )
    }

    /*
     * Vite globals used throughout the copied bolt.diy sources. Substituting them
     * here means none of the 390 studio files had to be edited, and it is why
     * `import.meta.env` / `import.meta.hot` typecheck (see
     * studio/types/import-meta.d.ts).
     *
     * `import.meta.hot` becomes `undefined`, so every `if (import.meta.hot)`
     * HMR-state block compiles away to `if (false) {}`. Verified against this
     * webpack build, not assumed.
     */
    config.plugins.push(
      new webpack.DefinePlugin({
        'import.meta.hot': 'undefined',
        'import.meta.env': JSON.stringify({
          DEV: dev,
          PROD: !dev,
          SSR: isServer,

          VITE_LOG_LEVEL: process.env.NEXT_PUBLIC_STUDIO_LOG_LEVEL ?? (dev ? 'debug' : 'info'),
          VITE_DISABLE_PERSISTENCE: process.env.NEXT_PUBLIC_STUDIO_DISABLE_PERSISTENCE ?? '',
          VITE_APP_VERSION: process.env.NEXT_PUBLIC_STUDIO_VERSION ?? '',
          VITE_GIT_BRANCH: process.env.NEXT_PUBLIC_STUDIO_GIT_BRANCH ?? '',
          VITE_GIT_COMMIT: process.env.NEXT_PUBLIC_STUDIO_GIT_COMMIT ?? '',

          /*
           * Third-party credentials are DELIBERATELY absent. bolt.diy read these
           * from the build environment; Rayu Studio keeps them encrypted in
           * rayu-backend (studio_connections) because anything defined here would
           * be compiled into the client bundle and readable by any visitor.
           * The call sites fall back to asking the backend.
           */
        }),
      }),
    )

    return config
  },

  /*
   * Next 15 renamed experimental.serverComponentsExternalPackages to
   * serverExternalPackages. jose (next-auth) and @webcontainer/api must not be
   * bundled into the server build.
   */
  serverExternalPackages: ['jose', '@webcontainer/api'],

  async headers() {
    return [
      {
        /*
         * WebContainer requires the document to be cross-origin isolated.
         *
         * Scoped to /studio ONLY. These are per-DOCUMENT headers, so studio pages
         * are isolated while the marketing site, /sign-in and /dashboard are not —
         * which matters because COOP: same-origin severs window.opener and COEP
         * strips credentials from cross-origin subresources.
         *
         * CONSEQUENCE: a client-side (soft) navigation into /studio reuses the
         * previous, non-isolated document, leaving window.crossOriginIsolated
         * false and WebContainer.boot() failing. Every link into and out of
         * /studio must therefore be a full page load — see the plain <a> elements
         * in app/components/NavAuth.tsx and the studio header.
         */
        source: '/studio/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
    ]
  },
}

export default nextConfig
