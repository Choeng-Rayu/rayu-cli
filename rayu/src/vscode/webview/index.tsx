/**
 * Webview entry — mounts the React tree inside the panel.
 *
 * Bundled to `media/webview.js` with `target: 'browser'`. It must NOT reach the
 * wider `src/` tree: everything under `src/utils/`, `src/services/` and the engine
 * itself is Node code, and pulling any of it in here would either fail to bundle
 * or ship a Node shim into a browser. The only imports that cross the boundary are
 * the dependency-free `shared/` protocol modules.
 *
 * `createRoot` comes from `react-dom/client`. The CLI has no `react-dom` — it
 * renders through a custom Ink reconciler — so `react-dom` was added as a
 * dependency specifically for this bundle.
 *
 * ONE BUNDLE, TWO APPS. The page says which it is (`data-app` on #root, written by
 * `renderWebviewHtml`): the chat (sidebar and session tabs) or the Settings tab. Each is
 * imported only when it is the one mounting, because each calls `acquireVsCodeApi()` when
 * its module loads and VS Code allows one call per page.
 */
import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/copilot.css'
import './styles/settings.css'

const container = document.getElementById('root')
if (!container) {
  // The host writes this element into the HTML it serves, so its absence means the
  // shell and this bundle disagree. Failing loudly beats an empty panel with no
  // explanation.
  throw new Error('[rayucode] #root is missing from the webview document')
}
const root = container

function mount(Component: ComponentType): void {
  createRoot(root).render(
    <StrictMode>
      <Component />
    </StrictMode>,
  )
}

if (root.dataset.app === 'settings') {
  void import('./settings/SettingsApp.js').then(({ SettingsApp }) => mount(SettingsApp))
} else {
  void import('./App.js').then(({ App }) => mount(App))
}
