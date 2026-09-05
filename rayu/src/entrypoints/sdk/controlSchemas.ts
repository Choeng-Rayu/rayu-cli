/**
 * Re-export shim. The SDK control-protocol schemas now live in
 * `@rayu-dev/agent-protocol` (see WORKSPACE.md §4 and PROTOCOL.md §2).
 *
 * This file exists so every existing `entrypoints/sdk/controlSchemas.js`
 * importer under `rayu/src` keeps working unchanged. Import paths only — no
 * logic here.
 */
export * from '@rayu-dev/agent-protocol'
