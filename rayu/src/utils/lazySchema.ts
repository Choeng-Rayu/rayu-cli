/**
 * Re-export shim. `lazySchema` now lives in `@rayu-dev/agent-protocol`, which
 * owns every wire schema (see WORKSPACE.md §4).
 *
 * This file exists so the ~40 modules under `rayu/src` that import
 * `utils/lazySchema.js` keep working unchanged. Import paths only — no logic
 * lives here.
 */
export { lazySchema } from '@rayu-dev/agent-protocol'
