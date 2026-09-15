/**
 * Tool result renderer registry.
 *
 * Dispatches a `TranscriptEntry` (tool-related kinds) to the most specific
 * renderer available, falling back to the `DefaultRenderer` for unknown tools.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────────
 *
 * ```tsx
 * import { renderToolEntry } from './toolRenderers/index.js'
 *
 * // In a message renderer component:
 * const node = renderToolEntry(entry)
 * ```
 *
 * ── ADDING A NEW RENDERER ──────────────────────────────────────────────────────
 *
 * 1. Create `src/vscode/webview/toolRenderers/MyToolRenderer.tsx`
 * 2. Export a `ToolRenderer` object (see the interface below)
 * 3. Import and add it to `RENDERERS` — order matters: first match wins
 */
import React from 'react'
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'

/** A renderer for one or more tool-use entries. */
export interface ToolRenderer {
  /**
   * Returns `true` when this renderer should handle `entry`.
   *
   * Called in registry order; the first truthy return wins.
   */
  canRender: (entry: TranscriptEntry) => boolean
  /** Render the entry. Only called when `canRender` returned true. */
  render: (entry: TranscriptEntry) => React.ReactNode
}

// ── Lazy-loaded renderer modules ──────────────────────────────────────────────
// Keep these as string-keyed so the build tree-shakes unused ones.

import { BashRenderer } from './BashRenderer.js'
import { FileEditRenderer } from './FileEditRenderer.js'
import { GrepRenderer } from './GrepRenderer.js'
import { DefaultRenderer } from './DefaultRenderer.js'

/**
 * Registry of all known renderers, in priority order.
 *
 * First match wins.  `DefaultRenderer` must be last.
 */
const RENDERERS: ToolRenderer[] = [
  FileEditRenderer,
  BashRenderer,
  GrepRenderer,
  DefaultRenderer,
]

/**
 * Render a `TranscriptEntry` using the most specific matching renderer.
 *
 * Returns `null` for non-tool entries (prompt, assistant).
 */
export function renderToolEntry(entry: TranscriptEntry): React.ReactNode {
  if (entry.kind !== 'tool') return null
  const renderer = RENDERERS.find(r => r.canRender(entry))
  return renderer ? renderer.render(entry) : null
}

/**
 * Convenience hook: returns the renderer for `entry`, or `null`.
 *
 * Useful when the calling component needs to know WHICH renderer matched.
 */
export function findRenderer(entry: TranscriptEntry): ToolRenderer | null {
  return RENDERERS.find(r => r.canRender(entry)) ?? null
}
