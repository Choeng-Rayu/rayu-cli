/**
 * Settings → About: how Rayucode runs on this machine — which engine, which ripgrep,
 * and the per-conversation memory limit — with a way to the extension's own options.
 */
import type { EngineInfoView } from '../../shared/settingsProtocol.js'
import { SettingsItem } from './SettingsItem.js'

export interface AboutSectionProps {
  about: EngineInfoView
  onOpenExtensionSettings: () => void
}

export function engineLabel(about: EngineInfoView): string {
  if (about.runtime === 'native') {
    return about.source === 'override'
      ? 'Custom compiled engine (rayucode.engine.path)'
      : 'Compiled engine, bundled with Rayucode'
  }
  return about.source === 'override'
    ? 'Custom engine script on VS Code\'s Node (rayucode.engine.path)'
    : 'engine.mjs on VS Code\'s Node (universal package)'
}

export function ripgrepLabel(ripgrep: EngineInfoView['ripgrep']): string {
  switch (ripgrep.source) {
    case 'bundled':
      return 'Bundled with Rayucode'
    case 'vscode':
      return 'The ripgrep that ships with VS Code'
    case 'system':
      return 'Not bundled: Rayu uses an rg on your PATH, if there is one'
  }
}

export function memoryLimitLabel(limit: EngineInfoView['memoryLimit']): string {
  if (!limit) return 'No limit'
  const from = limit.source === 'setting'
    ? 'set by rayucode.engine.maxMemoryMB'
    : limit.source === 'environment'
      ? 'set by RAYU_ENGINE_MAX_OLD_SPACE_MB'
      : 'based on this machine\'s memory'
  return `${limit.mb.toLocaleString('en-US')} MB per conversation, ${from}`
}

export function AboutSection({ about, onOpenExtensionSettings }: AboutSectionProps): JSX.Element {
  return (
    <>
      <SettingsItem label="Extension" description="The Rayucode version and the platform it runs on.">
        <span className="rs-value">{about.extensionVersion} · {about.platform}</span>
      </SettingsItem>
      <SettingsItem label="Engine" description="What runs your conversations.">
        <span className="rs-value">{engineLabel(about)}</span>
        <code className="rs-path">{about.path}</code>
      </SettingsItem>
      <SettingsItem label="Search" description="The ripgrep binary Grep and Glob use.">
        <span className="rs-value">{ripgrepLabel(about.ripgrep)}</span>
        {about.ripgrep.path && <code className="rs-path">{about.ripgrep.path}</code>}
      </SettingsItem>
      <SettingsItem
        label="Memory limit"
        description="When a conversation's engine reaches it, the engine restarts and your next message continues the conversation."
      >
        <span className="rs-value">{memoryLimitLabel(about.memoryLimit)}</span>
      </SettingsItem>
      <div className="rs-actions">
        <button type="button" className="rs-button rs-button-secondary" onClick={onOpenExtensionSettings}>
          Open extension settings
        </button>
      </div>
    </>
  )
}
