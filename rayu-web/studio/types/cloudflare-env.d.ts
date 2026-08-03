/*
 * `Env` was Cloudflare Workers' generated bindings interface, provided in
 * bolt.diy by `@cloudflare/workers-types` and `wrangler types`. Rayu Studio does
 * not run on Workers, so neither package is a dependency.
 *
 * Two methods in the provider catalog still take it in their signature —
 * BaseProvider.convertEnvToRecord() and OllamaProvider.getDefaultNumCtx() — so
 * the name is declared here as a plain string map. That keeps those files
 * diffable against upstream bolt instead of changing their signatures.
 *
 * Callers in the studio pass nothing (there is no server environment to forward
 * from the browser), so both methods take their `undefined` branch.
 */
declare global {
  type Env = Record<string, string | undefined>;
}

export {};
