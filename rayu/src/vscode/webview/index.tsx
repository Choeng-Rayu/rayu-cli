/**
 * Webview entry — mounts the React tree inside the panel.
 *
 * Bundled to `media/webview.js` with `target: 'browser'`. It must NOT reach the
 * wider `src/` tree: everything under `src/utils/`, `src/services/` and the engine
 * itself is Node code, and pulling any of it in here would either fail to bundle
 * or ship a Node shim into a browser. The only import that crosses the boundary is
 * the type-only `shared/webviewProtocol.js`.
 *
 * `createRoot` comes from `react-dom/client`. The CLI has no `react-dom` — it
 * renders through a custom Ink reconciler — so `react-dom` was added as a
 * dependency specifically for this bundle.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import './styles/copilot.css'

const container = document.getElementById('root')
if (!container) {
  // The host writes this element into the HTML it serves, so its absence means the
  // shell and this bundle disagree. Failing loudly beats an empty panel with no
  // explanation.
  throw new Error('[rayucode] #root is missing from the webview document')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
