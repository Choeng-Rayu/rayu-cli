/**
 * The model palette.
 *
 * ── WHY THE PICKER LIVES IN THE HOST, NOT THE WEBVIEW ──────────────────────────
 *
 * The engine's `initialize` response carries the whole catalogue — measured at 712
 * entries against a real engine. Serialising that into the webview on every connect,
 * so React can render a list, would be a large `postMessage` for something opened
 * occasionally and read once.
 *
 * `vscode.window.showQuickPick` is also the better control: the same fuzzy-searchable
 * palette used everywhere else in the editor, keyboard-driven, and no CSS. So the
 * webview says "the user clicked the model pill" and the host owns the rest.
 *
 * Config access lives in `modelConfig.ts`, which has no `vscode` import so the session
 * can use it without dragging the editor API into every test.
 */
import * as vscode from 'vscode'

import { readActiveModel, type EngineModel } from './modelConfig.js'

/**
 * Let the user choose a model.
 *
 * Returns the chosen identifier, or null when the palette was dismissed. Does NOT send
 * `set_model` — persistence and the wire call stay together at one call site in the
 * session, so they cannot drift apart.
 */
export async function pickModel(
  catalogue: readonly EngineModel[],
): Promise<string | null> {
  const active = readActiveModel()

  if (catalogue.length === 0) {
    // The catalogue arrives with `initialize`, which happens on the first turn. Say so
    // rather than showing an empty palette, which reads as a broken control.
    void vscode.window.showInformationMessage(
      'Rayu has not reported a model catalogue yet. Send a message first, then try again.',
    )
    return null
  }

  const items: Array<vscode.QuickPickItem & { value: string }> = catalogue.map(m => ({
    value: m.value,
    label: m.displayName || m.value,
    description: m.value === active.model ? '$(check) current' : undefined,
    detail: m.description || undefined,
  }))

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Rayu: select a model',
    placeHolder: active.model ? `Current: ${active.model}` : 'Choose a model',
    matchOnDescription: true,
    matchOnDetail: true,
  })

  return choice?.value ?? null
}
