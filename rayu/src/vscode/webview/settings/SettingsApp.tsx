/**
 * The Rayucode Settings tab.
 *
 * Mounted by `index.tsx` when the page is the Settings tab (`data-app="settings"`), and
 * only then — `acquireVsCodeApi` may be called once per page, and the chat app calls it
 * when its own module loads.
 *
 * Same handshake as the chat: post `settingsReady` after the listener is attached, and
 * render whatever `settingsInit` brings. The open section is kept in the webview's own
 * state so a tab VS Code restores after a reload opens where it was.
 */
import { useCallback, useEffect, useMemo, useReducer } from 'react'

import {
  isSettingsSectionId,
  type AccountActionId,
  type AccountLinkId,
  type SettingsSectionId,
  type SettingsWebviewMessage,
  type WebBridgeAction,
} from '../../shared/settingsProtocol.js'
import { SettingsView } from './SettingsView.js'
import { asSettingsHostMessage, initialSettingsState, settingsReducer } from './settingsState.js'

declare function acquireVsCodeApi(): {
  postMessage: (message: SettingsWebviewMessage) => void
  getState: () => unknown
  setState: (state: unknown) => void
}

const vscodeApi = acquireVsCodeApi()

function restoredSection(): SettingsSectionId | undefined {
  const section = (vscodeApi.getState() as { section?: unknown } | undefined)?.section
  return isSettingsSectionId(section) ? section : undefined
}

export function SettingsApp(): JSX.Element {
  const [state, dispatch] = useReducer(settingsReducer, restoredSection(), initialSettingsState)

  useEffect(() => {
    document.body.classList.add('rs-page')
    const onMessage = (event: MessageEvent): void => {
      const message = asSettingsHostMessage(event.data)
      if (message) dispatch(message)
    }
    window.addEventListener('message', onMessage)
    vscodeApi.postMessage({ type: 'settingsReady' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    vscodeApi.setState({ section: state.section })
  }, [state.section])

  const select = useCallback((section: SettingsSectionId) => {
    dispatch({ type: 'select', section })
    vscodeApi.postMessage({ type: 'settingsSelectSection', section })
  }, [])

  const openExtensionSettings = useCallback(() => {
    vscodeApi.postMessage({ type: 'settingsOpenExtensionSettings' })
  }, [])

  const changeSetting = useCallback((key: string, value: boolean | string) => {
    vscodeApi.postMessage({ type: 'settingsUpdate', key, value })
  }, [])

  const retryGeneral = useCallback(() => {
    vscodeApi.postMessage({ type: 'settingsRefresh' })
  }, [])

  const refreshAccount = useCallback(() => {
    vscodeApi.postMessage({ type: 'settingsAccountRefresh' })
  }, [])

  const accountAction = useCallback((action: AccountActionId) => {
    vscodeApi.postMessage({ type: 'settingsAccountAction', action })
  }, [])

  const openAccountLink = useCallback((link: AccountLinkId) => {
    vscodeApi.postMessage({ type: 'settingsOpenAccountLink', link })
  }, [])

  const removeDevice = useCallback((deviceId: string) => {
    vscodeApi.postMessage({ type: 'settingsRemoveDevice', deviceId })
  }, [])

  const integrations = useMemo(() => ({
    onTelegramStartHosted: () => vscodeApi.postMessage({ type: 'settingsTelegramStartHosted' }),
    // The token is posted once and kept nowhere on this side (TelegramConnectPanel).
    onTelegramStartByo: (token: string) => vscodeApi.postMessage({ type: 'settingsTelegramStartByo', token }),
    onTelegramUnlink: () => vscodeApi.postMessage({ type: 'settingsTelegramUnlink' }),
    onWebBridge: (action: WebBridgeAction) => vscodeApi.postMessage({ type: 'settingsWebBridge', action }),
    onGitHubSetup: () => vscodeApi.postMessage({ type: 'settingsGitHubSetup' }),
  }), [])

  return (
    <SettingsView
      state={state}
      onSelect={select}
      onOpenExtensionSettings={openExtensionSettings}
      onChangeSetting={changeSetting}
      onRetryGeneral={retryGeneral}
      onAccountRefresh={refreshAccount}
      onAccountAction={accountAction}
      onOpenAccountLink={openAccountLink}
      onRemoveDevice={removeDevice}
      {...integrations}
    />
  )
}
