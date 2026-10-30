/**
 * The Rayucode Settings editor tab — one per window, like VS Code's own Settings editor.
 *
 * Opened from the gear in the sidebar title bar, the command palette ("Rayucode: Open
 * Settings") or the chat's overflow menu, and restored after a window reload through a
 * serializer. The page is the same `webview.js` as the chat, mounted in its settings mode
 * (`renderWebviewHtml(..., { app: 'settings' })`), so it shares the chat's CSP exactly.
 */
import * as vscode from 'vscode'

import {
  isSettingsSectionId,
  type SettingsHostMessage,
  type SettingsSectionId,
} from '../../shared/settingsProtocol.js'
import { renderWebviewHtml } from '../panel/webviewSurface.js'
import type { SettingsController } from './settingsController.js'
import { dispatchSettingsMessage } from './settingsDispatch.js'

/** Stable `viewType` for the tab; also its serializer key and activation event. */
export const SETTINGS_VIEW_TYPE = 'rayucode.settings'

export class SettingsPanelHost {
  private panel: vscode.WebviewPanel | null = null
  private controller: SettingsController | null = null

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Wire the controller. Separate from construction because each needs the other. */
  bind(controller: SettingsController): void {
    this.controller = controller
  }

  /** Deliver a message to the open tab; nothing happens while it is closed. */
  post(message: SettingsHostMessage): void {
    void this.panel?.webview.postMessage(message)
  }

  /** Open the tab — or bring it forward — optionally at a section. */
  open(section?: SettingsSectionId): void {
    if (section) this.controller?.showSection(section)
    if (this.panel) {
      this.panel.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      SETTINGS_VIEW_TYPE,
      'Rayucode Settings',
      vscode.ViewColumn.Active,
      this.webviewOptions(),
    )
    this.attach(panel)
  }

  /** Re-attach a tab VS Code restored after a reload, at the section it was showing. */
  revive(panel: vscode.WebviewPanel, state: unknown): void {
    const section = (state as { section?: unknown } | undefined)?.section
    if (isSettingsSectionId(section)) this.controller?.selectSection(section)
    panel.webview.options = this.webviewOptions()
    this.attach(panel)
  }

  dispose(): void {
    this.panel?.dispose()
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      // Same rule as the chat surfaces: the page may read only the staged media/ files.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel
    // Coloured PNG, not the monochrome Activity Bar SVG — see surfaceRegistry.ts.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')
    panel.webview.html = renderWebviewHtml(panel.webview, this.extensionUri, { app: 'settings' })
    const messages = panel.webview.onDidReceiveMessage(message => {
      if (this.controller) dispatchSettingsMessage(message, this.controller)
    })
    panel.onDidDispose(() => {
      messages.dispose()
      if (this.panel === panel) this.panel = null
    })
  }
}

/** The command that opens the tab. An optional argument names the section. */
export const OPEN_SETTINGS_COMMAND = 'rayucode.openSettings'

export interface SettingsPanelSetup {
  host: SettingsPanelHost
  controller: SettingsController
}

/**
 * Create the Settings tab's host and controller and register what VS Code needs: the
 * open command and the serializer that restores the tab after a reload.
 */
export function registerSettingsPanel(
  context: vscode.ExtensionContext,
  createController: (post: (message: SettingsHostMessage) => void) => SettingsController,
): SettingsPanelSetup {
  const host = new SettingsPanelHost(context.extensionUri)
  const controller = createController(message => host.post(message))
  host.bind(controller)
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, (section?: unknown) => {
      host.open(isSettingsSectionId(section) ? section : undefined)
    }),
    vscode.window.registerWebviewPanelSerializer(SETTINGS_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => host.revive(panel, state),
    }),
    { dispose: () => host.dispose() },
  )
  return { host, controller }
}
