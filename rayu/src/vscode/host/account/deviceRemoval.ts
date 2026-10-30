/**
 * Removing a device from the account, from the Settings tab.
 *
 * The tab names a device by id; only a device from the list the host itself showed can
 * be removed, the user confirms in a native dialog (a webview cannot be trusted to have
 * asked), and the registry call goes out from the host with the account token. A device
 * that is still in use registers itself again the next time the CLI starts on it, so
 * the removal is a clean-up, not a lock-out.
 *
 * Free of `vscode` imports; the dialog and the registry call are injected.
 */
import type { DeviceView } from '../../shared/settingsProtocol.js'

export type DeviceRemoval = 'removed' | 'cancelled' | 'unknown' | 'failed'

export interface DeviceRemovalDeps {
  /** Ask the user; true to go ahead. */
  confirm(device: DeviceView): Promise<boolean>
  /** Remove it from the registry; true when Rayu accepted. */
  unregister(deviceId: string): Promise<boolean>
}

export async function removeDevice(
  deviceId: string,
  shown: readonly DeviceView[],
  deps: DeviceRemovalDeps,
): Promise<DeviceRemoval> {
  const device = shown.find(candidate => candidate.deviceId === deviceId)
  if (!device) return 'unknown'
  if (!(await deps.confirm(device))) return 'cancelled'
  return (await deps.unregister(device.deviceId)) ? 'removed' : 'failed'
}

/** The confirmation's text, naming the machine and what happens to it. */
export function removalPrompt(device: DeviceView): { message: string; detail: string } {
  return {
    message: `Remove ${device.name} from your Rayu devices?`,
    detail: device.thisMachine
      ? 'This is the machine you are using. It is added again the next time the Rayu CLI starts here.'
      : 'It stops appearing in Telegram and the Mini App. If Rayu is still installed there, it is added again the next time the CLI starts on it.',
  }
}
