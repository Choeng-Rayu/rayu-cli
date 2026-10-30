/**
 * The Rayu credits item in VS Code's status bar. Clicking it opens Settings → Account.
 *
 * Drawing only; what it says and when it refreshes are `creditsStatus.ts`.
 */
import * as vscode from 'vscode'

import { OPEN_SETTINGS_COMMAND } from '../settings/settingsPanel.js'
import {
  CREDITS_REFRESH_PERIOD_MS,
  CreditsStatus,
  type CreditsStatusDeps,
} from './creditsStatus.js'

export const CREDITS_STATUS_ID = 'rayucode.credits'

export function registerCreditsStatusBar(
  context: vscode.ExtensionContext,
  deps: Pick<CreditsStatusDeps, 'enabled' | 'fetch'>,
): CreditsStatus {
  const item = vscode.window.createStatusBarItem(CREDITS_STATUS_ID, vscode.StatusBarAlignment.Right, 100)
  item.name = 'Rayu Credits'
  item.command = { title: 'Open Rayu Account', command: OPEN_SETTINGS_COMMAND, arguments: ['account'] }

  const status = new CreditsStatus({
    ...deps,
    now: Date.now,
    render: view => {
      if (!view) {
        item.hide()
        return
      }
      item.text = view.text
      item.tooltip = view.tooltip
      item.accessibilityInformation = { label: view.tooltip.split('\n').slice(0, 2).join(', ') }
      // Only the warning and error colours are allowed here; the warning one fits a limit.
      item.backgroundColor = view.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
      item.show()
    },
  })

  const timer = setInterval(() => void status.refresh(), CREDITS_REFRESH_PERIOD_MS)
  timer.unref?.()
  context.subscriptions.push(
    item,
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) void status.refresh()
    }),
  )
  void status.refresh({ force: true })
  return status
}
