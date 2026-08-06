/*
 * Type declarations for the Vite globals the copied bolt.diy code still
 * references. The VALUES are substituted at build time by webpack's DefinePlugin
 * (see next.config.mjs); these declarations only stop `tsc` from erroring on
 * expressions webpack will have already replaced.
 *
 * Keep the two in sync: a field declared here but not defined in next.config.mjs
 * typechecks and then evaluates to `undefined` at runtime.
 */

interface StudioImportMetaEnv {
  /** NODE_ENV !== 'production' */
  readonly DEV: boolean;
  /** NODE_ENV === 'production' */
  readonly PROD: boolean;
  /** True in the server bundle, false in the browser bundle. */
  readonly SSR: boolean;
  /** Log verbosity for utils/logger.ts. */
  readonly VITE_LOG_LEVEL?: string;
  /** When 'true', chat history is not written to IndexedDB. */
  readonly VITE_DISABLE_PERSISTENCE?: string;
  /** Displayed in the settings UI. */
  readonly VITE_APP_VERSION?: string;
  readonly VITE_GIT_BRANCH?: string;
  readonly VITE_GIT_COMMIT?: string;

  /*
   * Third-party credentials bolt.diy read from the build environment.
   *
   * These are ALWAYS undefined in Rayu Studio and must stay that way. Studio is a
   * pure frontend: a GitHub/GitLab/Netlify/Vercel/Supabase token compiled into the
   * client bundle would be readable by anyone who loads the page, which is
   * precisely what rayu-backend's encrypted `studio_connections` table exists to
   * avoid. The code paths that read them fall back to asking the backend.
   */
  readonly VITE_GITHUB_ACCESS_TOKEN?: undefined;
  readonly VITE_GITHUB_TOKEN_TYPE?: undefined;
  readonly VITE_GITLAB_ACCESS_TOKEN?: undefined;
  readonly VITE_NETLIFY_ACCESS_TOKEN?: undefined;
  readonly VITE_VERCEL_ACCESS_TOKEN?: undefined;
  readonly VITE_SUPABASE_ACCESS_TOKEN?: undefined;

  /*
   * LocalProvidersTab indexes this object with a computed provider key
   * (`import.meta.env[provider.envKey]`), so an index signature is required.
   * Anything not listed above is simply absent at runtime, since DefinePlugin
   * substitutes a fixed object.
   */
  readonly [key: string]: string | boolean | undefined;
}

/**
 * Vite's HMR handle. DefinePlugin substitutes `undefined`, so every
 * `if (import.meta.hot) { ... }` block in the copied stores is eliminated at
 * build time. The declaration is kept so those blocks still typecheck.
 *
 * Consequence: bolt's store state is no longer preserved across a hot reload in
 * development. That is a dev-time convenience, not behaviour — a reload simply
 * starts from a clean store.
 */
interface StudioImportMetaHot {
  /*
   * `any` deliberately, matching Vite's own typing of `hot.data`. The copied
   * stores use it to rehydrate typed values, e.g.
   *   `import.meta.hot?.data.files ?? new Map<string, string>()`
   * A stricter type such as Record<string, unknown> makes each of those 15 call
   * sites a type error, for no safety benefit on a value that is always
   * undefined here.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any;
  accept(cb?: (mod: unknown) => void): void;
  dispose(cb: () => void): void;
}

interface ImportMeta {
  readonly env: StudioImportMetaEnv;
  readonly hot?: StudioImportMetaHot;
}
