import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export const call: LocalCommandCall = async args => {
  const trimmed = args.trim().toLowerCase()
  const config = getGlobalConfig()

  let newValue: boolean
  if (trimmed === 'on') {
    newValue = true
  } else if (trimmed === 'off') {
    newValue = false
  } else if (trimmed === '') {
    // No argument: toggle current state.
    newValue = !config.mascotBannerEnabled
  } else {
    return {
      type: 'text',
      value: `Usage: /banner [on|off]. Current state: ${
        config.mascotBannerEnabled ? 'on' : 'off'
      }`,
    }
  }

  saveGlobalConfig(current => ({
    ...current,
    mascotBannerEnabled: newValue,
  }))

  return {
    type: 'text',
    value: `Startup mascot banner turned ${newValue ? 'on' : 'off'}. Takes effect on next launch.`,
  }
}
