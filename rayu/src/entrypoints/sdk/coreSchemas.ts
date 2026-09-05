/**
 * Re-export shim. The SDK core wire schemas now live in
 * `@rayu-dev/agent-protocol`, which is the single source of truth for every
 * message crossing the engine's stdin/stdout (see WORKSPACE.md §4 and
 * PROTOCOL.md §2).
 *
 * The Rayucode VS Code extension imports the SAME package, so the engine and
 * the editor can no longer disagree about the wire format. Before this, the
 * extension carried a hand-written copy of these schemas and nothing verified
 * it — the root cause of the protocol-drift bug class (rayucode/TRIAGE.md).
 *
 * This file exists so every existing `entrypoints/sdk/coreSchemas.js` importer
 * under `rayu/src` keeps working unchanged. Import paths only — no logic here.
 */
export * from '@rayu-dev/agent-protocol'
